// Keyed index entries over the `IndexEntry` and `NoticeHistory` HashRange
// schemas (see schemas.ts for the partition list and the entry shape).
//
// Why this exists. The `Index` schema kept each list as ONE JSON blob in one
// field: every notice of a day, every situation of a day, the set of active
// situations. One field value is one atom, and the node refuses an atom above
// its ceiling. The day buckets measured 66 to 161 KB on the primary and grew by
// 40 KB in a day, so each notice rewrote a whole blob. Here a list is a
// PARTITION: one small record per entry, read with one range query under the
// partition hash, grown with one small write. No code rewrites or caps a whole
// list, and no entry is dropped to fit.
//
// The database owns conflicts (several devices may write at once; per atom the
// last writer wins and every write is kept), the app owns the data shape. So:
// one record per entry, keys two devices never create by accident, an entry is
// rewritten whole by the code that owns it, and no code reads-modifies-writes a
// shared list. A write touches only the entry of the record it is writing.
//
// Migration (dual read, per partition, nothing deleted). The legacy `Index`
// blob of each partition is READ and copied into the partition with ONE batch
// that ends with marker records (`__migrated__.<k>`): when it was copied
// (`migrated_at`) and the ids it contained. Four rules make that safe:
//
//   1. A marker is written only after a legacy row with at least one entry was
//      really copied. A partition with no legacy row is never marked: a missed
//      read (`/api/query` can null a real row under load) looks exactly like no
//      row, and a marker written on a miss would make every later reader ignore
//      the blob forever. An unmarked partition re-checks the legacy row on each
//      read (one point read).
//   2. A reader trusts a marker only for the ids it lists, and only when every
//      chunk is present. A listed id with no entry yet (a device synced the
//      marker before the entries) is served from the legacy blob and hydrated
//      from its record.
//   3. For a gate partition (`checkDrift`), a legacy `updated_at` NEWER than the
//      marker's `migrated_at` means an old binary wrote the blob after the
//      migration. The partition is treated as unmigrated again: the blob is
//      merged in (hydrated from the records) and the marker is rewritten.
//   4. An entry that cannot be parsed, or that points at no record, THROWS.
//      Preflight is the fleet's gate and fails closed; a skipped entry is a
//      skipped hold. (A listed id with no entry and no record is simply gone.)
//   5. An entry written by a migration or a drift repair is UNTRUSTED: it is a
//      snapshot from a blob an older binary may have written, and a stale
//      process can write it with a LATER write time than a newer entry, so it
//      wins. A reader decides liveness for an untrusted entry from the RECORD,
//      never from the entry. A migration writes only ids that are absent, and
//      never rewrites an entry that already exists.

import {
  FsituationsError,
  type BatchMutationOp,
  type NodeClient,
  type QueryRow,
} from "./client.ts";
import { atomBytes } from "./atom-size.ts";
import type { Config } from "./config.ts";
import { readLegacyRow, readLegacyUpdatedAt } from "./index-cache.ts";
import { resolveLoadedLayoutHashes } from "./init-schema.ts";
import {
  INDEX_ENTRY_MARKER,
  INDEX_ENTRY_MAX_BYTES,
  INDEX_ENTRY_MIGRATED_PREFIX,
  NOTICE_HISTORY_MARKER,
} from "./schemas.ts";

/** Most ops in one `/api/mutations/batch` request. A migration above this splits. */
const BATCH_MAX_OPS = 200;
/** Partitions (range queries) in flight at once. */
const READ_CONCURRENCY = 8;
/** Keys per multi-get: the node's default page size, so one call is one page. */
const HYDRATE_BATCH_KEYS = 100;
const HYDRATE_CONCURRENCY = 4;
const HYDRATE_POINT_CONCURRENCY = 8;
/** Entries per page of a partition read. */
const PARTITION_PAGE_SIZE = 500;
/** One marker chunk stays well inside the entry budget. */
const MARKER_CHUNK_BYTES = 3 * 1024;

/** One line on stderr. Never stdout: `--json` callers parse stdout. */
export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

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
  /** Range key of marker chunk `k`. */
  markerRange(chunk: number): string;
  /** The entry id (a slug or a day) a range key carries. */
  idOf(range: string): string;
};

