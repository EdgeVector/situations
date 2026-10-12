// Keyed index entries over the `IndexEntry` HashRange schema (see
// `indexEntrySchema` in schemas.ts for the partition list and the entry shape).
//
// Why this exists. The `Index` schema kept each list as ONE JSON blob in one
// field: every notice of a day, every situation of a day, the set of active
// situations. One field value is one atom, and the node refuses an atom above
// 64 KiB (`LASTDB_MAX_ATOM_CONTENT_BYTES`, HTTP 413). The day buckets measured
// 66 to 161 KB on the primary and grew by 40 KB in a day, so each notice
// rewrote a whole blob and the next write would fail. Here a list is a
// PARTITION: one small record per entry, read with one range query under the
// partition hash, grown with one small write. No code rewrites or caps a whole
// list, and no entry is dropped to fit.
//
// Migration (dual read, lazy, per partition). The legacy `Index` blob of each
// partition is READ ONCE, copied into the partition with ONE batch write that
// ends with a `__migrated__` marker entry, and never written or deleted again.
// A reader that finds no marker reads the legacy blob and merges it in; a
// writer that finds no marker puts the same copy in front of its own write, in
// the same batch. So a non-empty partition without a marker only means "not
// migrated yet", never "complete". A partition with neither entries nor a
// legacy blob is empty and is left alone (a read never writes a marker for it).

import {
  FsituationsError,
  type BatchMutationOp,
  type NodeClient,
  type QueryRow,
} from "./client.ts";
import { atomBytes } from "./atom-size.ts";
import { writeConfig, type Config } from "./config.ts";
import { readIndexPayload } from "./index-cache.ts";
import { resolveOrDeclareIndexEntryHash } from "./init-schema.ts";
import {
  INDEX_ENTRY_MARKER,
  INDEX_ENTRY_MAX_BYTES,
  INDEX_ENTRY_MIGRATED_RANGE,
} from "./schemas.ts";

/** Config key that pins the `IndexEntry` schema hash. */
export const INDEX_ENTRY_CONFIG_KEY = "index_entry";

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

/** One line on stderr. Never stdout: `--json` callers parse stdout. */
export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

export function indexEntryHash(cfg: { schemaHashes: Record<string, string> }): string | null {
  const hash = cfg.schemaHashes[INDEX_ENTRY_CONFIG_KEY];
  return hash && hash.length > 0 ? hash : null;
}

/**
 * The pinned `IndexEntry` hash for a WRITE, declaring and pinning it first when
 * a config from before this schema has none. A read never declares: a declare is
 * a Schema Service round trip (tens of seconds on a fresh registration), and a
 * read must keep answering from the legacy blobs until a write or
 * `situations init` pins the schema.
 */
export async function requireIndexEntryHash(node: NodeClient, cfg: Config): Promise<string> {
  const pinned = indexEntryHash(cfg);
  if (pinned) return pinned;
  const hash = await resolveOrDeclareIndexEntryHash(node);
  if (!hash) {
    throw new FsituationsError({
      code: "index_entry_schema_missing",
      message: "The node has no IndexEntry schema and cannot declare one.",
      hint: "Upgrade the node to one with POST /api/apps/declare-schema, then run `situations init`.",
    });
  }
  cfg.schemaHashes[INDEX_ENTRY_CONFIG_KEY] = hash;
  if (cfg.configPath) {
    try {
      writeConfig(cfg, cfg.configPath);
    } catch (err) {
      warn(
        `could not pin the IndexEntry schema in ${cfg.configPath}: ${err instanceof Error ? err.message : String(err)}; ` +
          "run `situations init` to pin it.",
      );
    }
  }
  return hash;
}

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

export type EntryDraft<T> = { range: string; payload: T };

export type PartitionSpec<T> = {
  /** Partition hash, e.g. `notice_history_day:2026-10-12`. */
  hash: string;
  /** Legacy `Index` key that held this partition as one blob. */
  legacyKey: string;
  /** The entries a legacy blob stands for. Must tolerate any JSON (or null). */
  fromLegacy(legacy: unknown): Array<EntryDraft<T>>;
  /** One stored `ie_payload` (parsed JSON, or "" for none) as a typed entry payload. */
  coerce(stored: unknown): T;
};

export function putOp(
  entryHash: string,
  hash: string,
  range: string,
  payload: unknown,
): BatchMutationOp {
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
    schemaHash: entryHash,
    keyHash: hash,
    keyRange: range,
    fields: { ie_h: hash, ie_r: range, ie_payload: serialized, ie_marker: INDEX_ENTRY_MARKER },
  };
}

export function deleteOp(entryHash: string, hash: string, range: string): BatchMutationOp {
  return { mutationType: "delete", schemaHash: entryHash, keyHash: hash, keyRange: range, fields: {} };
}

export function markerOp(entryHash: string, hash: string): BatchMutationOp {
  return putOp(entryHash, hash, INDEX_ENTRY_MIGRATED_RANGE, "");
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

/** The partition of days that hold history (`notice_history_days`, `situation_history_days`). */
export function daysPartition(hash: string): PartitionSpec<string> {
  return {
    hash,
    legacyKey: hash,
    fromLegacy: (legacy) =>
      normalizeHistoryDays(legacy).map((day) => ({ range: day, payload: "" })),
    coerce: () => "",
  };
}

function rangeOf(row: QueryRow): string | null {
  const range = row.key?.range ?? row.fields.ie_r;
  return typeof range === "string" && range.length > 0 ? range : null;
}

function parseStored(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return "";
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return "";
  }
}

