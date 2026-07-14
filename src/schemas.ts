export const OWNER_APP_ID = "fsituations";

export function namespacedSchemaName(shortName: string): string {
  return `${OWNER_APP_ID}/${shortName}`;
}

export type FieldType = "String" | { Array: "String" };

export type SchemaDefinition = {
  name: string;
  owner_app_id: string;
  descriptive_name: string;
  purpose_statement?: string;
  schema_type: "Hash";
  key: { hash_field: string };
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

export const SITUATION_FIELDS = [
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

export const NOTICE_FIELDS = [
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

export const RECORD_TYPES = ["situation", "notice"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const UNIQUE_SCHEMAS = [
  { key: "situation" as const, schema: situationSchema },
  { key: "notice" as const, schema: noticeSchema },
];

export function fieldsFor(type: RecordType): string[] {
  if (type === "situation") return [...SITUATION_FIELDS];
  if (type === "notice") return [...NOTICE_FIELDS];
  throw new Error(`Unknown record type: ${type}`);
}
