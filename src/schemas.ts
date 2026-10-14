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
 * LEGACY, read-only. This schema held every list of this app as one JSON blob
 * per key (`active_situations`, `recent_notices`, `notice_history_day:<day>`,
 * `situation_history_day:<day>`, `notice_history_days`,
 * `situation_history_days`). One field value is one atom; those blobs measured
 * 66 to 161 KB and grew 40 KB in a day, past the node's atom ceiling, and every
 * notice rewrote a whole blob. Nothing writes this schema any more. Each blob is
 * read once to seed `IndexEntry` / `NoticeHistory`, never rewritten, never
 * deleted. The schema stays declared because that read needs it.
 */
export const indexSchema: AddSchemaRequest = {
  schema: {
    name: "Index",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Index",
    purpose_statement:
      "Legacy read-only rollup blobs (active situations, notice and situation history by day); superseded by the IndexEntry and NoticeHistory partitions",
    schema_type: "Hash",
    key: { hash_field: "key" },
    fields: [...INDEX_FIELDS],
    field_types: fieldTypes(INDEX_FIELDS, []),
    field_descriptions: {
      key: "legacy index name; every key is read-only",
      payload_json: "legacy JSON blob for this key; read once to seed the entry partitions",
      updated_at: "RFC 3339 timestamp of the last legacy write; a value newer than a partition marker's migrated_at means an old binary wrote after the migration",
    },
    field_data_classifications: generalClassifications(INDEX_FIELDS),
  },
  mutation_mappers: {},
};

/**
 * One index entry per HashRange record: (`ie_h` partition) x (`ie_r` entry key).
 * A partition is a list that grows. A partition is read with ONE range query
 * under its hash; one entry is added or removed with ONE small write. No code
 * reads, rewrites or caps a whole list.
 *
 * This schema holds NO time-ordered log and carries NO TTL:
 *   active_situations                   situation slug  status, severity, expires_at, updated_at, and the situation when it fits
 *   situation_history_day:<YYYY-MM-DD>  situation slug  created_at
 *   situation_history_days              YYYY-MM-DD      empty
 *   notice_history_days                 YYYY-MM-DD      empty
 * (The notices themselves are in `NoticeHistory`, the TTL-ready schema.)
 *
 * Every partition seeded from a legacy blob also holds marker records, entry
 * keys `__migrated__.<k>`: see `INDEX_ENTRY_MIGRATED_PREFIX`.
 *
 * Field names stay opaque (`ie_*`), as in brain's `*_hashrange_v1` schemas:
 * Schema Service field-unifies semantic names (slug, title, status, ...) into an
 * existing record identity, and opaque names plus one payload string mint a
 * novel HashRange identity. Do not rename them to something readable.
 *
 * `ie_payload` is the JSON of ONE small entry, at most `INDEX_ENTRY_MAX_BYTES`
 * (4 KiB). An entry carries the slug plus the fields a reader filters and sorts
 * on, and the whole Situation only when the entry still fits that budget (a real
 * situation does). An entry that does not fit is hydrated from its record by slug
 * with one batched multi-get. The record stays the source of truth, and the
 * record write and its entries are one batch.
 */
export const INDEX_ENTRY_MARKER = "situations_index_entry_v1";
export const NOTICE_HISTORY_MARKER = "situations_notice_history_v1";
export const INDEX_ENTRY_MAX_BYTES = 4 * 1024;
/**
 * A migration marker is one or more records, entry keys `__migrated__.0`,
 * `__migrated__.1`, ... Each carries `{ migrated_at, chunk, of, ids }`: the
 * `updated_at` of the legacy blob that was copied (the blob version READ, not the
 * local clock, so a later write by an older binary is always newer), which chunk
 * this is of how many, and the ids (slugs or days) the copy contained. A slug is `[a-z0-9][a-z0-9_-]*` and a day is
 * `YYYY-MM-DD`, so neither collides with the prefix.
 *
 * A reader trusts a marker only for the ids it lists, and only when every chunk
 * is present. A listed id with no entry yet (a device synced the marker before
 * the entries) is read from the legacy blob and its record. A marker is written
 * only after a legacy row with at least one entry was really copied: an empty
 * partition is never marked, because a missed read looks the same as no row.
 */
export const INDEX_ENTRY_MIGRATED_PREFIX = "__migrated__.";
const INDEX_ENTRY_FIELDS = ["ie_h", "ie_r", "ie_payload", "ie_marker"] as const;

