import { requireOwnedHome, ownedDeclaration, payload } from "./schema-mode.ts";
import { canonicalSchema, profilesFor } from "./canonical-vocabulary.ts";
import { fieldAliasTransport, encodeFieldRequest, decodeFieldReply, localSchemaMetadata, type FieldAliasProfiles } from "./field-alias-transport.ts";
import type { SchemaDefinition } from "./schemas.ts";
// LastDB node client for situations.
//
// As of the @lastdb/app-sdk port, the app DATA PLANE rides the SDK's
// `LastDbClient` — the same wire client every LastDB app uses:
//   - query/queryAll  → explicit keyed pages with opaque continuation cursors
//   - create/update   → `LastDbClient.mutate`
// SDK typed errors are translated back into situations' `SituationsError`
// registry (see `mapSdkDataError`).
//
// The additional node surface includes explicit schema maintenance, which the
// app-data-plane SDK contract does not expose:
//   - `GET /api/system/auto-identity` — resolve/provision the local owner hash.
//   - `GET /api/schemas`              — list loaded schemas so `init` can pin
//                                       the canonical situations/Situation hash.
//   - `POST /api/apps/declare-schema` — Mini first-run orchestration for
//                                       Schema Service registration/resolution.
// Both are node-owner endpoints (no capability, no app scope), so they stay on
// the raw fetch-over-UDS path below.

import { existsSync } from "node:fs";

import {
  LastDbClient,
  capabilityStoreKey,
  httpTransport,
  udsTransport,
  CapabilityDeniedError,
  NodeTooOldError,
  PermissionDeniedError,
  RequestRejectedError,
  TransportError,
  UnexpectedResponseError,
  type CapabilityStore as SdkCapabilityStore,
  type JsonValue as SdkJsonValue,
  type NodeVersion as SdkNodeVersion,
  type Transport as SdkTransport,
} from "@lastdb/app-sdk";
import { MIN_LASTDB_API_VERSION, SITUATIONS_APP_LABEL } from "./lastdb-version.ts";

import { OWNER_APP_ID } from "./schemas.ts";

export type Verbose = (msg: string) => void;
const noopVerbose: Verbose = () => {};

export class SituationsError extends Error {
  readonly code: string;
  readonly hint?: string;
  override readonly cause?: unknown;

  constructor(opts: { code: string; message: string; hint?: string; cause?: unknown }) {
    super(opts.message);
    this.name = "SituationsError";
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

// Range-filter object forwarded verbatim to `/api/query`: `{ HashKey: "k" }`,
// `{ HashRangeKey: { hash, range } }`, `{ HashRangeKeys: [[hash, range], ...] }`.
export type QueryFilter = Record<string, unknown>;

/**
 * One write of a batch. `update` is an upsert (the node writes the key whether
 * or not it exists; `must_exist` is opt-in and not used here), so callers never
 * read a key just to choose between create and update. `keyRange` addresses one
 * row of a HashRange schema; omit it for a Hash schema.
 */
export type BatchMutationOp = {
  mutationType: "update" | "delete";
  schemaHash: string;
  keyHash: string;
  keyRange?: string;
  fields: Record<string, unknown>;
};

type LoadedSchema = {
  name: string;
  descriptive_name: string;
  owner_app_id: string;
  fields: string[];
  identity_hash: string;
  independent_fields: boolean;
};

type AppSchemaDeclaration = {
  app_id: string;
  schema: string;
  canonical: string;
  identity: string;
  resolution: string;
  decision?: string;
};

export type NodeClient = {
  readonly canonicalVocabulary?: boolean;
  baseUrl: string;
  userHash: string;
  autoIdentity(): Promise<
    | { provisioned: true; userHash: string }
    | { provisioned: false; reason: string }
  >;
  // GET /api/version — the client↔node compatibility handshake (app-sdk
  // `version()`). A node that predates the route reports `apiVersion: 0`,
  // `handshake: false`; never an error. The gate that ENFORCES
  // `MIN_LASTDB_API_VERSION` runs once per client before the first request
  // (see `requireNodeApiVersion` in `newNodeClient`).
  nodeVersion?(): Promise<SdkNodeVersion>;
  listSchemas(): Promise<LoadedSchema[]>;
  rawCall(method:"GET"|"POST", path:string, body?:unknown): Promise<{status:number; body:unknown}>;
  declareAppSchema(
    appId: string,
    schema: Record<string, unknown>,
  ): Promise<AppSchemaDeclaration>;
  createRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
    keyRange?: string;
  }): Promise<void>;
  updateRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
    keyRange?: string;
  }): Promise<void>;
  /**
   * `POST /api/mutations/batch`: every op commits in ONE request (one resident
   * commit, one revision). Callers chunk with `commitOps` in index-entry.ts.
   */
  mutateBatch(ops: BatchMutationOp[]): Promise<void>;
  queryAll(opts: {
    schemaHash: string;
    fields: string[];
    filter?: QueryFilter;
    /** Rows per page of the auto-paginating drain (1..1000, default 100). */
    pageSize?: number;
  }): Promise<QueryResponse>;
};

