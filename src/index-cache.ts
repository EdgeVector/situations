// Thin point-read/point-write helpers over the optional `Index` schema (see
// schemas.ts). Each row is a small named JSON blob (e.g. `active_situations`,
// `recent_notices`) that record.ts/notice.ts keep patched on every upsert, so
// the hot agent-facing reads (preflight, default `list`/`notices`) never pay
// for a full-history scan of the Situation/Notice schemas.

import type { NodeClient } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";

const INDEX_QUERY_FIELDS = ["key", "payload_json", "updated_at"];

export function hasIndexSchema(cfg: { schemaHashes: Record<string, string> }): boolean {
  return Boolean(cfg.schemaHashes.index && cfg.schemaHashes.index.length > 0);
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

/** No-op when the schema isn't declared yet (pre-upgrade config). */
export async function writeIndexPayload(
  node: NodeClient,
  cfg: Config,
  key: string,
  payload: unknown,
): Promise<void> {
  if (!hasIndexSchema(cfg)) return;
  const hash = schemaHashFor("index", cfg);
  const fields = {
    key,
    payload_json: JSON.stringify(payload),
    updated_at: new Date().toISOString(),
  };
  const existing = await node.queryAll({
    schemaHash: hash,
    fields: ["key"],
    filter: { HashKey: key },
  });
  if (existing.results[0]) {
    await node.updateRecord({ schemaHash: hash, fields, keyHash: key });
  } else {
    await node.createRecord({ schemaHash: hash, fields, keyHash: key });
  }
}
