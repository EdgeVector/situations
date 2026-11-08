/** Owned-home checks. Setup refuses an incomplete schema directory. */
import { OWNER_APP_ID } from "./schemas.ts";

export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
export const payload = (value: unknown): ObjectValue =>
  object(object(value).data ?? value);

export function requireOwnedHome(directory: unknown): void {
  const data = payload(directory);
  if (data.ready !== true || !Array.isArray(data.schemas))
    throw new Error(
      "The schema directory is incomplete. No schema was declared.",
    );
}

export function ownedDeclaration(
  value: unknown,
  name: string,
): { identity: string; runtime: string } {
  const reply = payload(value);
  if (
    reply.app_id !== OWNER_APP_ID ||
    reply.schema_name !== `${OWNER_APP_ID}/${name}` ||
    reply.canonical !== `${OWNER_APP_ID}/${name}` ||
    typeof reply.identity_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(reply.identity_hash)
  ) {
    throw new Error(
      "The declaration did not confirm the requested schema-owned definition. No config was changed.",
    );
  }
  return { identity: reply.identity_hash, runtime: reply.canonical };
}
