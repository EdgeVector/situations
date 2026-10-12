export const OWNER_APP_ID = "fsituations";

export type FieldType = "String" | { Array: "String" };

type SchemaDefinition = {
  name: string;
  owner_app_id: string;
  descriptive_name: string;
  purpose_statement?: string;
  schema_type: "Hash" | "HashRange";
  key: { hash_field: string; range_field?: string };
  fields: string[];
  field_types: Record<string, FieldType>;
  field_descriptions: Record<string, string>;
  field_classifications?: Record<string, string[]>;
  field_data_classifications: Record<
    string,
    { sensitivity_level: number; data_domain: string }
  >;
};

export type AddSchemaRequest = {
  schema: SchemaDefinition;
  mutation_mappers: Record<string, string>;
};

export const STATUS_VALUES = ["active", "monitoring", "resolved", "archived"] as const;
export type SituationStatus = (typeof STATUS_VALUES)[number];

export const SEVERITY_VALUES = ["p0", "p1", "p2", "p3"] as const;
export type Severity = (typeof SEVERITY_VALUES)[number];

export const NOTICE_KIND_VALUES = [
  "upgrade",
  "restart",
  "deploy",
  "config",
  "cutover",
  "other",
] as const;
export type NoticeKind = (typeof NOTICE_KIND_VALUES)[number];

export const NOTICE_SEVERITY_HINT_VALUES = ["info", "warn"] as const;
export type NoticeSeverityHint = (typeof NOTICE_SEVERITY_HINT_VALUES)[number];

const SITUATION_FIELDS = [
  "slug",
  "title",
  "summary",
  "status",
  "severity",
  "scope_systems",
  "scope_repos",
  "scope_routines",
  "scope_automations",
  "current_phase",
  "phases_json",
  "blocked_actions",
  "allowed_actions",
  "requires_human_clearance",
  "preflight_message",
  "links_kanban",
  "links_brain",
  "owner",
  "created_at",
  "updated_at",
  "expires_at",
] as const;

const NOTICE_FIELDS = [
  "slug",
  "kind",
  "title",
  "summary",
  "at",
  "scope_systems",
  "scope_apps",
  "actor",
  "related_situation",
  "severity_hint",
  "expires_at",
  "created_at",
  "links_kanban",
  "links_brain",
] as const;

const SITUATION_ARRAY_FIELDS = [
  "scope_systems",
  "scope_repos",
  "scope_routines",
  "scope_automations",
  "blocked_actions",
  "allowed_actions",
  "requires_human_clearance",
  "links_kanban",
  "links_brain",
] as const;

const NOTICE_ARRAY_FIELDS = [
  "scope_systems",
  "scope_apps",
  "links_kanban",
  "links_brain",
] as const;

const GENERAL = { sensitivity_level: 0, data_domain: "general" };

function fieldTypes(
  fields: readonly string[],
  arrayFields: readonly string[],
): Record<string, FieldType> {
  const arrays = new Set(arrayFields);
  return Object.fromEntries(
    fields.map((field) => [field, arrays.has(field) ? { Array: "String" } : "String"]),
  ) as Record<string, FieldType>;
}

function generalClassifications(
  fields: readonly string[],
): SchemaDefinition["field_data_classifications"] {
  return Object.fromEntries(fields.map((field) => [field, GENERAL]));
}

export const situationSchema: AddSchemaRequest = {
  schema: {
    name: "Situation",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Situation",
    purpose_statement:
      "A current operational posture record with scope, phases, links, and agent-facing preflight policy",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [...SITUATION_FIELDS],
    field_types: fieldTypes(SITUATION_FIELDS, SITUATION_ARRAY_FIELDS),
    field_descriptions: {
      slug: "stable url-style id",
      title: "one-line situation name",
      summary: "short current-state summary",
      status: "active|monitoring|resolved|archived",
      severity: "p0|p1|p2|p3",
      scope_systems: "systems affected by the situation",
      scope_repos: "owner/name repos affected by the situation",
      scope_routines: "routine names affected by the situation",
      scope_automations: "automation names affected by the situation",
      current_phase: "active phase/set slug",
      phases_json: "JSON array of phase records, each with slug/label/state/summary/policy",
      blocked_actions: "agent actions blocked while this situation is active",
      allowed_actions: "agent actions explicitly allowed while active",
      requires_human_clearance: "actions requiring human clearance",
      preflight_message: "message shown when an agent preflight is blocked",
      links_kanban: "related fkanban card slugs",
      links_brain: "related fbrain record slugs",
      owner: "human or routine responsible for the situation",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
      expires_at: "optional RFC 3339 expiry timestamp",
    },
    field_classifications: {
      title: ["word"],
      summary: ["word"],
      preflight_message: ["word"],
    },
    field_data_classifications: generalClassifications(SITUATION_FIELDS),
  },
  mutation_mappers: {},
};

