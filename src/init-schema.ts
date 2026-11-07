import { APP_SCHEMAS } from "./schema-layout.ts";
import { nodeOwnsValues, object, requireOwnedHome } from "./schema-mode.ts";
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
  opts: {
    quiet?: boolean;
    expectedIdentities?: Record<string, string>;
    requestedPins?: Record<string, string | undefined>;
  } = {},
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
  const targets = new Map(TARGETS.map(({ schema }) => [schema.schema.descriptive_name, schema.schema]));
  for (const installed of loaded) {
    const target = targets.get(installed.descriptive_name);
    if (installed.owner_app_id === "fsituations" || (installed.owner_app_id === OWNER_APP_ID && target &&
        (installed.name !== `${OWNER_APP_ID}/${target.name}` || !matchesKeys(installed.record_keys, target.record_keys)))) {
      throw new FsituationsError({
        code: "legacy_schema_conversion_required",
        message: "The selected node has legacy Situations schemas. Convert their records explicitly before registering the native definitions.",
      });
    }
  }
  // Preview the whole application before any declaration, including existing
  // field definitions, key layouts, and any identity pins from a saved config.
  const previews = await Promise.all(TARGETS.map(({ schema }) =>
    node.declareAppSchema(OWNER_APP_ID, schema.schema as unknown as Record<string, unknown>, "check"),
  ));
  if (previews.some((preview, index) => {
    const target = TARGETS[index]!;
    const installed = loaded.find((schema) => schema.name === preview.canonical);
    const expected = opts.expectedIdentities?.[target.key];
    const pin = opts.requestedPins?.[target.key];
    return (installed && installed.identity_hash !== preview.identity) ||
      (expected !== undefined && expected !== preview.identity) ||
      (pin !== undefined && pin !== preview.identity);
  })) {
    throw new FsituationsError({
      code: "native_schema_identity_mismatch",
      message: "A Situations definition differs from the existing node or config. Convert or resolve it explicitly before setup.",
    });
  }
  const declarations = await Promise.all(TARGETS.map(({ schema }) =>
    node.declareAppSchema(OWNER_APP_ID, schema.schema as unknown as Record<string, unknown>),
  ));
  const installed = await node.listSchemas();
  const schemaHashes: Record<string, string> = {};
  const schemaIdentities: Record<string, string> = {};
  for (const [index, { key, schema }] of TARGETS.entries()) {
    const declared = declarations[index]!;
    const preview = previews[index]!;
    const row = installed.find((item) => item.name === declared.canonical);
    if (declared.canonical !== preview.canonical || declared.identity !== preview.identity ||
        !row || row.owner_app_id !== OWNER_APP_ID || row.identity_hash !== declared.identity ||
        !matchesKeys(row.record_keys, schema.schema.record_keys)) {
      throw new FsituationsError({
        code: "native_schema_declaration_unconfirmed",
        message: "The node did not confirm the exact native Situations definitions after setup. No config was saved.",
      });
    }
    schemaHashes[key] = declared.canonical;
    schemaIdentities[key] = declared.identity;
    if (!opts.quiet) console.log(
      `registered ${declared.schema} → ${declared.canonical} (${declared.resolution})`,
    );
  }
  return { schemaHashes, schemaIdentities };
}

function matchesKeys(value: unknown, expected: AddSchemaRequest["schema"]["record_keys"]): boolean {
  const keys = object(value);
  const primary = object(keys.primary);
  const rangeType = expected.primary.kind === "hash_range" ? expected.primary.range_type : undefined;
  const alternates = keys.alternates;
  return primary.kind === expected.primary.kind && primary.range_type === rangeType &&
    primary.allow_absent !== true && alternates !== null && typeof alternates === "object" &&
    !Array.isArray(alternates) && Object.keys(alternates).length === 0;
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
      schema.descriptive_name === target.schema.schema.descriptive_name &&
      schema.name === `${OWNER_APP_ID}/${target.schema.schema.name}` &&
      matchesKeys(schema.record_keys, target.schema.schema.record_keys),
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