const DEFAULT_TIMEOUT_MS = 30_000;
// Safety ceiling for complete keyed page drains. situations record sets
// are small; this only guards against a pathological node.
const QUERY_MAX_ROWS = 100_000;

// The SDK's capability store is never used on this path: situations runs in
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
  schemaFieldAliases?: FieldAliasProfiles;
  canonicalVocabulary?: boolean;
  baseUrl: string;
  userHash: string;
  verbose?: Verbose;
  timeoutMs?: number;
  socketPath?: string;
}): NodeClient {
  const fieldProfiles: FieldAliasProfiles = {...opts.schemaFieldAliases};
  const canonicalVocabulary = opts.canonicalVocabulary ?? Boolean(opts.schemaFieldAliases);
  const baseUrl = stripTrailingSlash(opts.baseUrl);
  const verbose = opts.verbose ?? noopVerbose;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socketPath = opts.socketPath;

  const headers = (): Record<string, string> => ({
    "X-User-Hash": opts.userHash,
    // Best-effort Mini op-telemetry label (not a security boundary).
    "X-LastDB-Client": "situations",
  });

  // The SDK data-plane client. The transport carries X-User-Hash on every
  // request (the production node's HTTP server is stateless — identity comes
  // from the header); a UDS caller does not strictly need it, but passing it is
  // harmless. Built lazily so `init` (which only touches the owner-only
  // autoIdentity/listSchemas paths, often before a userHash is resolved) never
  // pays for it.
  // The client↔node version gate (app-sdk "Version handshake"). Resolved ONCE
  // per client before the first request on either wire path (the SDK
  // transport and `callJson`). With `MIN_LASTDB_API_VERSION` = 0 it resolves
  // without IO; with a positive floor it reads `GET /api/version` and throws
  // the SDK's NodeTooOldError — one line that names the fix — so a
  // situations newer than the node stops before its first write, not on a
  // bare 400 after it. The version route and `/health` are exempt.
  let apiVersionGate: Promise<void> | null = null;
  const requireNodeApiVersion = (path: string): Promise<void> => {
    if (isVersionGateExempt(path)) return Promise.resolve();
    apiVersionGate ??=
      MIN_LASTDB_API_VERSION > 0 ? gateOnNodeApiVersion(client()) : Promise.resolve();
    return apiVersionGate;
  };

  let sdk: LastDbClient | null = null;
  const client = (): LastDbClient => {
    if (sdk === null) {
      const transport: SdkTransport = gatedTransport(
        fieldAliasTransport(chooseTransport(baseUrl, socketPath, headers()),fieldProfiles),
        requireNodeApiVersion,
      );
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
    await requireNodeApiVersion(path);
    const { res, text } = await request({
      baseUrl,
      method,
      path,
      body:encodeFieldRequest(path,body,fieldProfiles),
      headers: headers(),
      socketPath,
      timeoutMs,
      verbose,
    });
    return { status: res.status, body: decodeFieldReply(path,body,parseBody(text),fieldProfiles) };
  }

  async function mutate(
    mutationType: "create" | "update",
    schemaHash: string,
    fields: Record<string, unknown>,
    keyHash: string,
    keyRange?: string,
  ): Promise<void> {
    verbose(`→ NODE POST /api/mutation (sdk) schema=${schemaHash} type=${mutationType}`);
    try {
      await client().mutate(schemaHash, {
        mutationType,
        fields: fields as Record<string, SdkJsonValue>,
        key: { hash: keyHash, range: keyRange ?? null },
      });
      verbose(`← NODE POST /api/mutation status=200`);
    } catch (err) {
      throw mapSdkDataError(err, baseUrl, socketPath, "/api/mutation");
    }
  }

  let schemaReadiness: Promise<void> | undefined;
  const requireOwnedSetup = (): Promise<void> => schemaReadiness ??= (async () => {
    const [directory,version]=await Promise.all([callJson("GET","/api/schemas"),callJson("GET","/api/version")]);
    if (directory.status!==200) throw mapNodeError(directory.status,directory.body,"/api/schemas");
    if (version.status!==200) throw mapNodeError(version.status,version.body,"/api/version");
    requireOwnedHome(directory.body,version.body);
  })();

  return {
    canonicalVocabulary,
    rawCall:callJson,
    baseUrl,
    userHash: opts.userHash,
    nodeVersion() {
      return client().version();
    },
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
      const directory=payload(body);
      if (directory.ready!==true || !Array.isArray(directory.schemas)) {
        throw new SituationsError({code:"schema_catalog_invalid",message:"The schema directory is incomplete."});
      }
      const raw=directory.schemas;
      return raw
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => {
          const schema = localSchemaMetadata(item,fieldProfiles);
          return ({
          name: stringField(schema, "name"),
          descriptive_name: stringField(schema, "descriptive_name"),
          owner_app_id: stringField(schema, "owner_app_id"),
          identity_hash:stringField(schema,"identity_hash"),
          independent_fields:schema.independent_fields===true,
          fields: Array.isArray(schema.fields)
            ? schema.fields.filter((field): field is string => typeof field === "string")
            : [],
        }); });
    },
    async declareAppSchema(appId, schema) {
      const local = schema as unknown as SchemaDefinition;
      await requireOwnedSetup();
      if (canonicalVocabulary) {
        schema = canonicalSchema(local) as unknown as Record<string,unknown>;
      }
      const { status, body } = await callJson("POST", "/api/apps/declare-schema", {
        app_id: appId,
        schema,
      });
      if (status !== 200) throw mapNodeError(status, body, "/api/apps/declare-schema");
      const binding=ownedDeclaration(body,local.name);
      const b=payload(body);
      const canonical=binding.runtime;
      const schemaName=String(b.schema_name);
      const resolution=String(b.resolution ?? "");
      if (canonicalVocabulary) Object.assign(fieldProfiles,profilesFor(local,[canonical,schemaName]));
      return {
        app_id: typeof b.app_id === "string" ? b.app_id : appId,
        schema: schemaName,
        canonical,
        identity:binding.identity,
        resolution,
        decision: typeof b.decision === "string" ? b.decision : undefined,
      };
    },
    async createRecord({ schemaHash, fields, keyHash, keyRange }) {
      await mutate("create", schemaHash, fields, keyHash, keyRange);
    },
    async updateRecord({ schemaHash, fields, keyHash, keyRange }) {
      await mutate("update", schemaHash, fields, keyHash, keyRange);
    },
    async mutateBatch(ops) {
      if (ops.length === 0) return;
      verbose(`→ NODE POST /api/mutations/batch count=${ops.length}`);
      const { status, body } = await callJson("POST", "/api/mutations/batch", {
        mutations: ops.map((op) => ({
          type: "mutation",
          schema: op.schemaHash,
          fields_and_values: op.fields,
          key_value: { hash: op.keyHash, range: op.keyRange ?? null },
          mutation_type: op.mutationType,
        })),
        convergence: "async",
      });
      verbose(`← NODE POST /api/mutations/batch status=${status}`);
      if (status !== 200) throw mapNodeError(status, body, "/api/mutations/batch");
      const result=payload(body);
      const operations=result.operations as {total?:number}|undefined;
      if(result.ok!==true||result.count!==ops.length||operations?.total!==ops.length||!Array.isArray(result.mutation_ids)||result.mutation_ids.length!==ops.length||result.mutation_ids.some((id)=>typeof id!=="string"||!id)) {
        throw new Error("The mutation batch did not confirm every accepted write.");
      }
    },
    async queryAll({schemaHash,fields,filter,pageSize}) {
      if(!filter)throw new Error("A query requires known keys.");
      const limit=Math.min(1000,Math.max(1,pageSize??100));
      const rows:QueryRow[]=[];
      const seen=new Set<string>();
      let cursor:unknown;
      for(let page=0;page<1000;page++){
        const requestBody={schema_name:schemaHash,fields,filter,limit,...(cursor===undefined?{}:{cursor})};
        const response=await callJson("POST","/api/query",requestBody);
        if(response.status!==200)throw mapNodeError(response.status,response.body,"/api/query");
        const result=payload(response.body);
        if(result.ok!==true||result.unresolved_rows!==0||typeof result.has_more!=="boolean"||!Array.isArray(result.results))throw new Error("The query is incomplete or unresolved.");
        for(const item of result.results){
          const row=item as QueryRow;
          if(!row||typeof row!=="object"||!row.key||typeof row.key.hash!=="string"||!(row.key.range===null||typeof row.key.range==="string")||!row.fields||typeof row.fields!=="object")throw new Error("The query returned a malformed record.");
          if(typeof filter.HashKey==="string"&&row.key.hash!==filter.HashKey)throw new Error("The query returned a different hash.");
          rows.push(row);
        }
        if(rows.length>QUERY_MAX_ROWS)throw new Error("The query exceeds its complete-result limit.");
        if(!result.has_more)return{ok:true,results:rows,total_count:rows.length,returned_count:rows.length};
        const next=result.next_cursor;
        const encoded=JSON.stringify(next);
        if(next===undefined||next===null||next===""||seen.has(encoded))throw new Error("The query lacks a fresh continuation cursor.");
        seen.add(encoded);cursor=next;
      }
      throw new Error("The query page limit stopped an incomplete result.");
    },
  };
}