/**
 * Non-blocking agent-impact FYI events (upgrades, restarts, cutovers).
 * Never participates in preflight. Default list hides expired rows.
 */
export const noticeSchema: AddSchemaRequest = {
  schema: {
    name: "Notice",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Notice",
    purpose_statement:
      "A time-stamped non-blocking FYI about an agent-impacting change (upgrade, restart, deploy) so other agents can attribute flapping instead of opening false incidents",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [...NOTICE_FIELDS],
    field_types: fieldTypes(NOTICE_FIELDS, NOTICE_ARRAY_FIELDS),
    field_descriptions: {
      slug: "stable url-style id, unique per event",
      kind: "upgrade|restart|deploy|config|cutover|other",
      title: "one-line notice headline",
      summary: "short what-happened text agents can quote when diagnosing",
      at: "RFC 3339 timestamp when the event happened",
      scope_systems: "systems affected (e.g. lastdbd, forgejo)",
      scope_apps: "agent-facing apps affected (e.g. brain, kanban, situations)",
      actor: "who/what did it (skill:lastdb-safe-upgrade, agent id, human)",
      related_situation: "optional Situation slug if this pairs with posture",
      severity_hint: "info|warn — display only; never blocks preflight",
      expires_at: "RFC 3339; default list hides notices past this time",
      created_at: "RFC 3339 when the notice was recorded",
      links_kanban: "related kanban card slugs",
      links_brain: "related brain record slugs",
    },
    field_classifications: {
      title: ["word"],
      summary: ["word"],
    },
    field_data_classifications: generalClassifications(NOTICE_FIELDS),
  },
  mutation_mappers: {},
};

const INDEX_FIELDS = ["key", "payload_json", "updated_at"] as const;

/**
 * Small cached rollups so the default `notices` read point-reads one small row
 * instead of a full-history scan of the Notice schema. List operations require
 * this schema; a missing row is an empty fresh-node state and never falls back
 * to a product-schema scan.
 *
 * Since 2026-10-12 only ONE key is written here: `recent_notices`, kept under
 * `RECENT_NOTICES_INDEX_MAX_BYTES` (32 KiB). Every list that grows (notice and
 * situation history, the active-situation set) lives in `IndexEntry`
 * (`indexEntrySchema`) as one small record per entry. The other keys this
 * schema once held (`active_situations`, `notice_history_days`,
 * `notice_history_day:<day>`, `situation_history_days`,
 * `situation_history_day:<day>`) are LEGACY: they are read once to seed
 * `IndexEntry`, never rewritten, never deleted. One atom must stay under the
 * node's 64 KiB atom-content limit; those blobs grew past it.
 */
export const indexSchema: AddSchemaRequest = {
  schema: {
    name: "Index",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Index",
    purpose_statement:
      "Small cached rollups (recent notices) so default notices reads never full-scan the underlying Notice table; legacy history blobs are read-only",
    schema_type: "Hash",
    key: { hash_field: "key" },
    fields: [...INDEX_FIELDS],
    field_types: fieldTypes(INDEX_FIELDS, []),
    field_descriptions: {
      key: "index name: recent_notices (written); active_situations and *_history_day* keys are legacy read-only",
      payload_json: "JSON blob for this index; shape depends on key; at most 32 KiB serialized",
      updated_at: "RFC 3339 timestamp of the last index rebuild/patch",
    },
    field_data_classifications: generalClassifications(INDEX_FIELDS),
  },
  mutation_mappers: {},
};

