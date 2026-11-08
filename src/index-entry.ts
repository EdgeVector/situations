import { coordinateId, opKey, WRITE_BATCH_LIMIT } from "./native-records.ts";
// Keyed index entries over the `IndexEntry` and `NoticeHistory` HashRange
// schemas (see schemas.ts for the partition list and the entry shape).
//
// A list is a partition: one small record per entry, read with one range query
// under the partition hash, grown with one small write. No code rewrites or
// caps a whole list, and no entry is dropped to fit.
//
// The database owns conflicts (several devices may write at once; per field the
// newer stamp wins and every write is kept), the app owns the data shape. So:
// one record per entry, keys two devices never create by accident, an entry is
// rewritten whole by the code that owns it, and no code reads-modifies-writes a
// shared list. A write touches only the entry of the record it is writing.

import {
  FsituationsError,
  type BatchMutationOp,
  type NodeClient,
  type QueryRow,
} from "./client.ts";
import { fieldValueBytes } from "./field-value-size.ts";
import type { Config } from "./config.ts";
import { resolveLoadedLayoutHashes } from "./init-schema.ts";
import {
  INDEX_ENTRY_MARKER,
  INDEX_ENTRY_MAX_BYTES,
  NOTICE_HISTORY_MARKER,
} from "./schemas.ts";

/** Most ops in one `/api/mutations/batch` request. */
const BATCH_MAX_OPS = WRITE_BATCH_LIMIT;
/** Partitions (range queries) in flight at once. */
const READ_CONCURRENCY = 8;
/** Keys per multi-get: the node's default page size, so one call is one page. */
const HYDRATE_BATCH_KEYS = 100;
const HYDRATE_CONCURRENCY = 4;
const HYDRATE_POINT_CONCURRENCY = 8;
/** Entries per page of a partition read. */
const PARTITION_PAGE_SIZE = 500;

export function unreadable(where: string, why: string): FsituationsError {
  return new FsituationsError({
    code: "index_entry_unreadable",
    message: `Index entry ${where} cannot be read: ${why}.`,
    hint: "An index entry that cannot be read is a record this command cannot account for, so it stops instead of skipping it. Run `situations doctor`.",
  });
}

// ---------------------------------------------------------------------------
// Stores: the two entry schemas
// ---------------------------------------------------------------------------

/**
 * `entry` = IndexEntry (no TTL, entry key = id). `notice` = NoticeHistory (the
 * TTL-ready log). `long` = IndexEntry, entry key `<20-digit seconds>#<slug>`
 * (the long-lived notices; no TTL).
 */
export type StoreKind = "entry" | "notice" | "long";

type StoreDef = {
  configKey: string;
  fields: { h: string; r: string; payload: string; marker: string };
  markerToken: string;
  /** The entry id (a slug or a day) a range key carries. */
  idOf(range: string): string;
};

/** Year 2286 as unix seconds: a range key a TTL will never reach. */
export const FAR_FUTURE_SECONDS = 9_999_999_999;
const SECONDS_DIGITS = 20;

/**
 * Unix seconds zero-padded to the 20 digits a node TTL reads from the front of a
 * range key. A negative or non-finite time THROWS: clamped to 0 it would be the
 * oldest key there is, and a TTL would delete the entry at once.
 */
export function padSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new FsituationsError({
      code: "invalid_entry_time",
      message: `Cannot key an index entry by the time ${seconds}: it is not a unix time at or after 1970.`,
      hint: "A notice needs a real `created_at` and `expires_at`; fix the timestamp and retry.",
    });
  }
  return String(Math.floor(seconds)).padStart(SECONDS_DIGITS, "0");
}

/** The NoticeHistory range key: `<20-digit unix seconds of created_at>#<slug>`. */
export function noticeRange(createdAtMs: number, slug: string): string {
  return `${padSeconds(createdAtMs / 1000)}#${slug}`;
}

