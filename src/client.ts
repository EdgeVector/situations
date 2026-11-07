import { requireOwnedHome, ownedDeclaration, object, payload } from "./schema-mode.ts";
import { canonicalSchema, profilesFor } from "./canonical-vocabulary.ts";
import { fieldAliasTransport, encodeFieldRequest, decodeFieldReply, localSchemaMetadata, type FieldAliasProfiles } from "./field-alias-transport.ts";
import type { SchemaDefinition } from "./schemas.ts";
import { coordinateId, readPage, writeRecords, type BatchMutationOp, type QueryFilter, type QueryRow } from "./native-records.ts";
export type { BatchMutationOp, QueryFilter, QueryRow } from "./native-records.ts";

// The SDK supplies the version handshake. The data plane sends complete native
// records and uses the same owner transport as schema setup.
import { existsSync } from "node:fs";

import {
  LastDbClient,
  capabilityStoreKey,
  httpTransport,
  udsTransport,
  type CapabilityStore as SdkCapabilityStore,
  type NodeVersion as SdkNodeVersion,
  type Transport as SdkTransport,
} from "@lastdb/app-sdk";
import { MIN_LASTDB_API_VERSION, SITUATIONS_APP_LABEL } from "./lastdb-version.ts";

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

export type QueryResponse = {
  ok: boolean;
  results: QueryRow[];
  total_count?: number;
  returned_count?: number;
};

