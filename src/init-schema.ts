import { FsituationsError, type NodeClient } from "./client.ts";
import {
  OWNER_APP_ID,
  indexSchema,
  noticeSchema,
  situationSchema,
  type AddSchemaRequest,
  type RecordType,
} from "./schemas.ts";

type SchemaTarget = {
  key: RecordType;
  schema: AddSchemaRequest;
};

const TARGETS: SchemaTarget[] = [
  { key: "situation", schema: situationSchema },
  { key: "notice", schema: noticeSchema },
  { key: "index", schema: indexSchema },
];

/**
 * Prefer already-loaded schemas; otherwise local-declare on Mini
 * via POST /api/apps/declare-schema (same first-run path as brain/kanban).
 * Returns a map of record-type → canonical hash for config pin.
 */
export async function resolveOrDeclareSchemaHashes(
  node: NodeClient,
  opts: { quiet?: boolean } = {},
): Promise<Partial<Record<RecordType, string>>> {
  const hashes: Partial<Record<RecordType, string>> = {};
  for (const target of TARGETS) {
    const existing = await resolveLoadedHash(node, target);
    if (existing) {
      hashes[target.key] = existing;
      continue;
    }
    try {
      const declared = await node.declareAppSchema(
        OWNER_APP_ID,
        target.schema.schema as unknown as Record<string, unknown>,
      );
      if (!opts.quiet) {
        console.log(
          `declared ${declared.schema} → ${declared.canonical}  (${declared.resolution})`,
        );
      }
      hashes[target.key] = declared.canonical;
    } catch (err) {
      // Route missing / method not allowed → leave that key unset.
      if (err instanceof FsituationsError && (err.code === "http_404" || err.code === "http_405")) {
        continue;
      }
      throw err;
    }
  }
  return hashes;
}

/** @deprecated Prefer resolveOrDeclareSchemaHashes — kept for tests/callers of Situation-only path. */
export async function resolveOrDeclareSituationHash(
  node: NodeClient,
  opts: { quiet?: boolean } = {},
): Promise<string | null> {
  const hashes = await resolveOrDeclareSchemaHashes(node, opts);
  return hashes.situation ?? null;
}

export async function resolveLoadedSituationHash(node: NodeClient): Promise<string | null> {
  return resolveLoadedHash(node, { key: "situation", schema: situationSchema });
}

export async function resolveLoadedNoticeHash(node: NodeClient): Promise<string | null> {
  return resolveLoadedHash(node, { key: "notice", schema: noticeSchema });
}

async function resolveLoadedHash(
  node: NodeClient,
  target: SchemaTarget,
): Promise<string | null> {
  const loaded = await node.listSchemas();
  const candidates = loaded.filter(
    (schema) =>
      schema.owner_app_id === OWNER_APP_ID &&
      schema.descriptive_name === target.schema.schema.descriptive_name,
  );
  const full = candidates.find((schema) =>
    target.schema.schema.fields.every((field) => schema.fields.includes(field)),
  );
  // Prefer descriptive identity match; name may be the namespaced string or the
  // canonical hash depending on node version.
  return full?.name ?? candidates[0]?.name ?? null;
}