const STORES: Record<StoreKind, StoreDef> = {
  entry: {
    configKey: "index_entry",
    fields: { h: "ie_h", r: "ie_r", payload: "ie_payload", marker: "ie_marker" },
    markerToken: INDEX_ENTRY_MARKER,
    idOf: (range) => range,
  },
  notice: {
    configKey: "notice_history",
    fields: { h: "nh_h", r: "nh_r", payload: "nh_payload", marker: "nh_marker" },
    markerToken: NOTICE_HISTORY_MARKER,
    idOf: (range) => {
      const at = range.indexOf("#");
      return at >= 0 ? range.slice(at + 1) : range;
    },
  },
  long: {
    configKey: "index_entry",
    fields: { h: "ie_h", r: "ie_r", payload: "ie_payload", marker: "ie_marker" },
    markerToken: INDEX_ENTRY_MARKER,
    idOf: (range) => {
      const at = range.indexOf("#");
      return at >= 0 ? range.slice(at + 1) : range;
    },
  },
};

/** The two schema hashes the entry layout needs. */
export type Layout = { entry: string; notice: string };

function schemaOf(layout: Layout, store: StoreKind): string {
  return store === "notice" ? layout.notice : layout.entry;
}

const layoutMemo = new WeakMap<object, Promise<Layout | null>>();

/**
 * The entry layout, or null when the node does not have both schemas.
 *
 * A config pin wins, and with BOTH pins set the node is not asked at all. With a
 * pin missing the node's loaded schemas are used (`GET /api/schemas`, one call
 * per run), so a config that cannot be written (a read-only home) still reaches
 * the entries. Never declares.
 */
export function resolveLayout(node: NodeClient, cfg: Config): Promise<Layout | null> {
  let pending = layoutMemo.get(cfg);
  if (!pending) {
    pending = (async () => {
      const pinnedEntry = cfg.schemaHashes[STORES.entry.configKey];
      const pinnedNotice = cfg.schemaHashes[STORES.notice.configKey];
      // Both pins set: no schema-list call. `GET /api/schemas` lists every schema
      // the node has, and a preflight runs before every automation action, so a
      // pinned config must not pay for it (and must not fail closed because a
      // slow node was slow to list them).
      if (pinnedEntry && pinnedNotice) {
        return { entry: pinnedEntry, notice: pinnedNotice };
      }
      const loaded = await resolveLoadedLayoutHashes(node);
      const entry = pinnedEntry || loaded.index_entry;
      const notice = pinnedNotice || loaded.notice_history;
      return entry && notice ? { entry, notice } : null;
    })();
    layoutMemo.set(cfg, pending);
  }
  return pending;
}

/** The layout for a read or a write. Missing schemas fail closed: an empty answer would skip the gate. */
export async function requireLayout(node: NodeClient, cfg: Config): Promise<Layout> {
  const layout = await resolveLayout(node, cfg);
  if (layout) return layout;
  throw new FsituationsError({
    code: "index_layout_missing",
    message:
      "`situations init` has not been run on this node (IndexEntry and NoticeHistory are not loaded): run `situations init`, then retry.",
    hint: "A command never declares a schema itself, so it fails before it reads or writes anything.",
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `limit` calls of `fn` at a time; results keep the order of `items`. */
export async function mapLimit<I, O>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as I, i);
    }
  });
  await Promise.all(workers);
  return out;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC day (`YYYY-MM-DD`) of an RFC 3339 time, or null when it does not parse. */
export function dayOf(iso: string): string | null {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : null;
}

/** Valid, unique days, newest first. */
export function normalizeHistoryDays(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const day = String(item ?? "").trim();
    if (DAY_RE.test(day)) out.add(day);
  }
  return [...out].sort((a, b) => b.localeCompare(a));
}

// ---------------------------------------------------------------------------
// Partitions
// ---------------------------------------------------------------------------

/** One entry: `id` is a slug or a day; `range` is the stored key (the id for an `entry` store). */
export type Entry<T> = { id: string; range: string; payload: T };

export type PartitionSpec<T> = {
  store: StoreKind;
  /** Partition hash, e.g. `notice_history_day:2026-10-12`. */
  hash: string;
  /** Read only the entries whose range key is in [start, end] (an ordered range read), not the whole partition. */
  range?: { start: string; end: string };
  /** One stored payload (parsed JSON, or "" for none) as a typed entry payload. Throws when unreadable. */
  coerce(stored: unknown, id: string): T;
};