async function readRows(
  node: NodeClient,
  entryHash: string,
  hash: string,
): Promise<Array<{ range: string; stored: unknown }>> {
  const res = await node.queryAll({
    schemaHash: entryHash,
    fields: ["ie_r", "ie_payload"],
    filter: { HashKey: hash },
    pageSize: PARTITION_PAGE_SIZE,
  });
  const out: Array<{ range: string; stored: unknown }> = [];
  for (const row of res.results) {
    // The filter is an exact hash match; keep the check so a node that ever
    // widens it cannot leak another partition's entries into this one.
    if (row.key?.hash != null && row.key.hash !== hash) continue;
    const range = rangeOf(row);
    if (range !== null) out.push({ range, stored: parseStored(row.fields.ie_payload) });
  }
  return out;
}

/** Point read: does this one key exist? */
export async function entryExists(
  node: NodeClient,
  entryHash: string,
  hash: string,
  range: string,
): Promise<boolean> {
  const res = await node.queryAll({
    schemaHash: entryHash,
    fields: ["ie_r"],
    filter: { HashRangeKey: { hash, range } },
  });
  return res.results.length > 0;
}

export type PartitionState<T> = {
  /** Every live entry: the stored ones plus the legacy ones not yet stored. */
  entries: Array<EntryDraft<T>>;
  /** Writes that seed the partition (copy + marker). Empty when migrated or empty. */
  migrationOps: BatchMutationOp[];
  migrated: boolean;
};

/** One partition: one range query, plus the legacy blob when there is no marker. */
export async function loadPartition<T>(
  node: NodeClient,
  cfg: Config,
  entryHash: string,
  spec: PartitionSpec<T>,
): Promise<PartitionState<T>> {
  const rows = await readRows(node, entryHash, spec.hash);
  const migrated = rows.some((row) => row.range === INDEX_ENTRY_MIGRATED_RANGE);
  const stored = rows
    .filter((row) => row.range !== INDEX_ENTRY_MIGRATED_RANGE)
    .map((row) => ({ range: row.range, payload: spec.coerce(row.stored) }));
  if (migrated) return { entries: stored, migrationOps: [], migrated: true };

  const legacy = await readIndexPayload<unknown>(node, cfg, spec.legacyKey);
  const have = new Set(stored.map((entry) => entry.range));
  const seen = new Set<string>();
  const missing: Array<EntryDraft<T>> = [];
  for (const draft of spec.fromLegacy(legacy)) {
    if (have.has(draft.range) || seen.has(draft.range)) continue;
    seen.add(draft.range);
    missing.push(draft);
  }
  // Nothing stored and nothing legacy: a genuinely empty partition. No marker.
  if (stored.length === 0 && missing.length === 0) {
    return { entries: [], migrationOps: [], migrated: false };
  }
  return {
    entries: [...stored, ...missing],
    migrationOps: [
      ...missing.map((draft) => putOp(entryHash, spec.hash, draft.range, draft.payload)),
      markerOp(entryHash, spec.hash),
    ],
    migrated: false,
  };
}

/**
 * Read several partitions (in parallel, `READ_CONCURRENCY` at a time) and seed
 * every partition that still lives only in a legacy blob with ONE batch write.
 * A failed seed does not fail the read: the answer is already complete in
 * memory, and the next read tries again.
 */
export async function readPartitions<T>(
  node: NodeClient,
  cfg: Config,
  entryHash: string,
  specs: ReadonlyArray<PartitionSpec<T>>,
): Promise<Array<Array<EntryDraft<T>>>> {
  const states = await mapLimit(specs, READ_CONCURRENCY, (spec) =>
    loadPartition(node, cfg, entryHash, spec),
  );
  const ops = states.flatMap((state) => state.migrationOps);
  if (ops.length > 0) {
    try {
      await commitOps(node, ops);
    } catch (err) {
      warn(
        `could not copy the legacy Index blobs into IndexEntry (${ops.length} writes): ` +
          `${err instanceof Error ? err.message : String(err)}; the read is complete and the next read retries.`,
      );
    }
  }
  return states.map((state) => state.entries);
}

/**
 * Writes a WRITER puts in front of its own to make `spec`'s partition safe to
 * add to: the legacy copy plus the marker, in the same batch as the new entry.
 * One point read when the partition is already migrated (the normal case).
 */
export async function migrationOpsForWrite<T>(
  node: NodeClient,
  cfg: Config,
  entryHash: string,
  spec: PartitionSpec<T>,
): Promise<BatchMutationOp[]> {
  if (await entryExists(node, entryHash, spec.hash, INDEX_ENTRY_MIGRATED_RANGE)) return [];
  const state = await loadPartition(node, cfg, entryHash, spec);
  return state.migrationOps.length > 0 ? state.migrationOps : [markerOp(entryHash, spec.hash)];
}

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
 * of a page under load, and a missing record is worth one retry.
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
