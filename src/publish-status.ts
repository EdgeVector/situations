// Privacy-safe situations posture+notices publisher + LastDB deliver dogfood.
//
// Mirrors EdgeVector/routines `src/publish-status.ts`:
//   publish-status  → declare slim schemas + upsert Mini records
//   deliver-status  → publish, then stage (and optionally approve) a delivery_slice
//
// Salient payload only (no full phases_json, no preflight bodies beyond summary):
//   - Active posture: slug, severity, status, summary, blocked_actions
//   - Recent notices: kind, at, title, summary, systems

import { existsSync } from "node:fs";

import { FsituationsError, type NodeClient } from "./client.ts";
import { resolveSocketPath, type Config } from "./config.ts";
import {
  filterNotices,
  hasNoticeSchema,
  listNotices,
  type Notice,
} from "./notice.ts";
import {
  activeSituations,
  listSituations,
  type Situation,
} from "./record.ts";
import { OWNER_APP_ID, type FieldType } from "./schemas.ts";

export const SITUATIONS_APP_ID = OWNER_APP_ID;
export const SNAPSHOT_SLUG = "posture-latest";
export const DEFAULT_NOTICE_SINCE = "24h";
export const DEFAULT_MAX_RECORDS = 50;

type FieldMap = Record<string, string>;
type SchemaKey = "snapshot" | "posture" | "notice";

export interface PublishStatusOptions {
  now?: Date;
  noticeSince?: string;
  noticeLimit?: number;
  dryRun?: boolean;
  /** Injected data (tests / dry-run without Mini). */
  situations?: Situation[];
  notices?: Notice[];
  /** When omitted, uses loadCtx-style node + cfg for live reads/writes. */
  node?: NodeClient;
  cfg?: Config;
  socketPath?: string;
}

export interface PosturePublication {
  capturedAt: string;
  snapshot: FieldMap;
  posture: FieldMap[];
  notices: FieldMap[];
}

export interface PublishStatusResult extends PosturePublication {
  schemaHashes: Record<SchemaKey, string>;
  written: {
    snapshots: number;
    posture: number;
    notices: number;
  };
  dryRun: boolean;
}

export interface DeliveryRecipient {
  recipientPubkey: string;
  messagingPublicKey: string;
  messagingPseudonym: string;
  recipientDisplayName?: string;
}

export interface DeliverStatusOptions extends PublishStatusOptions {
  recipient: DeliveryRecipient;
  maxRecords?: number;
  approve?: boolean;
  deliveryClient?: LastDbDeliveryClient;
}

export interface DeliverStatusResult extends PublishStatusResult {
  deliveryRequest: DeliveryStageRequest;
  staged: DeliveryStageResult | null;
  approved: DeliveryApproveResult | null;
}

export interface DeliveryStageRequest {
  recipient_pubkey: string;
  recipient_display_name?: string;
  messaging_public_key: string;
  messaging_pseudonym: string;
  mode: "snapshot";
  max_records: number;
  legs: Array<{
    schema_name: string;
    fields: string[];
    hash_keys?: string[];
  }>;
}

export interface DeliveryStageResult {
  deliveryId: string;
  recordCount: number;
  fields: string[];
  note: string;
}

export interface DeliveryApproveResult {
  deliveryId: string;
  shared: number;
  messageType: string;
}

export interface LastDbDeliveryClient {
  stageDelivery(request: DeliveryStageRequest): Promise<DeliveryStageResult>;
  approveDelivery(deliveryId: string): Promise<DeliveryApproveResult>;
}

interface SchemaDefinition {
  name: string;
  owner_app_id: string;
  descriptive_name: string;
  purpose_statement: string;
  schema_type: "Hash";
  key: { hash_field: string };
  fields: string[];
  field_types: Record<string, FieldType>;
  field_descriptions: Record<string, string>;
  field_data_classifications: Record<string, { sensitivity_level: number; data_domain: string }>;
}

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