type LoadedSchema = {
  name: string;
  descriptive_name: string;
  owner_app_id: string;
  fields: string[];
  identity_hash: string;
  record_keys: unknown;
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
    intent?: "check",
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
// Safety ceiling for complete keyed page drains. fsituations record sets
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
  schemaFieldAliases?: FieldAliasProfiles;
  canonicalVocabulary?: boolean;
  schemaIdentitiesByAddress?: Record<string, string>;
  baseUrl: string;
  userHash: string;
  verbose?: Verbose;
  timeoutMs?: number;
  socketPath?: string;
}): NodeClient {
  const fieldProfiles: FieldAliasProfiles = {...opts.schemaFieldAliases};
  const canonicalVocabulary = true;
  const baseUrl = stripTrailingSlash(opts.baseUrl);
  const verbose = opts.verbose ?? noopVerbose;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socketPath = opts.socketPath;

  const headers = (): Record<string, string> => ({
    "X-User-Hash": opts.userHash,
    // Best-effort Mini op-telemetry label (not a security boundary).
    "X-LastDB-Client": "situations",
  });

  // Resolve the version gate once before the first data or setup request.
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

  // Data and schema setup share the owner transport and field vocabulary.
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

  let schemaReadiness: Promise<void> | undefined;
  const requireOwnedSetup = (): Promise<void> => schemaReadiness ??= (async () => {
    const [directory,version]=await Promise.all([callJson("GET","/api/schemas"),callJson("GET","/api/version")]);
    if (directory.status!==200) throw mapNodeError(directory.status,directory.body,"/api/schemas");
    if (version.status!==200) throw mapNodeError(version.status,version.body,"/api/version");
    requireOwnedHome(directory.body,version.body);
  })();

  let boundSchemas: Promise<void> | undefined;
  const verifyBindings = (): Promise<void> => {
    const expected = opts.schemaIdentitiesByAddress;
    if (!expected) return Promise.resolve();
    return boundSchemas ??= (async () => {
      const { status, body } = await callJson("GET", "/api/schemas");
      if (status !== 200) throw mapNodeError(status, body, "/api/schemas");
      const directory = payload(body);
      const rows = Array.isArray(directory.schemas) ? directory.schemas.map(object) : [];
      const loaded = new Map(rows.filter((row) => row.owner_app_id === OWNER_APP_ID).map((row) => [row.name, row.identity_hash]));
      if (directory.ready !== true || Object.entries(expected).some(([address, identity]) => loaded.get(address) !== identity)) {
        throw new FsituationsError({
          code: "native_schema_binding_mismatch",
          message: "The selected node does not have the native Situations schemas saved in this config. Verify the node and config before retrying.",
        });
      }
    })();
  };

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
        throw new FsituationsError({code:"schema_catalog_invalid",message:"The schema directory is incomplete."});
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
          record_keys:schema.record_keys,
          fields: Array.isArray(schema.fields)
            ? schema.fields.filter((field): field is string => typeof field === "string")
            : [],
        }); });
    },
    async declareAppSchema(appId, schema, intent) {
      const local = schema as unknown as SchemaDefinition;
      await requireOwnedSetup();
      schema = canonicalSchema(local) as unknown as Record<string,unknown>;
      const { status, body } = await callJson("POST", "/api/apps/declare-schema", {
        app_id: appId,
        schema,
        ...(intent ? { intent } : {}),
      });
      if (status !== 200) throw mapNodeError(status, body, "/api/apps/declare-schema");
      const binding=ownedDeclaration(body,local.name);
      const b=payload(body);
      const canonical=binding.runtime;
      const schemaName=String(b.schema_name);
      const resolution=String(b.resolution ?? "");
      if (intent === "check" && (b.intent !== "check" || b.dry_run !== true)) {
        throw new Error("The node did not confirm a read-only schema check.");
      }
      if (!intent) Object.assign(fieldProfiles, profilesFor(local, [canonical, schemaName]));
      return {
        app_id: typeof b.app_id === "string" ? b.app_id : appId,
        schema: schemaName,
        canonical,
        identity:binding.identity,
        resolution,
        decision: typeof b.decision === "string" ? b.decision : undefined,
      };
    },
    async createRecord(op) {
      await verifyBindings();
      return writeRecords(callJson, [{ ...op, mutationType: "create" }], mapNodeError);
    },
    async updateRecord(op) {
      await verifyBindings();
      return writeRecords(callJson, [{ ...op, mutationType: "update" }], mapNodeError);
    },
    async mutateBatch(ops) {
      if (!ops.length) return;
      await verifyBindings();
      return writeRecords(callJson, ops, mapNodeError);
    },
    async queryAll({ schemaHash, filter, pageSize }) {
      if (!filter) throw new Error("A query requires known keys.");
      await verifyBindings();
      const limit = Math.min(1000, Math.max(1, pageSize ?? 100));
      const rows: QueryRow[] = [];
      const seenKeys = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: unknown;
      for (let page = 0; page < 1000; page++) {
        const requestBody = { schema_name: schemaHash, filter, limit, ...(cursor === undefined ? {} : { cursor }) };
        const response = await callJson("POST", "/api/query", requestBody);
        if (response.status !== 200) throw mapNodeError(response.status, response.body, "/api/query");
        const result = readPage(response.body, filter);
        for (const row of result.rows) {
          const id = coordinateId(schemaHash, row.key);
          if (seenKeys.has(id)) throw new Error("The query returned the same key on multiple pages.");
          seenKeys.add(id);
          rows.push(row);
        }
        if (rows.length > QUERY_MAX_ROWS) throw new Error("The query exceeds its complete-result limit.");
        if (!result.hasMore) return { ok: true, results: rows, total_count: rows.length, returned_count: rows.length };
        const next = result.cursor;
        const encoded = JSON.stringify(next);
        if (next === undefined || next === null || next === "" || seenCursors.has(encoded)) {
          throw new Error("The query lacks a fresh continuation cursor.");
        }
        seenCursors.add(encoded);
        cursor = next;
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

function mapNodeError(status: number, body: unknown, path: string): FsituationsError {
  const code = bodyError(body) ?? `http_${status}`;
  const message = bodyMessage(body) ?? `LastDB node ${path} failed with HTTP ${status}${rawBodySuffix(body)}.`;
  return new FsituationsError({ code, message });
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