/** Year 2286 as unix seconds: a marker key a TTL will never reach. */
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
    markerRange: (chunk) => `${INDEX_ENTRY_MIGRATED_PREFIX}${chunk}`,
    idOf: (range) => range,
  },
  notice: {
    configKey: "notice_history",
    fields: { h: "nh_h", r: "nh_r", payload: "nh_payload", marker: "nh_marker" },
    markerToken: NOTICE_HISTORY_MARKER,
    markerRange: (chunk) => `${padSeconds(FAR_FUTURE_SECONDS)}#${INDEX_ENTRY_MIGRATED_PREFIX}${chunk}`,
    idOf: (range) => {
      const at = range.indexOf("#");
      return at >= 0 ? range.slice(at + 1) : range;
    },
  },
  long: {
    configKey: "index_entry",
    fields: { h: "ie_h", r: "ie_r", payload: "ie_payload", marker: "ie_marker" },
    markerToken: INDEX_ENTRY_MARKER,
    markerRange: (chunk) => `${padSeconds(FAR_FUTURE_SECONDS)}#${INDEX_ENTRY_MIGRATED_PREFIX}${chunk}`,
    idOf: (range) => {
      const at = range.indexOf("#");
      return at >= 0 ? range.slice(at + 1) : range;
    },
  },
};

function isMarkerRange(store: StoreKind, range: string): boolean {
  return STORES[store].idOf(range).startsWith(INDEX_ENTRY_MIGRATED_PREFIX);
}

/** The two schema hashes the entry layout needs. */
export type Layout = { entry: string; notice: string };

function schemaOf(layout: Layout, store: StoreKind): string {
  return store === "notice" ? layout.notice : layout.entry;
}

type LayoutInfo = {
  layout: Layout | null;
  /** The node reports the legacy `Index` schema as loaded. */
  indexLoaded: boolean;
};

const layoutMemo = new WeakMap<object, Promise<LayoutInfo>>();

/**
 * The entry layout, or null when the node does not have both schemas, and
 * whether the node reports the legacy `Index` schema as loaded.
 *
 * A config pin wins. With no pin the node's loaded schemas are used
 * (`GET /api/schemas`), so a config that cannot be written (a read-only home)
 * still reaches the entries: a writer that landed an entry must not leave a
 * reader looking at the frozen legacy blob. Never declares.
 */
export function resolveLayoutInfo(node: NodeClient, cfg: Config): Promise<LayoutInfo> {
  let pending = layoutMemo.get(cfg);
  if (!pending) {
    pending = (async () => {
      const loaded = await resolveLoadedLayoutHashes(node);
      const pinnedEntry = cfg.schemaHashes[STORES.entry.configKey];
      const pinnedNotice = cfg.schemaHashes[STORES.notice.configKey];
      const entry = pinnedEntry || loaded.index_entry;
      const notice = pinnedNotice || loaded.notice_history;
      return {
        layout: entry && notice ? { entry, notice } : null,
        indexLoaded: loaded.index !== null,
      };
    })();
    layoutMemo.set(cfg, pending);
  }
  return pending;
}

export async function resolveLayout(node: NodeClient, cfg: Config): Promise<Layout | null> {
  return (await resolveLayoutInfo(node, cfg)).layout;
}