/**
 * One index entry per HashRange record: (`ie_h` partition) x (`ie_r` entry key).
 * A partition is a list that grows: the notices of one day, the situations
 * created on one day, the days that hold notices, the set of active situations.
 * A partition is read with ONE range query under its hash; one entry is added
 * or removed with ONE small write. No code reads, rewrites or caps a whole
 * list.
 *
 * Partitions (hash values; the entry key is the range):
 *   notice_history_day:<YYYY-MM-DD>     notice slug     filter + sort fields, and the notice when it fits
 *   notice_history_days                 YYYY-MM-DD      empty
 *   situation_history_day:<YYYY-MM-DD>  situation slug  created_at
 *   situation_history_days              YYYY-MM-DD      empty
 *   active_situations                   situation slug  status, severity, expires_at, updated_at, and the situation when it fits
 *
 * Every partition also holds one reserved entry key, `__migrated__`
 * (`INDEX_ENTRY_MIGRATED_RANGE`), written in the same batch that copies the
 * partition's legacy `Index` blob in. A slug is `[a-z0-9][a-z0-9_-]*` and a day
 * is `YYYY-MM-DD`, so neither can collide with it. Without the marker a
 * non-empty partition is ambiguous (fully migrated, or one new entry while the
 * old blob still holds the rest).
 *
 * Field names stay opaque (`ie_*`), as in brain's `*_hashrange_v1` schemas:
 * Schema Service field-unifies semantic names (slug, title, status, ...) into an
 * existing record identity, and opaque names plus one payload string mint a
 * novel HashRange identity. Do not rename them to something readable.
 *
 * `ie_payload` is the JSON of ONE small entry, at most `INDEX_ENTRY_MAX_BYTES`
 * (4 KiB). An entry carries the slug plus the fields a reader filters and sorts
 * on, and the whole Notice or Situation only when the entry still fits that
 * budget (a real notice or situation does). An entry that does not fit is
 * hydrated from the Situation or Notice record by slug with one batched
 * multi-get. The record stays the source of truth, and the record write and its
 * entries are one batch.
 */
export const INDEX_ENTRY_MARKER = "situations_index_entry_v1";
export const INDEX_ENTRY_MIGRATED_RANGE = "__migrated__";
export const INDEX_ENTRY_MAX_BYTES = 4 * 1024;
const INDEX_ENTRY_FIELDS = ["ie_h", "ie_r", "ie_payload", "ie_marker"] as const;

export const indexEntrySchema: AddSchemaRequest = {
  schema: {
    name: "IndexEntry",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "IndexEntry_hashrange_v1",
    purpose_statement:
      "One small index entry per HashRange record (partition x entry key) so notice history, situation history and the active-situation set are read with a keyed range query and grown with one small write, never as one rewritten blob",
    schema_type: "HashRange",
    key: { hash_field: "ie_h", range_field: "ie_r" },
    fields: [...INDEX_ENTRY_FIELDS],
    field_types: fieldTypes(INDEX_ENTRY_FIELDS, []),
    field_descriptions: {
      ie_h: "opaque partition token (notice_history_day:<day>, active_situations, ...)",
      ie_r: "opaque entry token (record slug, a day, or the reserved migrated-marker range)",
      ie_payload: "json object of ONE entry (keys, filter fields, and the record when it fits), at most 4 KiB; empty for day entries and the marker row",
      ie_marker: "constant token situations_index_entry_v1",
    },
    field_classifications: {
      ie_h: ["no_index", "metadata"],
      ie_r: ["no_index", "metadata"],
      ie_payload: ["no_index", "metadata"],
      ie_marker: ["no_index", "metadata"],
    },
    field_data_classifications: generalClassifications(INDEX_ENTRY_FIELDS),
  },
  mutation_mappers: {},
};

export type RecordType = "situation" | "notice" | "index" | "index_entry";

export function fieldsFor(type: RecordType): string[] {
  if (type === "situation") return [...SITUATION_FIELDS];
  if (type === "notice") return [...NOTICE_FIELDS];
  if (type === "index") return [...INDEX_FIELDS];
  if (type === "index_entry") return [...INDEX_ENTRY_FIELDS];
  throw new Error(`Unknown record type: ${type}`);
}