export function putOp(
  layout: Layout,
  store: StoreKind,
  hash: string,
  range: string,
  payload: unknown,
): BatchMutationOp {
  const def = STORES[store];
  const serialized = payload === "" || payload === null ? "" : JSON.stringify(payload);
  if (fieldValueBytes(serialized) > INDEX_ENTRY_MAX_BYTES) {
    throw new FsituationsError({
      code: "index_entry_too_large",
      message: `Index entry ${hash}/${range} is ${fieldValueBytes(serialized)} bytes; the limit is ${INDEX_ENTRY_MAX_BYTES}.`,
      hint: "An entry carries keys and small summary fields only; hydrate the rest from the record.",
    });
  }
  return {
    mutationType: "update",
    schemaHash: schemaOf(layout, store),
    keyHash: hash,
    keyRange: range,
    fields: {
      [def.fields.h]: hash,
      [def.fields.r]: range,
      [def.fields.payload]: serialized,
      [def.fields.marker]: def.markerToken,
    },
  };
}

export function deleteOp(
  layout: Layout,
  store: StoreKind,
  hash: string,
  range: string,
): BatchMutationOp {
  return {
    mutationType: "delete",
    schemaHash: schemaOf(layout, store),
    keyHash: hash,
    keyRange: range,
    fields: {},
  };
}

/**
 * Send `ops` as one batch request per `BATCH_MAX_OPS`. Empty input sends
 * nothing. Two ops on one key collapse to the last one.
 */
export async function commitOps(node: NodeClient, ops: BatchMutationOp[], atomic = false): Promise<void> {
  const last = new Map<string, BatchMutationOp>();
  for (const op of ops) last.set(coordinateId(op.schemaHash, opKey(op)), op);
  const unique = [...last.values()];
  if (atomic) {
    if (unique.length > WRITE_BATCH_LIMIT) {
      throw new Error("The related update is too large to commit atomically.");
    }
    await node.mutateBatch(unique);
    return;
  }
  for (let i = 0; i < unique.length; i += BATCH_MAX_OPS) {
    await node.mutateBatch(unique.slice(i, i + BATCH_MAX_OPS));
  }
}

function rangeOf(row: QueryRow, field: string): string | null {
  const range = row.key?.range ?? row.fields[field];
  return typeof range === "string" && range.length > 0 ? range : null;
}