const SCHEMAS: Record<SchemaKey, SchemaDefinition> = {
  snapshot: schema(
    "SituationAdminSnapshot",
    "A slim point-in-time situations posture+notices snapshot safe for admin delivery",
    [...SNAPSHOT_FIELDS],
    "slug",
  ),
  posture: schema(
    "SituationAdminPosture",
    "One privacy-safe active situation posture row for admin delivery",
    [...POSTURE_FIELDS],
    "slug",
  ),
  notice: schema(
    "SituationAdminNotice",
    "One privacy-safe recent agent-impact notice for admin delivery",
    [...NOTICE_SLIM_FIELDS],
    "slug",
  ),
};

export function buildPosturePublication(options: {
  situations: Situation[];
  notices: Notice[];
  now?: Date;
  noticeSince?: string;
  noticeLimit?: number;
}): PosturePublication {
  const now = options.now ?? new Date();
  const capturedAt = now.toISOString();
  const noticeLimit = positiveInt(options.noticeLimit, 50);
  const active = activeSituations(options.situations, now);
  const recent = filterNotices(options.notices, {
    since: options.noticeSince ?? DEFAULT_NOTICE_SINCE,
    at: now,
  }).slice(0, noticeLimit);

  const posture = active.map((s) => postureFields(s, capturedAt));
  const notices = recent.map((n) => noticeFields(n, capturedAt));

  const snapshot: FieldMap = {
    slug: SNAPSHOT_SLUG,
    captured_at: capturedAt,
    posture_count: String(posture.length),
    notice_count: String(notices.length),
    posture_json: JSON.stringify(posture),
    notices_json: JSON.stringify(notices),
    schema_hashes_json: "",
  };

  return { capturedAt, snapshot, posture, notices };
}

export async function publishPostureStatus(
  options: PublishStatusOptions = {},
): Promise<PublishStatusResult> {
  const now = options.now ?? new Date();
  const node = options.node;
  const cfg = options.cfg;

  let situations = options.situations;
  let notices = options.notices;

  if (situations === undefined || notices === undefined) {
    if (!node || !cfg) {
      throw new FsituationsError({
        code: "publish_missing_source",
        message: "publish-status needs situations config (or injected situations/notices).",
        hint: "Run `situations init`, or pass a node+cfg for tests.",
      });
    }
    situations = situations ?? (await listSituations(node, cfg));
    notices =
      notices ??
      (hasNoticeSchema(cfg) ? await listNotices(node, cfg) : []);
  }

  const publication = buildPosturePublication({
    situations,
    notices,
    now,
    noticeSince: options.noticeSince,
    noticeLimit: options.noticeLimit,
  });

  if (options.dryRun || !node) {
    const schemaHashes = placeholderSchemaHashes();
    publication.snapshot.schema_hashes_json = JSON.stringify(schemaHashes);
    return {
      ...publication,
      schemaHashes,
      dryRun: true,
      written: { snapshots: 0, posture: 0, notices: 0 },
    };
  }

  const schemaHashes = await declareSchemas(node);
  publication.snapshot.schema_hashes_json = JSON.stringify(schemaHashes);

  await upsert(node, schemaHashes.snapshot, SNAPSHOT_SLUG, publication.snapshot, [...SNAPSHOT_FIELDS]);
  for (const row of publication.posture) {
    await upsert(node, schemaHashes.posture, requiredField(row, "slug"), row, [...POSTURE_FIELDS]);
  }
  for (const row of publication.notices) {
    await upsert(node, schemaHashes.notice, requiredField(row, "slug"), row, [...NOTICE_SLIM_FIELDS]);
  }

  return {
    ...publication,
    schemaHashes,
    dryRun: false,
    written: {
      snapshots: 1,
      posture: publication.posture.length,
      notices: publication.notices.length,
    },
  };
}

