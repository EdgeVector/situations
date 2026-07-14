// LastDB node client for fsituations.
//
// As of the @lastdb/app-sdk port, the app DATA PLANE rides the SDK's
// `LastDbClient` — the same wire client every LastDB app uses:
//   - query/queryAll  → `LastDbClient.queryAll` (auto-paginating drain)
//   - create/update   → `LastDbClient.mutate`
// SDK typed errors are translated back into fsituations' `FsituationsError`
// registry (see `mapSdkDataError`).
//
// The remaining hand-rolled node surface is deliberately OWNER-ONLY glue the
// app-data-plane SDK contract does not expose:
//   - `GET /api/system/auto-identity` — resolve/provision the local owner hash.
//   - `GET /api/schemas`              — list loaded schemas so `init` can pin
//                                       the canonical fsituations/Situation hash.
//   - `POST /api/apps/declare-schema` — Mini first-run local mint (same path as
//                                       brain/kanban init).
// Both are node-owner endpoints (no capability, no app scope), so they stay on
// the raw fetch-over-UDS path below.

import { existsSync } from "node:fs";

import {
  LastDbClient,
  capabilityStoreKey,
  httpTransport,
  udsTransport,
  CapabilityDeniedError,
  PermissionDeniedError,
  RequestRejectedError,
  TransportError,
  UnexpectedResponseError,
  type CapabilityStore as SdkCapabilityStore,
  type JsonValue as SdkJsonValue,
  type QueryFilter as SdkQueryFilter,
  type Transport as SdkTransport,
} from "@lastdb/app-sdk";

import { OWNER_APP_ID } from "./schemas.ts";

export type Verbose = (msg: string) => void;
const noopVerbose: Verbose = () => {};

export class FsituationsError extends Error {
  readonly code: string;
  readonly hint?: string;
  override readonly cause?: unknown;

  constructor(opts: { code: string; message: string; hint?: string; cause?: unknown }) {
    super(opts.message);
    this.name = "FsituationsError";
    this.code = opts.code;
    this.hint = opts.hint;
    this.cause = opts.cause;
  }
}

export type QueryRow = {
  fields: Record<string, unknown>;
  key: { hash: string | null; range: string | null };
};

export type QueryResponse = {
  ok: boolean;
  results: QueryRow[];
  total_count?: number;
  returned_count?: number;
};

export type QueryFilter = Record<string, string>;

export type LoadedSchema = {
  name: string;
  descriptive_name: string;
  owner_app_id: string;
  fields: string[];
};

export type AppSchemaDeclaration = {
  app_id: string;
  schema: string;
  canonical: string;
  resolution: string;
  decision?: string;
};

export type NodeClient = {
  baseUrl: string;
  userHash: string;
  autoIdentity(): Promise<
    | { provisioned: true; userHash: string }
    | { provisioned: false; reason: string }
  >;
  listSchemas(): Promise<LoadedSchema[]>;
  declareAppSchema(
    appId: string,
    schema: Record<string, unknown>,
  ): Promise<AppSchemaDeclaration>;
  createRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void>;
  updateRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void>;
  queryAll(opts: {
    schemaHash: string;
    fields: string[];
    filter?: QueryFilter;
  }): Promise<QueryResponse>;
};

const DEFAULT_TIMEOUT_MS = 30_000;
// Safety ceiling for the SDK's auto-paginating drain. fsituations record sets
// are small; this only guards against a pathological node.
const QUERY_MAX_ROWS = 100_000;

// The SDK's capability store is never used on this path: fsituations runs in
// owner context (X-User-Hash only, no consent/capability), so a no-op store
// keeps the SDK from ever touching a real keychain.
const noopCapabilityStore: SdkCapabilityStore = {
  async store() {},
  async load() {
    return null;
  },
  async remove() {},
};

