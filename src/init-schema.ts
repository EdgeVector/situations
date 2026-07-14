import { FsituationsError, type NodeClient } from "./client.ts";
import { OWNER_APP_ID, situationSchema } from "./schemas.ts";

/**
 * Prefer an already-loaded Situation schema; otherwise local-declare on Mini
 * via POST /api/apps/declare-schema (same first-run path as brain/kanban).
 */
export async function resolveOrDeclareSituationHash(
  node: NodeClient,
  opts: { quiet?: boolean } = {},
): Promise<string | null> {
  const existing = await resolveLoadedSituationHash(node);
  if (existing) return existing;

  try {
    const declared = await node.declareAppSchema(
      OWNER_APP_ID,
      situationSchema.schema as unknown as Record<string, unknown>,
    );
    if (!opts.quiet) {
      console.log(
        `declared ${declared.schema} → ${declared.canonical}  (${declared.resolution})`,
      );
    }
    return declared.canonical;
  } catch (err) {
    // Route missing / method not allowed → fall through to schema_not_loaded.
    if (err instanceof FsituationsError && (err.code === "http_404" || err.code === "http_405")) {
      return null;
    }
    throw err;
  }
}

export async function resolveLoadedSituationHash(node: NodeClient): Promise<string | null> {
  const loaded = await node.listSchemas();
  const candidates = loaded.filter(
    (schema) =>
      schema.owner_app_id === OWNER_APP_ID &&
      schema.descriptive_name === situationSchema.schema.descriptive_name,
  );
  const full = candidates.find((schema) =>
    situationSchema.schema.fields.every((field) => schema.fields.includes(field)),
  );
  // Prefer descriptive identity match; name may be the namespaced string or the
  // canonical hash depending on node version. Init pins whatever `listSchemas`
  // returns as `name` when already loaded; declare returns `canonical`.
  return full?.name ?? candidates[0]?.name ?? null;
}
