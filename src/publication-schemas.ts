/** Separate privacy-safe publication records. These are not alternate views of source records. */
import { OWNER_APP_ID, type SchemaDefinition } from "./schemas.ts";

export const SNAPSHOT_FIELDS = [
  "slug",
  "captured_at",
  "posture_count",
  "notice_count",
  "posture_json",
  "notices_json",
  "schema_hashes_json",
] as const;
export const POSTURE_FIELDS = [
  "slug",
  "severity",
  "status",
  "summary",
  "blocked_actions",
  "updated_at",
] as const;
export const NOTICE_SLIM_FIELDS = [
  "slug",
  "kind",
  "at",
  "title",
  "summary",
  "systems",
  "updated_at",
] as const;
export type PublicationSchemaKey = "snapshot" | "posture" | "notice";

export const publicationSchemas: Record<
  PublicationSchemaKey,
  SchemaDefinition
> = {
  snapshot: schema(
    "SituationAdminSnapshot",
    "A slim point-in-time situations posture+notices snapshot safe for admin delivery",
    SNAPSHOT_FIELDS,
  ),
  posture: schema(
    "SituationAdminPosture",
    "One privacy-safe active situation posture row for admin delivery",
    POSTURE_FIELDS,
  ),
  notice: schema(
    "SituationAdminNotice",
    "One privacy-safe recent agent-impact notice for admin delivery",
    NOTICE_SLIM_FIELDS,
  ),
};

function schema(
  name: string,
  purpose: string,
  fields: readonly string[],
): SchemaDefinition {
  return {
    name,
    owner_app_id: OWNER_APP_ID,
    descriptive_name: name,
    purpose_statement: purpose,
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [...fields],
    field_types: Object.fromEntries(fields.map((field) => [field, "String"])),
    field_descriptions: Object.fromEntries(
      fields.map((field) => [field, field.replaceAll("_", " ")]),
    ),
    field_data_classifications: Object.fromEntries(
      fields.map((field) => [
        field,
        { sensitivity_level: 0, data_domain: "situations" },
      ]),
    ),
  };
}
