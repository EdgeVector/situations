// Thin point-read/point-write helpers over the optional `Index` schema (see
// schemas.ts). Each row is a small named JSON blob. `recent_notices` is the one
// key still written; notice.ts keeps it patched on every upsert so the default
// `notices` read never pays for a full-history scan of the Notice schema. The
// other keys (`active_situations`, `*_history_day*`) are legacy blobs that
// index-entry.ts reads once to seed `IndexEntry` and never touches again.

import { FsituationsError, type BatchMutationOp, type NodeClient } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";
import { ATOM_BUDGET_BYTES, atomBytes } from "./atom-size.ts";

const INDEX_QUERY_FIELDS = ["key", "payload_json", "updated_at"];

export function hasIndexSchema(cfg: { schemaHashes: Record<string, string> }): boolean {
  return Boolean(cfg.schemaHashes.index && cfg.schemaHashes.index.length > 0);
}

export function requireIndexSchema(cfg: { schemaHashes: Record<string, string> }): void {
  if (hasIndexSchema(cfg)) return;
  throw new FsituationsError({
    code: "index_schema_required",
    message: "The fsituations Index schema is required for list operations.",
    hint: "Run `situations init` against the node to declare and pin the keyed indexes; unfiltered product-schema scans are not supported.",
  });
}

/** Returns null when the schema isn't declared yet, or the row hasn't been seeded. */
export async function readIndexPayload<T>(
  node: NodeClient,
  cfg: Config,
  key: string,
): Promise<T | null> {
  if (!hasIndexSchema(cfg)) return null;
  const res = await node.queryAll({
    schemaHash: schemaHashFor("index", cfg),
    fields: INDEX_QUERY_FIELDS,
    filter: { HashKey: key },
  });
  const row = res.results[0];
  if (!row) return null;
  try {
    return JSON.parse(String(row.fields.payload_json ?? "null")) as T;
  } catch {
    return null;
  }
}

/**
 * The batch write that stores `payload` under `key`, or null when the schema is
 * not declared yet (pre-upgrade config). It is an upsert, so no read comes
 * first. The caller puts it in the same batch as the record write that made it
 * stale, so the two commit together.
 *
 * One `payload_json` value is one atom, and the node refuses an atom above
 * 64 KiB. This is the last line of defense: the only key still written here,
 * `recent_notices`, is capped at 32 KiB by its own writer, and a write that
 * would pass 48 KiB stops here with a name for the problem instead of a bare
 * HTTP 413 that also fails the record write batched with it.
 */
export function indexRowOp(cfg: Config, key: string, payload: unknown): BatchMutationOp | null {
  if (!hasIndexSchema(cfg)) return null;
  const payloadJson = JSON.stringify(payload);
  if (atomBytes(payloadJson) > ATOM_BUDGET_BYTES) {
    throw new FsituationsError({
      code: "index_payload_too_large",
      message: `Index row "${key}" would be ${atomBytes(payloadJson)} bytes; one atom may not pass ${ATOM_BUDGET_BYTES}.`,
      hint: "A list that grows belongs in IndexEntry (one record per entry), not in one Index row.",
    });
  }
  return {
    mutationType: "update",
    schemaHash: schemaHashFor("index", cfg),
    keyHash: key,
    fields: { key, payload_json: payloadJson, updated_at: new Date().toISOString() },
  };
}
