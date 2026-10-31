// Read-only access to the LEGACY `Index` schema (see schemas.ts). Each row is a
// JSON blob from before the entry partitions existed. Nothing writes it any
// more; index-entry.ts reads a blob once to seed a partition, and reads its
// `updated_at` to notice an old binary that wrote after the migration.

import { SituationsError, type NodeClient } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";

const LEGACY_FIELDS = ["key", "payload_json", "updated_at"];

export function hasIndexSchema(cfg: { schemaHashes: Record<string, string> }): boolean {
  return Boolean(cfg.schemaHashes.index && cfg.schemaHashes.index.length > 0);
}

export function requireIndexSchema(cfg: { schemaHashes: Record<string, string> }): void {
  if (hasIndexSchema(cfg)) return;
  throw new SituationsError({
    code: "index_schema_required",
    message: "The situations Index schema is required for list operations.",
    hint: "Run `situations init` against the node to declare and pin the keyed indexes; unfiltered product-schema scans are not supported.",
  });
}

export type LegacyRow = { payload: unknown; updated_at: string };

/**
 * One legacy blob, or null when there is no such row (or the Index schema is not
 * declared). A row whose payload does not parse THROWS: an unreadable blob is a
 * hold nobody can read, and reading it as "no row" would let a gate answer OK.
 *
 * `confirmAbsent` asks once more before it believes "no row": `/api/query` can
 * null a real row out of a page under load, and a reader that trusts the first
 * answer serves one call without the legacy entries.
 */
export async function readLegacyRow(
  node: NodeClient,
  cfg: Config,
  key: string,
  opts: { confirmAbsent?: boolean } = {},
): Promise<LegacyRow | null> {
  if (!hasIndexSchema(cfg)) return null;
  const query = () =>
    node.queryAll({
      schemaHash: schemaHashFor("index", cfg),
      fields: LEGACY_FIELDS,
      filter: { HashKey: key },
    });
  let row = (await query()).results[0];
  if (!row && opts.confirmAbsent) row = (await query()).results[0];
  if (!row) return null;
  try {
    return {
      payload: JSON.parse(String(row.fields.payload_json ?? "null")) as unknown,
      updated_at: String(row.fields.updated_at ?? ""),
    };
  } catch (err) {
    throw new SituationsError({
      code: "index_legacy_unreadable",
      message: `Legacy Index row "${key}" is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
      hint: "The row cannot be read as a list of entries; fix or remove it before this partition is read.",
    });
  }
}

/** The `updated_at` of a legacy blob (one small field), or null when there is no row. */
export async function readLegacyUpdatedAt(
  node: NodeClient,
  cfg: Config,
  key: string,
): Promise<string | null> {
  if (!hasIndexSchema(cfg)) return null;
  const res = await node.queryAll({
    schemaHash: schemaHashFor("index", cfg),
    fields: ["key", "updated_at"],
    filter: { HashKey: key },
  });
  const row = res.results[0];
  return row ? String(row.fields.updated_at ?? "") : null;
}

/** The payload of a legacy blob, or null. Throws on an unreadable one. */
export async function readIndexPayload<T>(
  node: NodeClient,
  cfg: Config,
  key: string,
): Promise<T | null> {
  const row = await readLegacyRow(node, cfg, key);
  return row ? (row.payload as T) : null;
}
