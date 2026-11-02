// A LastDB node refuses a field value above its ceiling
// (`LASTDB_MAX_FIELD_VALUE_BYTES`; the default is 256 KiB, HTTP 413
// `field_value_too_large`). This app keeps every field value it writes to an
// index far below that: an index entry is at most `INDEX_ENTRY_MAX_BYTES`
// (4 KiB, schemas.ts), and a list that grows is one record per entry, never one
// field.

/**
 * Size of one field value as the node measures it: the UTF-8 byte length
 * of `serde_json::Value::to_string()`. For a string field that is the JSON
 * string literal, so the quotes inside a JSON payload count twice, and a
 * non-ASCII character counts its UTF-8 bytes, not its UTF-16 units.
 */
export function fieldValueBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
