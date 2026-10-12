// One field value is one atom, and a LastDB node refuses an atom above 64 KiB
// (`LASTDB_MAX_ATOM_CONTENT_BYTES`, default 65536; HTTP 413
// `atom_content_too_large`). Budgets here are stricter than that limit so a
// default-configured node is always safe.

/** The node refuses one atom above this many serialized bytes by default. */
export const ATOM_LIMIT_BYTES = 64 * 1024;
/** No field value this app writes to an index may pass this many serialized bytes. */
export const ATOM_BUDGET_BYTES = 48 * 1024;

/**
 * Size of one field value as the node measures an atom: the UTF-8 byte length
 * of `serde_json::Value::to_string()`. For a string field that is the JSON
 * string literal, so the quotes inside a JSON payload count twice, and a
 * non-ASCII character counts its UTF-8 bytes, not its UTF-16 units.
 */
export function atomBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