export function newNodeClient(opts: {
  baseUrl: string;
  userHash: string;
  verbose?: Verbose;
  timeoutMs?: number;
  socketPath?: string;
}): NodeClient {
  const baseUrl = stripTrailingSlash(opts.baseUrl);
  const verbose = opts.verbose ?? noopVerbose;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socketPath = opts.socketPath;

  const headers = (): Record<string, string> => ({ "X-User-Hash": opts.userHash });

  // The SDK data-plane client. The transport carries X-User-Hash on every
  // request (the production node's HTTP server is stateless — identity comes
  // from the header); a UDS caller does not strictly need it, but passing it is
  // harmless. Built lazily so `init` (which only touches the owner-only
  // autoIdentity/listSchemas paths, often before a userHash is resolved) never
  // pays for it.
  let sdk: LastDbClient | null = null;
  const client = (): LastDbClient => {
    if (sdk === null) {
      const transport: SdkTransport = chooseTransport(baseUrl, socketPath, headers());
      sdk = new LastDbClient(
        OWNER_APP_ID,
        transport,
        noopCapabilityStore,
        null,
        capabilityStoreKey(OWNER_APP_ID, transport.target),
        transport.target,
      );
    }
    return sdk;
  };

  // Raw fetch-over-UDS, retained only for the hand-rolled owner-only endpoints.
  async function callJson(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const { res, text } = await request({
      baseUrl,
      method,
      path,
      body,
      headers: headers(),
      socketPath,
      timeoutMs,
      verbose,
    });
    return { status: res.status, body: parseBody(text) };
  }

  async function mutate(
    mutationType: "create" | "update",
    schemaHash: string,
    fields: Record<string, unknown>,
    keyHash: string,
  ): Promise<void> {
    verbose(`→ NODE POST /api/mutation (sdk) schema=${schemaHash} type=${mutationType}`);
    try {
      await client().mutate(schemaHash, {
        mutationType,
        fields: fields as Record<string, SdkJsonValue>,
        key: { hash: keyHash, range: null },
      });
      verbose(`← NODE POST /api/mutation status=200`);
    } catch (err) {
      throw mapSdkDataError(err, baseUrl, socketPath, "/api/mutation");
    }
  }

  return {
    baseUrl,
    userHash: opts.userHash,
    async autoIdentity() {
      const { status, body } = await callJson("GET", "/api/system/auto-identity");
      if (status === 200) {
        const userHash =
          body && typeof body === "object"
            ? (body as Record<string, unknown>).user_hash
            : undefined;
        return {
          provisioned: true,
          userHash: typeof userHash === "string" ? userHash : opts.userHash,
        };
      }
      if (status === 503) {
        return { provisioned: false, reason: bodyError(body) ?? "node_not_provisioned" };
      }
      throw mapNodeError(status, body, "/api/system/auto-identity");
    },
    async listSchemas() {
      const { status, body } = await callJson("GET", "/api/schemas");
      if (status !== 200) throw mapNodeError(status, body, "/api/schemas");
      const raw =
        body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).schemas)
          ? ((body as Record<string, unknown>).schemas as unknown[])
          : [];
      return raw
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((schema) => ({
          name: stringField(schema, "name"),
          descriptive_name: stringField(schema, "descriptive_name"),
          owner_app_id: stringField(schema, "owner_app_id"),
          fields: Array.isArray(schema.fields)
            ? schema.fields.filter((field): field is string => typeof field === "string")
            : [],
        }));
    },
    async declareAppSchema(appId, schema) {
      const { status, body } = await callJson("POST", "/api/apps/declare-schema", {
        app_id: appId,
        schema,
      });
      if (status !== 200) throw mapNodeError(status, body, "/api/apps/declare-schema");
      const b =
        body && typeof body === "object" ? (body as Record<string, unknown>) : ({} as Record<string, unknown>);
      const canonical = typeof b.canonical === "string" ? b.canonical : "";
      const schemaName = typeof b.schema === "string" ? b.schema : "";
      const resolution = typeof b.resolution === "string" ? b.resolution : "";
      if (!canonical || !schemaName || !resolution) {
        throw new FsituationsError({
          code: "app_schema_declare_bad_response",
          message: `Node /api/apps/declare-schema returned an incomplete response: ${JSON.stringify(body).slice(0, 300)}.`,
          hint: "Upgrade the node or inspect the app-schema declaration response.",
        });
      }
      return {
        app_id: typeof b.app_id === "string" ? b.app_id : appId,
        schema: schemaName,
        canonical,
        resolution,
        decision: typeof b.decision === "string" ? b.decision : undefined,
      };
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      await mutate("create", schemaHash, fields, keyHash);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      await mutate("update", schemaHash, fields, keyHash);
    },
    async queryAll({ schemaHash, fields, filter }) {
      // The SDK drains the node's `/api/query` pagination for us (the node caps
      // each page at DEFAULT_QUERY_LIMIT=100, so a plain query would silently
      // truncate a >100-row schema). `filter` is fsituations' optional range
      // filter (e.g. `{ HashKey: slug }`), forwarded verbatim under the query's
      // `filter` key by the SDK.
      const sdkFilter: Omit<SdkQueryFilter, "limit" | "offset" | "cursor"> = {
        fields,
        ...(filter ? { filter: filter as SdkJsonValue } : {}),
      };
      let result;
      try {
        result = await client().queryAll(schemaHash, sdkFilter, { maxRows: QUERY_MAX_ROWS });
      } catch (err) {
        throw mapSdkDataError(err, baseUrl, socketPath, "/api/query");
      }
      const results: QueryRow[] = result.rows.map((row) => ({
        fields: row.fields,
        key: row.keyValue ?? { hash: null, range: null },
      }));
      return {
        ok: true,
        results,
        returned_count: results.length,
        total_count: result.page?.totalCount ?? results.length,
      };
    },
  };
}

