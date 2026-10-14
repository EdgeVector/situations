import { FsituationsError, type NodeClient } from "./client.ts";
import {
  OWNER_APP_ID,
  indexEntrySchema,
  indexSchema,
  noticeHistorySchema,
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
  { key: "notice_history", schema: noticeHistorySchema },
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

/**
 * The hashes of the entry-partition schemas the node has ALREADY loaded, found
 * through `GET /api/schemas` (one call). Never declares: a declare is a Schema
 * Service round trip, and release builds default to the PROD service, so only
 * `situations init` (a deliberate step) declares. A reader and a writer use this
 * when the config carries no pin, so a config that cannot be written (a
 * read-only home) still finds the schemas the node has.
 */
export async function resolveLoadedLayoutHashes(
  node: NodeClient,
): Promise<{ index: string | null; index_entry: string | null; notice_history: string | null }> {
  const loaded = await node.listSchemas();
  return {
    // The legacy Index schema: loaded when any schema of ours carries its name.
    index: pickLoadedHash(loaded, { key: "index", schema: indexSchema }),
    index_entry: pickLoadedHash(loaded, { key: "index_entry", schema: indexEntrySchema }, true),
    notice_history: pickLoadedHash(loaded, { key: "notice_history", schema: noticeHistorySchema }, true),
  };
}

export async function resolveLoadedSituationHash(node: NodeClient): Promise<string | null> {
  return resolveLoadedHash(node, { key: "situation", schema: situationSchema });
}

async function resolveLoadedHash(
  node: NodeClient,
  target: SchemaTarget,
): Promise<string | null> {
  return pickLoadedHash(await node.listSchemas(), target);
}

type LoadedSchemas = Awaited<ReturnType<NodeClient["listSchemas"]>>;

function pickLoadedHash(loaded: LoadedSchemas, target: SchemaTarget, strict = false): string | null {
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
  // A reader or writer needs a schema with every field; only `init` accepts a partial match.
  if (strict) return full?.name ?? null;
  return full?.name ?? candidates[0]?.name ?? null;
}