/** The layout for a WRITE. A write without it fails: it would land a record no entry points at. */
export async function requireLayout(node: NodeClient, cfg: Config): Promise<Layout> {
  const layout = await resolveLayout(node, cfg);
  if (layout) return layout;
  throw new FsituationsError({
    code: "index_layout_missing",
    message:
      "`situations init` has not been run on this node (IndexEntry and NoticeHistory are not loaded): run `situations init`, then retry.",
    hint: "A write never declares a schema itself, so it fails before it writes anything; reads keep using the legacy blobs until init has run.",
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

/** A legacy blob as a list: null is no entries; anything but a list is unreadable. */
export function legacyList(legacy: unknown, key: string): unknown[] {
  if (legacy === null || legacy === undefined) return [];
  if (!Array.isArray(legacy)) throw unreadable(`legacy Index row "${key}"`, "it is not a list");
  return legacy;
}

// ---------------------------------------------------------------------------
// Partitions
// ---------------------------------------------------------------------------

/** One entry: `id` is a slug or a day; `range` is the stored key (the id for an `entry` store). */
export type EntryDraft<T> = { id: string; range: string; payload: T };
export type Entry<T> = EntryDraft<T> & {
  /**
   * Not stored: served from a legacy blob for an id the marker lists. Its payload
   * is a stale snapshot, so a reader reads the record, and a record that is gone
   * means the id is gone (resolved, expired), not an error.
   */
  fromLegacy?: true;
  /**
   * Stored, but a legacy blob holds a NEWER version of it (an older binary wrote
   * after the copy). A reader decides from the record.
   */
  decideFromRecord?: true;
};

export type PartitionSpec<T> = {
  store: StoreKind;
  /** Partition hash, e.g. `notice_history_day:2026-10-12`. */
  hash: string;
  /** Legacy `Index` key that held this partition as one blob, or null when none can exist. */
  legacyKey: string | null;
  /** Gate partition: an old binary writing the blob after the migration is noticed. */
  checkDrift: boolean;
  /**
   * A marker lists an id that has no entry: serve it from the legacy blob (and
   * the record). False for a log that a TTL may empty: a missing entry there is
   * an expired one, and re-reading the blob would bring it back.
   */
  fillMissing: boolean;
  /** Read only the entries whose range key is in [start, end] (an ordered range read), not the whole partition. */
  range?: { start: string; end: string };
  /** The entries a legacy blob stands for. Throws on an item that is not an entry. */
  fromLegacy(legacy: unknown): Array<EntryDraft<T>>;
  /** One stored payload (parsed JSON, or "" for none) as a typed entry payload. Throws when unreadable. */
  coerce(stored: unknown, id: string): T;
  /**
   * What a migration or a repair writes for a legacy snapshot: an UNTRUSTED
   * entry (no copy of the record, flagged), decided from the record by readers.
   */
  untrusted?(payload: T): T;
  /** A comparable version of a payload (an ISO time). A blob snapshot newer than a TRUSTED stored entry is contested. */
  version?(payload: T): string;
  /** A stored payload that is already decided from the record (an untrusted copy); it cannot be stale in a way that matters. */
  isUntrusted?(payload: T): boolean;
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
  if (atomBytes(serialized) > INDEX_ENTRY_MAX_BYTES) {
    throw new FsituationsError({
      code: "index_entry_too_large",
      message: `Index entry ${hash}/${range} is ${atomBytes(serialized)} bytes; the limit is ${INDEX_ENTRY_MAX_BYTES}.`,
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
 * nothing. Two ops on one key collapse to the LAST one, so a legacy copy never
 * races the fresh write for the same entry inside one batch.
 */
export async function commitOps(node: NodeClient, ops: BatchMutationOp[]): Promise<void> {
  const last = new Map<string, BatchMutationOp>();
  for (const op of ops) last.set(`${op.schemaHash}\0${op.keyHash}\0${op.keyRange ?? ""}`, op);
  const unique = [...last.values()];
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
// Migration markers
// ---------------------------------------------------------------------------

type MarkerChunk = { migrated_at: string; chunk: number; of: number; ids: string[] };

export type Marker = {
  /** Every chunk is present. Only then may a reader trust `ids`. */
  complete: boolean;
  /** Ids the marker lists (the legacy entries that were copied). */
  ids: Set<string>;
  /** When the newest copy was made, or null with no marker. */
  migratedAt: string | null;
  /** Range keys of the chunks that exist. */
  ranges: string[];
};

const NO_MARKER: Marker = { complete: false, ids: new Set(), migratedAt: null, ranges: [] };

function asChunk(raw: unknown, where: string): MarkerChunk {
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (
    !o ||
    typeof o.migrated_at !== "string" ||
    !Number.isInteger(o.chunk) ||
    !Number.isInteger(o.of) ||
    !Array.isArray(o.ids) ||
    !o.ids.every((id) => typeof id === "string")
  ) {
    throw unreadable(where, "it is not a migration marker chunk");
  }
  return o as unknown as MarkerChunk;
}

function parseMarker(parts: Array<{ range: string; stored: unknown }>, hash: string): Marker {
  if (parts.length === 0) return NO_MARKER;
  const byChunk = new Map<number, MarkerChunk>();
  let of = 0;
  let migratedAt = "";
  const ids = new Set<string>();
  for (const part of parts) {
    const chunk = asChunk(part.stored, `${hash}/${part.range}`);
    byChunk.set(chunk.chunk, chunk);
    of = Math.max(of, chunk.of);
    if (chunk.migrated_at > migratedAt) migratedAt = chunk.migrated_at;
    for (const id of chunk.ids) ids.add(id);
  }
  const complete = of > 0 && Array.from({ length: of }, (_, k) => byChunk.has(k)).every(Boolean);
  return { complete, ids, migratedAt: migratedAt || null, ranges: parts.map((p) => p.range) };
}

/** The marker records that stand for `ids`, chunked to stay inside the entry budget. */
function markerOps(
  layout: Layout,
  store: StoreKind,
  hash: string,
  ids: readonly string[],
  migratedAt: string,
  existing: readonly string[],
): BatchMutationOp[] {
  const def = STORES[store];
  const sorted = [...ids].sort();
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const id of sorted) {
    const probe = { migrated_at: migratedAt, chunk: chunks.length, of: 999, ids: [...current, id] };
    if (current.length > 0 && atomBytes(JSON.stringify(probe)) > MARKER_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
    }
    current.push(id);
  }
  if (current.length > 0) chunks.push(current);
  const ops = chunks.map((chunkIds, k) =>
    putOp(layout, store, hash, def.markerRange(k), {
      migrated_at: migratedAt,
      chunk: k,
      of: chunks.length,
      ids: chunkIds,
    }),
  );
  // A chunk left over from an earlier, longer marker would keep an old
  // `migrated_at` and old ids alive.
  const keep = new Set(ops.map((op) => op.keyRange));
  for (const range of existing) if (!keep.has(range)) ops.push(deleteOp(layout, store, hash, range));
  return ops;
}

/** A marker by point reads (chunk 0, then the other chunks with one multi-get). */
async function readMarkerPoint(
  node: NodeClient,
  layout: Layout,
  store: StoreKind,
  hash: string,
): Promise<Marker> {
  const def = STORES[store];
  const schemaHash = schemaOf(layout, store);
  const fields = [def.fields.r, def.fields.payload];
  const first = await node.queryAll({
    schemaHash,
    fields,
    filter: { HashRangeKey: { hash, range: def.markerRange(0) } },
  });
  const row0 = first.results[0];
  if (!row0) return NO_MARKER;
  const parts = [
    { range: def.markerRange(0), stored: parseStored(row0.fields[def.fields.payload], hash) },
  ];
  const of = asChunk(parts[0]!.stored, `${hash}/${parts[0]!.range}`).of;
  if (of > 1) {
    const rest = await node.queryAll({
      schemaHash,
      fields,
      filter: {
        HashRangeKeys: Array.from({ length: of - 1 }, (_, k) => [hash, def.markerRange(k + 1)]),
      },
    });
    for (const row of rest.results) {
      const range = rangeOf(row, def.fields.r);
      if (range !== null) parts.push({ range, stored: parseStored(row.fields[def.fields.payload], hash) });
    }
  }
  return parseMarker(parts, hash);
}

// ---------------------------------------------------------------------------
// Reading a partition (and seeding it from its legacy blob)
// ---------------------------------------------------------------------------

export type PartitionInfo = {
  hash: string;
  markerComplete: boolean;
  markerIds: Set<string> | null;
  migratedAt: string | null;
  legacyKey: string | null;
  /** `updated_at` of the legacy blob when it was read, else null. */
  legacyUpdatedAt: string | null;
  /** Entries the legacy blob held when it was read, else null. */
  legacyEntries: number | null;
  /** The blob was written after the marker: an old binary wrote it. */
  drift: boolean;
  /** Ids the marker lists that have no stored entry (after asking twice). */
  missingListed: string[];
  /** Stored ids for which the blob holds a NEWER version: decided from the record. */
  contested: string[];
};

export type PartitionState<T> = {
  /** Every live entry: stored ones, plus legacy ones that are not stored yet. */
  entries: Array<Entry<T>>;
  /** Writes that seed or repair the partition. Empty when nothing was copied. */
  migrationOps: BatchMutationOp[];
  info: PartitionInfo;
};

function uniqueDrafts<T>(drafts: Array<EntryDraft<T>>): Array<EntryDraft<T>> {
  const seen = new Set<string>();
  const out: Array<EntryDraft<T>> = [];
  for (const draft of drafts) {
    if (seen.has(draft.id)) continue;
    seen.add(draft.id);
    out.push(draft);
  }
  return out;
}

async function readStored<T>(node: NodeClient, layout: Layout, spec: PartitionSpec<T>) {
  const rows = await readRows(node, layout, spec.store, spec.hash, spec.range);
  const stored: Array<Entry<T>> = [];
  const markerParts: Array<{ range: string; stored: unknown }> = [];
  for (const row of rows) {
    if (isMarkerRange(spec.store, row.range)) {
      markerParts.push(row);
      continue;
    }
    const id = STORES[spec.store].idOf(row.range);
    stored.push({ id, range: row.range, payload: spec.coerce(row.stored, id) });
  }
  const marker = parseMarker(markerParts, spec.hash);
  const present = new Set(stored.map((entry) => entry.id));
  const missingListed =
    marker.complete && spec.fillMissing ? [...marker.ids].filter((id) => !present.has(id)) : [];
  return { stored, marker, present, missingListed };
}

/**
 * One partition: one range query, plus the legacy blob when the partition is not
 * known to be migrated (rules 1 to 3 and 5 at the top of this file).
 */
export async function loadPartition<T>(
  node: NodeClient,
  cfg: Config,
  layout: Layout,
  spec: PartitionSpec<T>,
): Promise<PartitionState<T>> {
  let { stored, marker, present, missingListed } = await readStored(node, layout, spec);
  // A marker id with no entry cannot say "resolved" from "not synced" from "a
  // page the node nulled". Ask a second time before it is believed.
  if (missingListed.length > 0) {
    ({ stored, marker, present, missingListed } = await readStored(node, layout, spec));
  }

  const info: PartitionInfo = {
    hash: spec.hash,
    markerComplete: marker.complete,
    markerIds: marker.complete ? marker.ids : null,
    migratedAt: marker.migratedAt,
    legacyKey: spec.legacyKey,
    legacyUpdatedAt: null,
    legacyEntries: null,
    drift: false,
    missingListed,
    contested: [],
  };
  const done = (entries: Array<Entry<T>>, migrationOps: BatchMutationOp[]) => ({
    entries,
    migrationOps,
    info,
  });
  if (!spec.legacyKey) return done(stored, []);

  // Rule 3: a gate partition whose blob was written after the marker.
  if (marker.complete && spec.checkDrift && missingListed.length === 0) {
    info.legacyUpdatedAt = await readLegacyUpdatedAt(node, cfg, spec.legacyKey);
    info.drift =
      info.legacyUpdatedAt !== null &&
      marker.migratedAt !== null &&
      info.legacyUpdatedAt > marker.migratedAt;
  }
  if (marker.complete && missingListed.length === 0 && !info.drift) return done(stored, []);

  // Rule 1: believe "no row" only after asking twice, and never mark on it.
  const legacy = await readLegacyRow(node, cfg, spec.legacyKey, {
    confirmAbsent: !marker.complete,
  });
  if (!legacy) return done(stored, []);
  info.legacyUpdatedAt = legacy.updated_at;
  info.drift =
    marker.complete &&
    spec.checkDrift &&
    marker.migratedAt !== null &&
    legacy.updated_at > marker.migratedAt;
  const drafts = uniqueDrafts(spec.fromLegacy(legacy.payload));
  info.legacyEntries = drafts.length;
  const untrusted = (payload: T): T => (spec.untrusted ? spec.untrusted(payload) : payload);

  // Rule 2: the marker is trusted for the ids it lists. A listed id with no
  // entry comes from the blob, and the record is read for it.
  if (marker.complete && !info.drift) {
    const listed = new Set(missingListed);
    const fill: Array<Entry<T>> = drafts
      .filter((draft) => listed.has(draft.id))
      .map((draft) => ({ ...draft, payload: untrusted(draft.payload), fromLegacy: true as const }));
    return done([...stored, ...fill], []);
  }

  // First copy, or a repair after drift. Rule 5: write ONLY the ids that are
  // absent, as untrusted entries; an existing entry is never rewritten.
  if (drafts.length === 0) return done(stored, []);
  const absent = drafts.filter((draft) => !present.has(draft.id));
  const entries: Array<Entry<T>> = [...stored];
  // A stored entry the blob holds a newer version of (an older binary wrote
  // after the copy): decided from the record, and drift stays visible until a
  // `put` refreshes the entry.
  if (info.drift && spec.version) {
    const byId = new Map(stored.map((entry) => [entry.id, entry]));
    for (const draft of drafts) {
      const have = byId.get(draft.id);
      if (
        have &&
        !(spec.isUntrusted?.(have.payload) ?? false) &&
        spec.version(draft.payload) > spec.version(have.payload)
      ) {
        have.decideFromRecord = true;
        info.contested.push(draft.id);
      }
    }
  }
  const ops: BatchMutationOp[] = [];
  for (const draft of absent) {
    const payload = untrusted(draft.payload);
    entries.push({ ...draft, payload });
    ops.push(putOp(layout, spec.store, spec.hash, draft.range, payload));
  }
  // The marker (and with it the end of the drift state) is rewritten only when
  // no stored entry is contested.
  if (info.contested.length === 0) {
    ops.push(
      ...markerOps(
        layout,
        spec.store,
        spec.hash,
        drafts.map((draft) => draft.id),
        new Date().toISOString(),
        marker.ranges,
      ),
    );
  }
  return done(entries, ops);
}

/**
 * Read several partitions (in parallel, `READ_CONCURRENCY` at a time) and send
 * every seed or repair in ONE batch. A failed seed does not fail the read: the
 * answer is already complete in memory, and the next read tries again.
 */
export async function readPartitions<T>(
  node: NodeClient,
  cfg: Config,
  layout: Layout,
  specs: ReadonlyArray<PartitionSpec<T>>,
): Promise<Array<PartitionState<T>>> {
  const states = await mapLimit(specs, READ_CONCURRENCY, (spec) =>
    loadPartition(node, cfg, layout, spec),
  );
  const ops = states.flatMap((state) => state.migrationOps);
  if (ops.length > 0) {
    try {
      await commitOps(node, ops);
    } catch (err) {
      warn(
        `could not copy the legacy Index blobs into the entry partitions (${ops.length} writes): ` +
          `${err instanceof Error ? err.message : String(err)}; the read is complete and the next read retries.`,
      );
    }
  }
  return states;
}

/**
 * Writes a WRITER puts in front of its own so the partition is safe to add to:
 * the legacy copy (absent ids only, untrusted) plus the marker, in the same batch
 * as the new entry. Point reads only (the marker, then the blob's `updated_at`):
 * a notice write never reads a whole day. A partition with no legacy row gets no
 * marker and no ops.
 */
export async function migrationOpsForWrite<T>(
  node: NodeClient,
  cfg: Config,
  layout: Layout,
  spec: PartitionSpec<T>,
): Promise<BatchMutationOp[]> {
  if (!spec.legacyKey) return [];
  const marker = await readMarkerPoint(node, layout, spec.store, spec.hash);
  if (marker.complete && !spec.checkDrift) return [];
  const legacyUpdatedAt = await readLegacyUpdatedAt(node, cfg, spec.legacyKey);
  // No legacy row (or a missed read): nothing to copy, and no marker (rule 1).
  if (legacyUpdatedAt === null) return [];
  if (marker.complete) {
    const drift = marker.migratedAt !== null && legacyUpdatedAt > marker.migratedAt;
    if (!drift) return [];
  }
  return (await loadPartition(node, cfg, layout, spec)).migrationOps;
}

/**
 * Drop `id` from the marker's list (it was resolved, so it no longer has an
 * entry): without this every later read would find a listed id with no entry and
 * read the legacy blob for it. The marker is not an input to liveness, so a lost
 * race (two writers rewrite one chunk) only costs a re-read, never a wrong answer.
 * `migrated_at` is kept. One point-read, no ops when the id is not listed.
 */
export async function trimMarkerOps<T>(
  node: NodeClient,
  layout: Layout,
  spec: PartitionSpec<T>,
  id: string,
): Promise<BatchMutationOp[]> {
  const marker = await readMarkerPoint(node, layout, spec.store, spec.hash);
  if (!marker.complete || !marker.ids.has(id) || marker.migratedAt === null) return [];
  const rest = [...marker.ids].filter((other) => other !== id);
  if (rest.length === 0) {
    // Nothing left to list: remove the chunks (an empty marker would never exist).
    return marker.ranges.map((range) => deleteOp(layout, spec.store, spec.hash, range));
  }
  return markerOps(layout, spec.store, spec.hash, rest, marker.migratedAt, marker.ranges);
}

/** The partition of days that hold history (`notice_history_days`, `situation_history_days`). */
export function daysPartition(hash: string): PartitionSpec<string> {
  return {
    store: "entry",
    hash,
    legacyKey: hash,
    checkDrift: true,
    fillMissing: true,
    fromLegacy: (legacy) =>
      normalizeHistoryDays(legacyList(legacy, hash)).map((day) => ({
        id: day,
        range: day,
        payload: "",
      })),
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
 * Throw when an entry points at no record (rule 4): a skipped entry is a skipped
 * hold. `fix` is the exact command that removes the entry.
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
