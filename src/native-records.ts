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
};

export class RecordConflict extends Error {
  constructor(detail?: string) {
    super(
      detail
        ? `The records changed during the operation. Read them again before retrying. ${detail}`
        : "The records changed during the operation. Read them again before retrying.",
    );
    this.name = "RecordConflict";
  }
}

type Call = (method: "POST", path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
type NodeError = (status: number, body: unknown, path: string) => Error;
const REVISION = /^[a-f0-9]{64}$/;
const QUERY_BATCH_LIMIT = 64;
const QUERY_BATCH_PARALLELISM = 2;
export const WRITE_BATCH_LIMIT = 200;

const WRITE_CONFLICT_ATTEMPTS = 16;

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
  if (!Array.isArray(result.records) || !(result.next_cursor === null || typeof result.next_cursor === "string")) {
    throw new Error("LastDB did not confirm a complete record page.");
  }
  const rows = result.records.flatMap((value: unknown) => {
    if (!isObject(value) || !isKey(value.key) || !isObject(value.record) ||
        typeof value.revision !== "string" || !REVISION.test(value.revision) ||
        !(value.file === null || isObject(value.file))) {
      throw new Error("LastDB returned a malformed or out-of-range record.");
    }
    // The app's ranges have an exclusive end; the API includes its end key.
    const span = object(filter.HashRangeRange);
    if (span.hash === value.key.hash && span.end === value.key.range) return [];
    if (!filterCovers(filter, value.key)) throw new Error("LastDB returned an out-of-range record.");
    return [{ fields: value.record, key: value.key, revision: value.revision,
      alternates: {}, metadata: value.file === null ? null : { file: value.file } }];
  });
  return { rows, hasMore: result.next_cursor !== null, cursor: result.next_cursor };
}

export function keyedRead(schema: string, filter: QueryFilter, limit: number, cursor?: unknown): Fields {
  const exact = object(filter.HashRangeKey);
  const span = object(filter.HashRangeRange);
  let selection: Fields;
  if (typeof filter.HashKey === "string") selection = { range: { hash: filter.HashKey } };
  else if (typeof exact.hash === "string" && (exact.range === null || typeof exact.range === "string")) {
    selection = { key: exact };
  } else if (typeof span.hash === "string" && typeof span.start === "string" && typeof span.end === "string") {
    selection = { range: span };
  } else throw new Error("A read requires known keys or a bounded range.");
  return { schema, ...selection, limit, ...(cursor === undefined ? {} : { cursor }) };
}

export function readResults(body: unknown, count: number): unknown[] {
  const result = payload(body);
  if (!Array.isArray(result.results) || result.results.length !== count) {
    throw new Error("LastDB did not confirm every requested read.");
  }
  for (const item of result.results) {
    if (!isObject(item) || item.error) throw new Error("LastDB refused a requested read.");
  }
  return result.results;
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
  const path = "/v1/read";
  const filters = ops.map((op) => ({ HashRangeKey: opKey(op) }));
  const reads = ops.map((op, i) => keyedRead(op.schemaHash, filters[i]!, 2));
  const { status, body } = await call("POST", path, { reads });
  if (status !== 200) throw mapError(status, body, path);
  return readResults(body, reads.length).map((item, index) => {
    const page = readPage(item, filters[index]!);
    if (page.hasMore || page.rows.length > 1 ||
        (page.rows[0] && page.rows[0].key.range !== opKey(ops[index]!).range)) {
      throw new Error("LastDB did not confirm an exact preimage.");
    }
    return page.rows[0] ?? null;
  });
}

function nativeOperation(op: BatchMutationOp, current: QueryRow | null) {
  if (current && op.mutationType === "create") throw new RecordConflict();
  if (!current && op.mutationType === "delete") return null;
  const key = opKey(op);
  if (op.mutationType === "delete") {
    return { schema: op.schemaHash, op: "delete", key, revision: current!.revision };
  }
  return {
    schema: op.schemaHash,
    op: current ? "replace" : "create",
    key,
    record: { ...current?.fields, ...op.fields },
    ...(current ? { revision: current.revision } : {}),
  };
}

function conflictDetail(body: Fields): string {
  const key = body.key === undefined ? "" : JSON.stringify(body.key);
  return [body.schema, key, body.expected, body.actual].filter((part) => part !== undefined && part !== "").join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function commitWrite(call: Call, ops: BatchMutationOp[], mapError: NodeError, ids: string[]): Promise<void> {
  const unread = ops.filter((op) => op.preimage === undefined && op.mutationType !== "create");
  const reads = await readPreimages(call, unread, mapError);
  let index = 0;
  const mutations = ops.map((op, i) => {
    const current = op.preimage === undefined && op.mutationType !== "create" ? reads[index++]! : op.preimage ?? null;
    if (current && coordinateId(op.schemaHash, current.key) !== ids[i]) throw new Error("A write preimage names a different key.");
    return nativeOperation(op, current);
  }).filter((op) => op !== null);
  if (mutations.length === 0) return;

  const path = "/v1/write";
  let response: Awaited<ReturnType<Call>>;
  try {
    response = await call("POST", path, { mutations });
  } catch (cause) {
    throw new Error("LastDB did not confirm the write outcome. Read the records before retrying.", { cause });
  }
  const result = payload(response.body);
  if (response.status === 409 && object(result.error).code === "conflict") {
    throw new RecordConflict(conflictDetail(object(result.error)));
  }
  if (response.status >= 500) throw new Error("LastDB did not confirm the write outcome. Read the records before retrying.");
  if (response.status !== 200) throw mapError(response.status, response.body, path);
  const revisions = result.revisions;
  if (result.written !== mutations.length || !Array.isArray(revisions) || revisions.length !== mutations.length ||
      revisions.some((revision) => typeof revision !== "string" || !REVISION.test(revision))) {
    throw new Error("LastDB did not confirm every durable write. Read the records before retrying.");
  }
}

export async function writeRecords(call: Call, ops: BatchMutationOp[], mapError: NodeError): Promise<void> {
  if (ops.length === 0) return;
  if (ops.length > WRITE_BATCH_LIMIT) throw new Error(`One atomic write may contain at most ${WRITE_BATCH_LIMIT} records.`);
  const ids = ops.map((op) => coordinateId(op.schemaHash, opKey(op)));
  if (new Set(ids).size !== ids.length) throw new Error("An atomic write must name each record once.");
  for (let attempt = 0; attempt < WRITE_CONFLICT_ATTEMPTS; attempt++) {
    try {
      // The first attempt keeps a preimage the caller already read. A conflict
      // means that preimage is stale: drop it and read the live revision.
      // Concurrent situation upserts all create one history-day marker. The
      // loser has to replace the winner's marker instead of creating it again.
      const pending = attempt === 0 ? ops : ops.map((op) => ({ ...op, preimage: undefined }));
      await commitWrite(call, pending, mapError, ids);
      return;
    } catch (error) {
      if (!(error instanceof RecordConflict) || attempt + 1 === WRITE_CONFLICT_ATTEMPTS) throw error;
      await sleep(10 * (attempt + 1) + Math.floor(Math.random() * 25));
    }
  }
}