export const indexEntrySchema: AddSchemaRequest = {
  schema: {
    name: "IndexEntry",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "IndexEntry_hashrange_v1",
    purpose_statement:
      "One small index entry per HashRange record (partition x entry key) so the active-situation set and situation history are read with a keyed range query and grown with one small write, never as one rewritten blob",
    schema_type: "HashRange",
    key: { hash_field: "ie_h", range_field: "ie_r" },
    fields: [...INDEX_ENTRY_FIELDS],
    field_types: fieldTypes(INDEX_ENTRY_FIELDS, []),
    field_descriptions: {
      ie_h: "opaque partition token (active_situations, situation_history_day:<day>, ...)",
      ie_r: "opaque entry token (record slug, a day, or a __migrated__.<k> marker chunk)",
      ie_payload: "json object of ONE entry (keys, filter fields, and the record when it fits), at most 4 KiB; empty for day entries",
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

/**
 * Notice history: a time-ordered LOG, one record per notice, shaped for a node
 * TTL (lastdb#155). A TTL needs the range key to START with the entry time as
 * unix seconds zero-padded to 20 digits; a key in any other form never expires.
 *
 *   hash  `nh_h` = `notice_history_day:<YYYY-MM-DD>`   a UTC DAY slice, never an
 *                  hour slice: the node's registry of hash partitions never shrinks
 *   range `nh_r` = `<20-digit unix seconds of created_at>#<slug>`
 *
 * `created_at` is the time the notice was recorded and never changes, so an
 * update rewrites the same key. The slug is the text after the first `#` (a slug
 * has none). The day is the UTC day of the notice's `at`.
 *
 * PROPOSED TTL: `Notice` 90 days (docs/design-lastdb-atom-ceiling-and-lifecycle.md
 * 3.5). THIS CODE SETS NO POLICY. The manifest TTL step is built separately, and
 * a policy has no backfill and must name BOTH installed names of this schema
 * (`fsituations/NoticeHistory` and its canonical hash). Entries written before a
 * policy exists will never expire.
 *
 * The migration marker keys of a partition are `<far-future seconds>#__migrated__.<k>`
 * (year 2286), so a TTL never expires a marker.
 *
 * Opaque `nh_*` names, for the same reason as `ie_*`.
 */
const NOTICE_HISTORY_FIELDS = ["nh_h", "nh_r", "nh_payload", "nh_marker"] as const;

export const noticeHistorySchema: AddSchemaRequest = {
  schema: {
    name: "NoticeHistory",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "NoticeHistory_hashrange_v1",
    purpose_statement:
      "One notice history entry per HashRange record (UTC day partition x creation time and slug) so notice history is read by day and expires by a node TTL, never as one rewritten blob",
    schema_type: "HashRange",
    key: { hash_field: "nh_h", range_field: "nh_r" },
    fields: [...NOTICE_HISTORY_FIELDS],
    field_types: fieldTypes(NOTICE_HISTORY_FIELDS, []),
    field_descriptions: {
      nh_h: "opaque partition token notice_history_day:<YYYY-MM-DD> (UTC day of the notice's at)",
      nh_r: "opaque entry token: 20-digit zero-padded unix seconds of created_at, '#', then the notice slug",
      nh_payload: "json object of ONE entry (filter fields, and the notice when it fits), at most 4 KiB",
      nh_marker: "constant token situations_notice_history_v1",
    },
    field_classifications: {
      nh_h: ["no_index", "metadata"],
      nh_r: ["no_index", "metadata"],
      nh_payload: ["no_index", "metadata"],
      nh_marker: ["no_index", "metadata"],
    },
    field_data_classifications: generalClassifications(NOTICE_HISTORY_FIELDS),
  },
  mutation_mappers: {},
};

export type RecordType = "situation" | "notice" | "index" | "index_entry" | "notice_history";

export function fieldsFor(type: RecordType): string[] {
  if (type === "situation") return [...SITUATION_FIELDS];
  if (type === "notice") return [...NOTICE_FIELDS];
  if (type === "index") return [...INDEX_FIELDS];
  if (type === "index_entry") return [...INDEX_ENTRY_FIELDS];
  if (type === "notice_history") return [...NOTICE_HISTORY_FIELDS];
  throw new Error(`Unknown record type: ${type}`);
}