export async function deliverPostureStatus(
  options: DeliverStatusOptions,
): Promise<DeliverStatusResult> {
  const publication = await publishPostureStatus(options);
  const deliveryRequest = buildDeliveryStageRequest({
    schemaHashes: publication.schemaHashes,
    recipient: options.recipient,
    maxRecords: options.maxRecords,
  });

  if (options.dryRun || publication.dryRun) {
    return { ...publication, dryRun: true, deliveryRequest, staged: null, approved: null };
  }

  const client =
    options.deliveryClient ??
    newLastDbDeliveryClient({
      socketPath: options.socketPath ?? (options.cfg ? resolveSocketPath(options.cfg) : undefined),
      nodeUrl: options.cfg?.nodeUrl,
      userHash: options.cfg?.userHash,
    });
  const staged = await client.stageDelivery(deliveryRequest);
  const approved = options.approve ? await client.approveDelivery(staged.deliveryId) : null;
  return { ...publication, deliveryRequest, staged, approved };
}

export function buildDeliveryStageRequest(opts: {
  schemaHashes: Record<SchemaKey, string>;
  recipient: DeliveryRecipient;
  maxRecords?: number;
}): DeliveryStageRequest {
  const maxRecords = positiveInt(opts.maxRecords, DEFAULT_MAX_RECORDS);
  return {
    recipient_pubkey: opts.recipient.recipientPubkey,
    ...(opts.recipient.recipientDisplayName
      ? { recipient_display_name: opts.recipient.recipientDisplayName }
      : {}),
    messaging_public_key: opts.recipient.messagingPublicKey,
    messaging_pseudonym: opts.recipient.messagingPseudonym,
    mode: "snapshot",
    max_records: maxRecords,
    legs: [
      {
        schema_name: opts.schemaHashes.snapshot,
        fields: [...SNAPSHOT_FIELDS],
        hash_keys: [SNAPSHOT_SLUG],
      },
      {
        schema_name: opts.schemaHashes.posture,
        fields: [...POSTURE_FIELDS],
      },
      {
        schema_name: opts.schemaHashes.notice,
        fields: [...NOTICE_SLIM_FIELDS],
      },
    ],
  };
}

export function postureFields(s: Situation, capturedAt: string): FieldMap {
  return {
    slug: s.slug,
    severity: s.severity,
    status: s.status,
    summary: s.summary ?? "",
    blocked_actions: JSON.stringify(s.blocked_actions ?? []),
    updated_at: capturedAt,
  };
}

export function noticeFields(n: Notice, capturedAt: string): FieldMap {
  return {
    slug: n.slug,
    kind: n.kind,
    at: n.at,
    title: n.title,
    summary: n.summary ?? "",
    systems: (n.scope_systems ?? []).join(","),
    updated_at: capturedAt,
  };
}

async function declareSchemas(node: NodeClient): Promise<Record<SchemaKey, string>> {
  const out = {} as Record<SchemaKey, string>;
  for (const key of Object.keys(SCHEMAS) as SchemaKey[]) {
    const declared = await node.declareAppSchema(
      SITUATIONS_APP_ID,
      SCHEMAS[key] as unknown as Record<string, unknown>,
    );
    out[key] = declared.canonical;
  }
  return out;
}

async function upsert(
  node: NodeClient,
  schemaHash: string,
  keyHash: string,
  fields: FieldMap,
  queryFields: string[],
): Promise<void> {
  const existing = await node.queryAll({
    schemaHash,
    fields: queryFields,
    filter: { HashKey: keyHash },
  });
  const found = existing.results.some((row) => row.key.hash === keyHash);
  if (found) {
    await node.updateRecord({ schemaHash, fields, keyHash });
  } else {
    await node.createRecord({ schemaHash, fields, keyHash });
  }
}

function placeholderSchemaHashes(): Record<SchemaKey, string> {
  return {
    snapshot: "dry-run-SituationAdminSnapshot",
    posture: "dry-run-SituationAdminPosture",
    notice: "dry-run-SituationAdminNotice",
  };
}