function chooseTransport(
  baseUrl: string,
  socketPath: string | undefined,
  defaultHeaders: Record<string, string>,
): SdkTransport {
  return shouldUseSocket(baseUrl, socketPath)
    ? udsTransport(socketPath, defaultHeaders)
    : httpTransport(baseUrl, defaultHeaders);
}

async function request(opts: {
  baseUrl: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  headers: Record<string, string>;
  socketPath?: string;
  timeoutMs: number;
  verbose: Verbose;
}): Promise<{ res: Response; text: string }> {
  const body =
    opts.body === undefined
      ? undefined
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  const headers = { ...opts.headers };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const useSocket = shouldUseSocket(opts.baseUrl, opts.socketPath);
  const url = useSocket ? `http://localhost${opts.path}` : `${opts.baseUrl}${opts.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    opts.verbose(`→ NODE ${opts.method} ${url}${useSocket ? ` [unix:${opts.socketPath}]` : ""}`);
    const init: RequestInit & { unix?: string } = {
      method: opts.method,
      headers,
      body,
      signal: controller.signal,
    };
    if (useSocket) init.unix = opts.socketPath;
    const res = await fetch(url, init);
    const text = await res.text();
    opts.verbose(`← NODE ${opts.method} ${url} status=${res.status}`);
    return { res, text };
  } catch (err) {
    throw connectionError(opts.baseUrl, opts.socketPath, err);
  } finally {
    clearTimeout(timer);
  }
}

function shouldUseSocket(baseUrl: string, socketPath?: string): socketPath is string {
  if (!socketPath || !isLoopbackNodeUrl(baseUrl)) return false;
  return existsSync(socketPath);
}

function isLoopbackNodeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value : "";
}

function bodyError(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const value = (body as Record<string, unknown>).error;
    if (typeof value === "string") return value;
  }
  return undefined;
}

function bodyMessage(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const value = (body as Record<string, unknown>).message;
    if (typeof value === "string") return value;
  }
  return undefined;
}

function rawBodySuffix(body: unknown): string {
  if (body === null || body === undefined) return "";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text && text !== "{}" ? `: ${text.slice(0, 300)}` : "";
}

function mapNodeError(status: number, body: unknown, path: string): FsituationsError {
  const code = bodyError(body) ?? `http_${status}`;
  const message = bodyMessage(body) ?? `LastDB node ${path} failed with HTTP ${status}${rawBodySuffix(body)}.`;
  return new FsituationsError({ code, message });
}

// Translate the SDK's typed data-plane errors back into fsituations' error
// registry, preserving the same code/message shape the raw path produced. The
// SDK maps each discriminated node response 1:1, so this stays a small table.
function mapSdkDataError(
  err: unknown,
  baseUrl: string,
  socketPath: string | undefined,
  path: string,
): FsituationsError {
  // CapabilityDeniedError subclasses PermissionDeniedError — check it first.
  if (err instanceof CapabilityDeniedError) {
    return mapNodeError(403, { status: 403, reason: err.reason }, path);
  }
  if (err instanceof PermissionDeniedError) {
    return mapNodeError(403, { kind: "permission_denied", error: err.reason }, path);
  }
  if (err instanceof RequestRejectedError) {
    return mapNodeError(400, err.body ?? { kind: err.kind, error: err.message }, path);
  }
  if (err instanceof UnexpectedResponseError) {
    return mapNodeError(err.status, err.body, path);
  }
  if (err instanceof TransportError) {
    return connectionError(baseUrl, socketPath, err);
  }
  if (err instanceof FsituationsError) return err;
  return new FsituationsError({
    code: "sdk_error",
    message: `SDK call to ${path} failed: ${err instanceof Error ? err.message : String(err)}.`,
    cause: err,
  });
}

function connectionError(baseUrl: string, socketPath: string | undefined, err: unknown): FsituationsError {
  const detail = err instanceof Error ? err.message : String(err);
  return new FsituationsError({
    code: "node_unreachable",
    message: `Could not reach LastDB node at ${baseUrl}${socketPath ? ` via ${socketPath}` : ""}: ${detail}.`,
    cause: err,
  });
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
