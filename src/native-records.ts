import { object, payload } from "./schema-mode.ts";

type Fields = Record<string, unknown>;
export type RecordKey = { hash: string; range: string | null };
export type QueryRow = {
  fields: Fields;
  key: RecordKey;
  revision: string;
  alternates: Record<string, RecordKey | null>;
  metadata: Fields | null;
};
export type QueryFilter = Record<string, unknown>;

export type BatchMutationOp = {
  mutationType: "create" | "update" | "delete";
  schemaHash: string;
  keyHash: string;
  keyRange?: string;
  fields: Fields;
  /** The revision or absence used to derive this write, when already read. */
  preimage?: QueryRow | null;
  /** Legacy seed: leave a current record alone if one already exists. */
  seedIfAbsent?: boolean;
};

export class RecordConflict extends Error {
  constructor() {
    super("The records changed during the operation. Read them again before retrying.");
    this.name = "RecordConflict";
  }
}

type Call = (method: "POST", path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
type NodeError = (status: number, body: unknown, path: string) => Error;
const REVISION = /^[a-f0-9]{64}$/;
const QUERY_BATCH_LIMIT = 64;
const QUERY_BATCH_PARALLELISM = 2;
export const WRITE_BATCH_LIMIT = 200;

const isObject = (value: unknown): value is Fields => value !== null && typeof value === "object" && !Array.isArray(value);
const isKey = (value: unknown): value is RecordKey => isObject(value) && typeof value.hash === "string" &&
  value.hash.length > 0 && (value.range === null || typeof value.range === "string");

export function opKey(op: BatchMutationOp): RecordKey {
  return { hash: op.keyHash, range: op.keyRange ?? null };
}

export function coordinateId(schema: string, key: RecordKey): string {
  return JSON.stringify([schema, key.hash, key.range]);
}

const compareText = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Primary coordinate coverage for the keyed predicates this app sends. */
export function filterCovers(filter: QueryFilter, key: RecordKey): boolean {
  if (typeof filter.HashKey === "string") return filter.HashKey === key.hash;
  const exact = object(filter.HashRangeKey);
  if (exact.hash === key.hash && exact.range === key.range) return true;
  if (Array.isArray(filter.HashRangeKeys)) {
    return filter.HashRangeKeys.some((pair) => Array.isArray(pair) && pair[0] === key.hash && pair[1] === (key.range ?? ""));
  }
  const span = object(filter.HashRangeRange);
  return span.hash === key.hash && key.range !== null &&
    typeof span.start === "string" && typeof span.end === "string" &&
    compareText(key.range, span.start) >= 0 && compareText(key.range, span.end) < 0;
}

export function readPage(body: unknown, filter: QueryFilter): { rows: QueryRow[]; hasMore: boolean; cursor: unknown } {
  const result = payload(body);
  if (result.ok !== true || typeof result.has_more !== "boolean" || !Array.isArray(result.results) ||
      result.returned_count !== result.results.length) throw new Error("LastDB did not confirm a complete record page.");
  const rows = result.results.map((value: unknown) => {
    if (!isObject(value) || !isKey(value.key) || !isObject(value.fields) ||
        typeof value.revision !== "string" || !REVISION.test(value.revision) ||
        !isObject(value.alternates) || !Object.values(value.alternates).every((alternate) => alternate === null || isKey(alternate)) ||
        !(value.metadata === null || isObject(value.metadata)) || !filterCovers(filter, value.key)) {
      throw new Error("LastDB returned a malformed or out-of-range record.");
    }
    return value as QueryRow;
  });
  return { rows, hasMore: result.has_more, cursor: result.next_cursor };
}

async function readPreimages(call: Call, ops: BatchMutationOp[], mapError: NodeError): Promise<(QueryRow | null)[]> {
  const chunks: BatchMutationOp[][] = [];
  for (let start = 0; start < ops.length; start += QUERY_BATCH_LIMIT) chunks.push(ops.slice(start, start + QUERY_BATCH_LIMIT));
  const all: (QueryRow | null)[] = [];
  for (let start = 0; start < chunks.length; start += QUERY_BATCH_PARALLELISM) {
    const replies = await Promise.all(chunks.slice(start, start + QUERY_BATCH_PARALLELISM).map((chunk) => readChunk(call, chunk, mapError)));
    for (const reply of replies) all.push(...reply);
  }
  return all;
}

async function readChunk(call: Call, ops: BatchMutationOp[], mapError: NodeError): Promise<(QueryRow | null)[]> {
  const path = "/api/queries/batch";
  const queries = ops.map((op) => ({
    schema_name: op.schemaHash,
    filter: op.keyRange === undefined ? { HashKey: op.keyHash } : { HashRangeKey: opKey(op) },
    limit: 2,
  }));
  const { status, body } = await call("POST", path, { queries });
  if (status !== 200) throw mapError(status, body, path);
  const result = payload(body);
  if (result.ok !== true || result.count !== queries.length || !Array.isArray(result.results) ||
      result.results.length !== queries.length) throw new Error("LastDB did not confirm every preimage read.");
  return queries.map((query, index) => {
    const item = object((result.results as unknown[])[index]);
    if (typeof item.status === "number" && item.status !== 200) throw mapError(item.status, item.response, "/api/query");
    if (item.status !== 200) throw new Error("LastDB did not confirm a preimage read.");
    const page = readPage(item.response, query.filter);
    if (page.hasMore || page.rows.length > 1 ||
        (page.rows[0] && page.rows[0].key.range !== opKey(ops[index]!).range)) {
      throw new Error("LastDB did not confirm an exact preimage.");
    }
    return page.rows[0] ?? null;
  });
}

function nativeOperation(op: BatchMutationOp, current: QueryRow | null) {
  if (current && op.seedIfAbsent) return null;
  if (current && op.mutationType === "create") throw new RecordConflict();
  if (!current && op.mutationType === "delete") return null;
  const deleting = op.mutationType === "delete";
  const metadata = deleting ? null : current?.metadata;
  return {
    type: "mutation",
    schema: op.schemaHash,
    key_value: opKey(op),
    mutation_type: deleting ? "delete" : current ? "replace" : "create",
    record: deleting ? {} : { ...current?.fields, ...op.fields },
    alternates: current?.alternates ?? {},
    expected: current ? { type: "revision", revision: current.revision } : { type: "absent" },
    source_file_name: metadata?.source_file_name ?? null,
    metadata: metadata?.metadata ?? null,
    file: metadata?.file ?? null,
    durability: "durable",
  };
}

export async function writeRecords(call: Call, ops: BatchMutationOp[], mapError: NodeError): Promise<void> {
  if (ops.length === 0) return;
  if (ops.length > WRITE_BATCH_LIMIT) throw new Error(`One atomic write may contain at most ${WRITE_BATCH_LIMIT} records.`);
  const ids = ops.map((op) => coordinateId(op.schemaHash, opKey(op)));
  if (new Set(ids).size !== ids.length) throw new Error("An atomic write must name each record once.");
  const unread = ops.filter((op) => op.preimage === undefined && op.mutationType !== "create");
  const reads = await readPreimages(call, unread, mapError);
  let index = 0;
  const mutations = ops.map((op, i) => {
    const current = op.preimage === undefined && op.mutationType !== "create" ? reads[index++]! : op.preimage ?? null;
    if (current && coordinateId(op.schemaHash, current.key) !== ids[i]) throw new Error("A write preimage names a different key.");
    return nativeOperation(op, current);
  }).filter((op) => op !== null);
  if (mutations.length === 0) return;

  const path = "/api/mutations/batch";
  let response: Awaited<ReturnType<Call>>;
  try {
    response = await call("POST", path, { mutations, convergence: "async" });
  } catch (cause) {
    throw new Error("LastDB did not confirm the write outcome. Read the records before retrying.", { cause });
  }
  const result = payload(response.body);
  if (response.status === 409 && result.error === "cas_conflict") throw new RecordConflict();
  if (response.status >= 500) throw new Error("LastDB did not confirm the write outcome. Read the records before retrying.");
  if (response.status !== 200) throw mapError(response.status, response.body, path);
  const operations = object(result.operations);
  const revisions = object(result.record_revisions);
  const mutationIds = result.mutation_ids;
  if (result.ok !== true || result.count !== mutations.length || result.durability !== "durable" ||
      operations.total !== mutations.length ||
      operations.created !== mutations.filter((op) => op.mutation_type === "create").length ||
      operations.updated !== mutations.filter((op) => op.mutation_type === "replace").length ||
      operations.deleted !== mutations.filter((op) => op.mutation_type === "delete").length ||
      !Array.isArray(mutationIds) || mutationIds.length !== mutations.length || new Set(mutationIds).size !== mutations.length ||
      Object.keys(revisions).length !== mutations.length ||
      mutationIds.some((id) => typeof id !== "string" || !id || !Object.hasOwn(revisions, id) ||
        typeof revisions[id] !== "string" || !REVISION.test(revisions[id]))) {
    throw new Error("LastDB did not confirm every durable write. Read the records before retrying.");
  }
}