function schema(name: string, purpose: string, fields: string[], hashField: string): SchemaDefinition {
  return {
    name,
    owner_app_id: SITUATIONS_APP_ID,
    descriptive_name: name,
    purpose_statement: purpose,
    schema_type: "Hash",
    key: { hash_field: hashField },
    fields,
    field_types: Object.fromEntries(fields.map((field) => [field, "String"])) as Record<
      string,
      FieldType
    >,
    field_descriptions: Object.fromEntries(fields.map((field) => [field, field.replaceAll("_", " ")])),
    field_data_classifications: Object.fromEntries(
      fields.map((field) => [field, { sensitivity_level: 0, data_domain: "situations" }]),
    ),
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return fallback;
  return value;
}

function requiredField(fields: FieldMap, key: string): string {
  const value = fields[key];
  if (value === undefined) throw new Error(`missing required field ${key}`);
  return value;
}

export class LastDbDeliverError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LastDbDeliverError";
    this.code = code;
  }
}

type FetchInit = RequestInit & { unix?: string };

export function newLastDbDeliveryClient(
  opts: { socketPath?: string; nodeUrl?: string; userHash?: string } = {},
): LastDbDeliveryClient {
  const callJson = newLastDbJsonCaller(opts);
  return {
    async stageDelivery(request) {
      const body = await callJson("POST", "/api/sharing/deliver", request);
      const data = dataObject(body);
      const delivery = dataObject(data.delivery);
      const preview = dataObject(delivery.preview);
      const deliveryId = objectString(delivery, "delivery_id");
      if (!deliveryId) {
        throw new LastDbDeliverError(
          "delivery_stage_bad_response",
          "LastDB deliver stage returned no delivery_id.",
        );
      }
      return {
        deliveryId,
        recordCount: objectNumber(preview, "record_count"),
        fields: objectStringArray(preview, "fields"),
        note: objectString(data, "note"),
      };
    },
    async approveDelivery(deliveryId) {
      const body = await callJson(
        "POST",
        `/api/sharing/deliveries/${encodeURIComponent(deliveryId)}/approve`,
      );
      const data = dataObject(body);
      return {
        deliveryId: objectString(data, "delivery_id") || deliveryId,
        shared: objectNumber(data, "shared"),
        messageType: objectString(data, "message_type"),
      };
    },
  };
}

function newLastDbJsonCaller(opts: { socketPath?: string; nodeUrl?: string; userHash?: string } = {}) {
  const socketPath = opts.socketPath ?? resolveSocketPath();
  const nodeUrl = (opts.nodeUrl ?? process.env.SITUATIONS_LASTDB_NODE_URL ?? "http://localhost:9001").replace(
    /\/+$/,
    "",
  );
  const userHash = opts.userHash ?? "";
  return async function callJson(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (userHash) headers["X-User-Hash"] = userHash;
    let requestBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
    const useSocket = isLoopback(nodeUrl) && existsSync(socketPath);
    const init: FetchInit = { method, headers, body: requestBody };
    if (useSocket) init.unix = socketPath;
    const url = useSocket ? `http://localhost${path}` : `${nodeUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new LastDbDeliverError(
        "lastdb_unreachable",
        useSocket
          ? `LastDB is not reachable over ${socketPath}: ${err instanceof Error ? err.message : String(err)}`
          : `LastDB is not reachable at ${nodeUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    const parsed = parseJson(text);
    if (!res.ok) {
      throw new LastDbDeliverError(
        `lastdb_http_${res.status}`,
        `LastDB ${method} ${path} returned ${res.status}: ${messageFor(parsed)}`,
      );
    }
    return parsed;
  };
}

function isLoopback(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function objectString(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
}

function objectNumber(value: unknown, key: string): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function objectStringArray(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>)[key];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function dataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const nested = obj.data;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : obj;
}

function messageFor(body: unknown): string {
  return objectString(body, "message") || objectString(body, "error") || JSON.stringify(body)?.slice(0, 300) || "";
}
