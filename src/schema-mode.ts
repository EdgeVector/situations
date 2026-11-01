/** Owned-home checks. The node API version proves that every schema owns its values. */
import { OWNER_APP_ID } from "./schemas.ts";

export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
export const payload = (value: unknown): ObjectValue =>
  object(object(value).data ?? value);

// API 13 (lastdb#803) is the first node that owns the values of every schema
// it declares and refuses an older home layout at startup. One node-level check
// replaces any per-schema reply key. An older node, or one without the version
// route (API 0), is refused.
export const OWNED_HOME_API_VERSION = 13;

/** `api_version` from a `GET /api/version` body (bare or `data` envelope); 0 when absent or malformed. */
export function nodeApiVersion(version: unknown): number {
  const value = payload(version).api_version;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

/** Does the node behind this `GET /api/version` body own the values of every schema? */
export function nodeOwnsValues(version: unknown): boolean {
  return nodeApiVersion(version) >= OWNED_HOME_API_VERSION;
}

export function requireOwnedHome(directory: unknown, version: unknown): void {
  const data = payload(directory);
  if (data.ready !== true || !Array.isArray(data.schemas))
    throw new Error(
      "The schema directory is incomplete. No schema was declared.",
    );
  if (!nodeOwnsValues(version)) {
    throw new Error(
      `F-Situations requires LastDB API ${OWNED_HOME_API_VERSION} or later, where each schema owns its values. Upgrade the selected node before setup. No schema was declared.`,
    );
  }
  // IndexEntry and NoticeHistory are owned HashRange records. A node with
  // owned Hash schemas only refuses those declarations, so check both flags
  // before the first declaration instead of failing halfway through setup.
  const capabilities = object(payload(version).capabilities);
  const missing = ["owned_app_schemas_v1", "independent_hash_range_v1"].filter(
    (flag) => capabilities[flag] !== true,
  );
  if (missing.length) {
    throw new Error(
      `F-Situations setup requires ${missing.join(" and ")}. Upgrade the selected node before setup.`,
    );
  }
}

export function ownedDeclaration(
  value: unknown,
  name: string,
): { identity: string; runtime: string } {
  const reply = payload(value);
  if (
    reply.app_id !== OWNER_APP_ID ||
    reply.schema_name !== `${OWNER_APP_ID}/${name}` ||
    typeof reply.canonical !== "string" ||
    !reply.canonical ||
    typeof reply.identity_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(reply.identity_hash)
  ) {
    throw new Error(
      "The declaration did not confirm the requested schema-owned definition. No config was changed.",
    );
  }
  return { identity: reply.identity_hash, runtime: reply.canonical };
}
