/** Schema ownership checks. Canonical definitions never grant shared mutable values. */
import { OWNER_APP_ID } from "./schemas.ts";

export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
export const payload = (value: unknown): ObjectValue =>
  object(object(value).data ?? value);

// API 13 (lastdb#803) is the first node that owns every schema and refuses a
// home with the old shared-value layout at startup. lastdb stage 2 stops
// sending `independent_fields` in node replies (lastdb#901 is stage 1, which
// still sends it). So a MISSING key means "owned" only on API >= 13; an older
// node that omits it (API <= 7 never sent it) is still refused. A present key
// keeps its old meaning: only `true` is owned, explicit `false` is not.
export const OWNED_BY_DEFAULT_API_VERSION = 13;

/** `api_version` from a `GET /api/version` body (bare or `data` envelope); 0 when absent or malformed. */
export function nodeApiVersion(version: unknown): number {
  const value = payload(version).api_version;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

/** Does this node schema entry (list, detail, or declare reply) own its values? */
export function ownsValues(entry: unknown, apiVersion: number): boolean {
  const flag = object(entry).independent_fields;
  if (flag === undefined) return apiVersion >= OWNED_BY_DEFAULT_API_VERSION;
  return flag === true;
}

export function requireOwnedHome(directory: unknown, version: unknown): void {
  const data = payload(directory);
  if (data.ready !== true || !Array.isArray(data.schemas))
    throw new Error(
      "The schema directory is incomplete. No schema was declared.",
    );
  const apiVersion = nodeApiVersion(version);
  if (
    data.schemas.some(
      (item) =>
        object(item).owner_app_id === OWNER_APP_ID &&
        !ownsValues(item, apiVersion),
    )
  ) {
    throw new Error(
      "Existing F-Situations values require explicit schema-values-convert on a compatible LastDB release. No schema was declared.",
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
  apiVersion: number,
): { identity: string; runtime: string } {
  const reply = payload(value);
  if (
    !ownsValues(reply, apiVersion) ||
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
