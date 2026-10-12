import { FsituationsError, type NodeClient } from "./client.ts";
import {
  OWNER_APP_ID,
  indexEntrySchema,
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
  { key: "index_entry", schema: indexEntrySchema },
];

/**
 * Prefer already-loaded registered schemas; otherwise ask Mini to resolve or
 * register them with Schema Service via POST /api/apps/declare-schema (the
 * same first-run path as brain/kanban). There is no local-only fallback.
 * Returns a map of record-type → canonical hash for config pin.
 */
export async function resolveOrDeclareSchemaHashes(
  node: NodeClient,
  opts: { quiet?: boolean } = {},
): Promise<Partial<Record<RecordType, string>>> {
  const hashes: Partial<Record<RecordType, string>> = {};
  for (const target of TARGETS) {
    const hash = await resolveOrDeclareOne(node, target, opts);
    if (hash) hashes[target.key] = hash;
  }
  return hashes;
}

/**
 * Resolve one schema's canonical hash, declaring it when the node has not
 * loaded it. Returns null when the node has no declare route (older nodes).
 */
async function resolveOrDeclareOne(
  node: NodeClient,
  target: SchemaTarget,
  opts: { quiet?: boolean } = {},
): Promise<string | null> {
  const existing = await resolveLoadedHash(node, target);
  if (existing) return existing;
  try {
    const declared = await node.declareAppSchema(
      OWNER_APP_ID,
      target.schema.schema as unknown as Record<string, unknown>,
    );
    if (!opts.quiet) {
      console.log(`registered ${declared.schema} → ${declared.canonical}  (${declared.resolution})`);
    }
    return declared.canonical;
  } catch (err) {
    // Route missing / method not allowed → leave that key unset.
    if (err instanceof FsituationsError && (err.code === "http_404" || err.code === "http_405")) {
      return null;
    }
    throw err;
  }
}

/** Resolve or declare the `IndexEntry` schema alone (the lazy pin on first write). */
export async function resolveOrDeclareIndexEntryHash(node: NodeClient): Promise<string | null> {
  return resolveOrDeclareOne(node, { key: "index_entry", schema: indexEntrySchema }, { quiet: true });
}

export async function resolveLoadedSituationHash(node: NodeClient): Promise<string | null> {
  return resolveLoadedHash(node, { key: "situation", schema: situationSchema });
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
