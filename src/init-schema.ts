import { APP_SCHEMAS } from "./schema-layout.ts";
import { nodeOwnsValues, requireOwnedHome } from "./schema-mode.ts";
import { profilesFor } from "./canonical-vocabulary.ts";
import type { FieldAliasProfiles } from "./field-alias-transport.ts";
import { FsituationsError, type NodeClient } from "./client.ts";
import {
  OWNER_APP_ID,
  indexEntrySchema,
  indexSchema,
  noticeHistorySchema,
  situationSchema,
  type AddSchemaRequest,
} from "./schemas.ts";

type SchemaTarget = {
  key: string;
  schema: AddSchemaRequest;
};

const TARGETS: SchemaTarget[] = APP_SCHEMAS.map(({ key, definition }) => ({
  key,
  schema: { schema: definition, mutation_mappers: {} },
}));

/** Explicit setup checks the whole app before it declares eight owned schemas. */
export async function resolveOrDeclareSchemaHashes(
  node: NodeClient,
  opts: { quiet?: boolean; canonicalVocabulary?: boolean } = {},
): Promise<{
  schemaHashes: Record<string, string>;
  schemaIdentities: Record<string, string>;
}> {
  const [loaded, version] = await Promise.all([
    node.listSchemas(),
    node.rawCall("GET", "/api/version"),
  ]);
  if (version.status !== 200)
    throw new Error(
      "The selected node did not confirm its schema capabilities.",
    );
  requireOwnedHome({ ready: true, schemas: loaded }, version.body);
  const schemaHashes: Record<string, string> = {};
  const schemaIdentities: Record<string, string> = {};
  await Promise.all(
    TARGETS.map(async (target) => {
      const declared = await node.declareAppSchema(
        OWNER_APP_ID,
        target.schema.schema as unknown as Record<string, unknown>,
      );
      schemaHashes[target.key] = declared.canonical;
      schemaIdentities[target.key] = declared.identity;
      if (!opts.quiet)
        console.log(
          `registered ${declared.schema} → ${declared.canonical} (${declared.resolution})`,
        );
    }),
  );
  return { schemaHashes, schemaIdentities };
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
): Promise<{
  index: string | null;
  index_entry: string | null;
  notice_history: string | null;
}> {
  const loaded = await listOwnedSchemas(node);
  return {
    // The legacy Index schema: loaded when any schema of ours carries its name.
    index: pickLoadedHash(loaded, { key: "index", schema: indexSchema }),
    index_entry: pickLoadedHash(loaded, {
      key: "index_entry",
      schema: indexEntrySchema,
    }),
    notice_history: pickLoadedHash(loaded, {
      key: "notice_history",
      schema: noticeHistorySchema,
    }),
  };
}

export async function resolveLoadedSituationHash(
  node: NodeClient,
): Promise<string | null> {
  return resolveLoadedHash(node, { key: "situation", schema: situationSchema });
}

async function resolveLoadedHash(
  node: NodeClient,
  target: SchemaTarget,
): Promise<string | null> {
  return pickLoadedHash(await listOwnedSchemas(node), target);
}

type LoadedSchemas = Awaited<ReturnType<NodeClient["listSchemas"]>>;

// A reader or writer uses a loaded schema only on a node that owns the values
// of every schema. An older node lists nothing here, the same as before setup.
async function listOwnedSchemas(node: NodeClient): Promise<LoadedSchemas> {
  const [loaded, version] = await Promise.all([
    node.listSchemas(),
    node.rawCall("GET", "/api/version"),
  ]);
  return version.status === 200 && nodeOwnsValues(version.body) ? loaded : [];
}

function pickLoadedHash(
  loaded: LoadedSchemas,
  target: SchemaTarget,
): string | null {
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
  // A reader or writer requires complete fields.
  return full?.name ?? null;
}

export function canonicalProfilesForHashes(
  hashes: Record<string, string>,
): FieldAliasProfiles {
  return Object.assign(
    {},
    ...TARGETS.map((target) =>
      profilesFor(target.schema.schema, [
        hashes[target.key] ?? "",
        `${OWNER_APP_ID}/${target.schema.schema.name}`,
      ]),
    ),
  );
}
