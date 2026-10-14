// One field value is one atom. A LastDB node refuses an atom above its ceiling
// (`LASTDB_MAX_ATOM_CONTENT_BYTES`; the default is 256 KiB since lastdb#154,
// HTTP 413 `atom_content_too_large`). This app keeps every atom it writes to an
// index far below that: an index entry is at most `INDEX_ENTRY_MAX_BYTES`
// (4 KiB, schemas.ts), and a list that grows is one record per entry, never one
// field.

/**
 * Size of one field value as the node measures an atom: the UTF-8 byte length
 * of `serde_json::Value::to_string()`. For a string field that is the JSON
 * string literal, so the quotes inside a JSON payload count twice, and a
 * non-ASCII character counts its UTF-8 bytes, not its UTF-16 units.
 */
export function atomBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
