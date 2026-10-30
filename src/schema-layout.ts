/** App record types and their exact schema definitions. Value ownership is independent of vocabulary. */
import {
  situationSchema,
  noticeSchema,
  indexSchema,
  indexEntrySchema,
  noticeHistorySchema,
  type SchemaDefinition,
} from "./schemas.ts";
import { publicationSchemas } from "./publication-schemas.ts";

export const APP_SCHEMAS: ReadonlyArray<{
  key: string;
  definition: SchemaDefinition;
  member: string;
}> = [
  {
    key: "situation",
    member: "phases_json",
    definition: situationSchema.schema,
  },
  { key: "notice", member: "created_at", definition: noticeSchema.schema },
  { key: "index", member: "payload_json", definition: indexSchema.schema },
  {
    key: "index_entry",
    member: "ie_payload",
    definition: indexEntrySchema.schema,
  },
  {
    key: "notice_history",
    member: "nh_payload",
    definition: noticeHistorySchema.schema,
  },
  {
    key: "admin_snapshot",
    member: "posture_json",
    definition: publicationSchemas.snapshot,
  },
  {
    key: "admin_posture",
    member: "updated_at",
    definition: publicationSchemas.posture,
  },
  {
    key: "admin_notice",
    member: "updated_at",
    definition: publicationSchemas.notice,
  },
];