/** A stored payload as JSON. Empty is "". Text that is not JSON throws. */
function parseStored(raw: unknown, where: string): unknown {
  if (typeof raw !== "string" || raw.length === 0) return "";
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw unreadable(where, `its payload is not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function readRows(
  node: NodeClient,
  layout: Layout,
  store: StoreKind,
  hash: string,
  range?: { start: string; end: string },
): Promise<Array<{ range: string; stored: unknown }>> {
  const def = STORES[store];
  const res = await node.queryAll({
    schemaHash: schemaOf(layout, store),
    fields: [def.fields.r, def.fields.payload],
    filter: range ? { HashRangeRange: { hash, start: range.start, end: range.end } } : { HashKey: hash },
    pageSize: PARTITION_PAGE_SIZE,
  });
  const out: Array<{ range: string; stored: unknown }> = [];
  for (const row of res.results) {
    // The filter is an exact hash match; keep the check so a node that ever
    // widens it cannot leak another partition's entries into this one.
    if (row.key?.hash != null && row.key.hash !== hash) continue;
    const r = rangeOf(row, def.fields.r);
    if (r === null) continue;
    out.push({ range: r, stored: parseStored(row.fields[def.fields.payload], `${hash}/${r}`) });
  }
  return out;
}

/** Point read: does this one key exist? */
export async function entryExists(
  node: NodeClient,
  layout: Layout,
  store: StoreKind,
  hash: string,
  range: string,
): Promise<boolean> {
  const res = await node.queryAll({
    schemaHash: schemaOf(layout, store),
    fields: [STORES[store].fields.r],
    filter: { HashRangeKey: { hash, range } },
  });
  return res.results.length > 0;
}

// ---------------------------------------------------------------------------
// Reading a partition
// ---------------------------------------------------------------------------

export type PartitionState<T> = {
  entries: Array<Entry<T>>;
};

/** One partition: one range query. Every row is an entry. An unreadable row throws. */
export async function loadPartition<T>(
  node: NodeClient,
  layout: Layout,
  spec: PartitionSpec<T>,
): Promise<PartitionState<T>> {
  const rows = await readRows(node, layout, spec.store, spec.hash, spec.range);
  const entries: Array<Entry<T>> = [];
  for (const row of rows) {
    const id = STORES[spec.store].idOf(row.range);
    entries.push({ id, range: row.range, payload: spec.coerce(row.stored, id) });
  }
  return { entries };
}

/** Read several partitions in parallel, `READ_CONCURRENCY` at a time. */
export async function readPartitions<T>(
  node: NodeClient,
  layout: Layout,
  specs: ReadonlyArray<PartitionSpec<T>>,
): Promise<Array<PartitionState<T>>> {
  return mapLimit(specs, READ_CONCURRENCY, (spec) => loadPartition(node, layout, spec));
}

/** The partition of days that hold history (`notice_history_days`, `situation_history_days`). */
export function daysPartition(hash: string): PartitionSpec<string> {
  return {
    store: "entry",
    hash,
    coerce: () => "",
  };
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

function isUnsupportedFilter(err: unknown): boolean {
  if (!(err instanceof FsituationsError)) return false;
  // A node that predates the multi-get answers HTTP 400 `invalid_value` ("a key
  // was present with a value outside its grammar"); the code carries the node's
  // error text, the message carries the raw body.
  return (
    err.code === "http_400" ||
    /grammar|invalid_value|unknown filter|unrecognized filter|invalid filter|unsupported/i.test(
      `${err.code} ${err.message}`,
    )
  );
}

/**
 * The records for `slugs` from one Hash-keyed product schema: one multi-get
 * (`HashRangeKeys`) per `HYDRATE_BATCH_KEYS`, never one call per record. A node
 * that rejects the filter falls back to bounded-parallel point reads. A slug the
 * multi-get missed is point-read once more: `/api/query` can null a real row out
 * of a page under load, and a missing record is worth one retry. The caller
 * decides what a slug that is STILL missing means (`requireAll`).
 */
export async function hydrateBySlug<T>(
  node: NodeClient,
  opts: {
    schemaHash: string;
    fields: string[];
    slugs: readonly string[];
    toItem(row: QueryRow): T;
  },
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const unique = [...new Set(opts.slugs)];
  const collect = (rows: QueryRow[]): void => {
    for (const row of rows) {
      const slug = row.key?.hash ?? (typeof row.fields.slug === "string" ? row.fields.slug : null);
      if (slug) out.set(slug, opts.toItem(row));
    }
  };
  const pointRead = async (slug: string): Promise<void> => {
    const res = await node.queryAll({
      schemaHash: opts.schemaHash,
      fields: opts.fields,
      filter: { HashKey: slug },
    });
    collect(res.results);
  };

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += HYDRATE_BATCH_KEYS) {
    chunks.push(unique.slice(i, i + HYDRATE_BATCH_KEYS));
  }
  try {
    await mapLimit(chunks, HYDRATE_CONCURRENCY, async (chunk) => {
      const res = await node.queryAll({
        schemaHash: opts.schemaHash,
        fields: opts.fields,
        filter: { HashRangeKeys: chunk.map((slug) => [slug, ""]) },
      });
      collect(res.results);
    });
  } catch (err) {
    if (!isUnsupportedFilter(err)) throw err;
    await mapLimit(
      unique.filter((slug) => !out.has(slug)),
      HYDRATE_POINT_CONCURRENCY,
      pointRead,
    );
  }
  const missed = unique.filter((slug) => !out.has(slug));
  if (missed.length > 0) await mapLimit(missed, HYDRATE_POINT_CONCURRENCY, pointRead);
  return out;
}

/**
 * Throw when an entry points at no record. A skipped entry is a skipped hold.
 * `fix` is the exact command that removes the entry.
 */
export function requireAll<T>(
  found: Map<string, T>,
  slugs: readonly string[],
  what: string,
  fix: (slug: string) => string,
): void {
  const missing = [...new Set(slugs)].filter((slug) => !found.has(slug));
  if (missing.length === 0) return;
  throw new FsituationsError({
    code: "index_entry_dangling",
    message:
      `${missing.length} ${what} index entr${missing.length === 1 ? "y points" : "ies point"} at no record ` +
      `(first: ${missing[0]}).`,
    hint: `The command stops instead of skipping an entry it cannot account for. To remove the entry: ${fix(missing[0]!)}`,
  });
}