// Paths the version gate never waits on: the handshake itself and the
// liveness probe.
function isVersionGateExempt(path: string): boolean {
  const bare = path.split("?")[0] ?? path;
  return bare === "/api/version" || bare === "/health" || bare === "/api/health";
}

// Resolve the version gate: the SDK's NodeTooOldError propagates to the
// caller (it is the one line that names the fix), so this only narrows the
// resolved type.
async function gateOnNodeApiVersion(sdk: LastDbClient): Promise<void> {
  await sdk.requireApiVersion(MIN_LASTDB_API_VERSION, SITUATIONS_APP_LABEL);
}

// Wrap an SDK transport so every send waits on the version gate first.
function gatedTransport(inner: SdkTransport, gate: (path: string) => Promise<void>): SdkTransport {
  return {
    target: inner.target,
    async send(method, path, options) {
      await gate(path);
      return inner.send(method, path, options);
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

function mapNodeError(status: number, body: unknown, path: string): SituationsError {
  const code = bodyError(body) ?? `http_${status}`;
  const message = bodyMessage(body) ?? `LastDB node ${path} failed with HTTP ${status}${rawBodySuffix(body)}.`;
  return new SituationsError({ code, message });
}

// Translate the SDK's typed data-plane errors back into situations' error
// registry, preserving the same code/message shape the raw path produced. The
// SDK maps each discriminated node response 1:1, so this stays a small table.
function mapSdkDataError(
  err: unknown,
  baseUrl: string,
  socketPath: string | undefined,
  path: string,
): SituationsError {
  // CapabilityDeniedError subclasses PermissionDeniedError — check it first.
  if (err instanceof CapabilityDeniedError) {
    return mapNodeError(403, { status: 403, reason: err.reason }, path);
  }
  if (err instanceof PermissionDeniedError) {
    return mapNodeError(403, { kind: "permission_denied", error: err.reason }, path);
  }
  // NB: NodeTooOldError subclasses RequestRejectedError — order matters. Its
  // message is already the one line an operator needs; wrapping it as
  // "HTTP 400" would bury the fact that the NODE is the side that moved.
  if (err instanceof NodeTooOldError) {
    return new SituationsError({ code: "node_too_old", message: err.message, cause: err });
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
  if (err instanceof SituationsError) return err;
  return new SituationsError({
    code: "sdk_error",
    message: `SDK call to ${path} failed: ${err instanceof Error ? err.message : String(err)}.`,
    cause: err,
  });
}

function connectionError(baseUrl: string, socketPath: string | undefined, err: unknown): SituationsError {
  const detail = err instanceof Error ? err.message : String(err);
  return new SituationsError({
    code: "node_unreachable",
    message: `Could not reach LastDB node at ${baseUrl}${socketPath ? ` via ${socketPath}` : ""}: ${detail}.`,
    cause: err,
  });
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
