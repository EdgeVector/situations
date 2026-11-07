import type { NodeClient } from "./client.ts";
import { coordinateId, filterCovers, opKey, RecordConflict, type BatchMutationOp, type QueryFilter, type QueryRow } from "./native-records.ts";

type Observation = { filter: QueryFilter; rows: Map<string, QueryRow> };
const scopedClients = new WeakSet<NodeClient>();
const MAX_ATTEMPTS = 3;

function observedPreimage(op: BatchMutationOp, observations: Observation[]): QueryRow | null | undefined {
  const key = opKey(op);
  const id = coordinateId(op.schemaHash, key);
  let preimage: QueryRow | null | undefined = op.preimage;
  for (const { filter, rows } of observations) {
    if (!filterCovers(filter, key)) continue;
    const row = rows.get(id) ?? null;
    if (preimage !== undefined && preimage?.revision !== row?.revision) throw new RecordConflict();
    preimage = row;
  }
  return preimage;
}

/**
 * Retain the actual record or absence that produced each edit, including
 * index and marker edits. Retry the whole calculation only after a definite
 * revision conflict, and never after any preceding batch was accepted.
 */
export async function withRecordWrite<T>(node: NodeClient, run: (scoped: NodeClient) => Promise<T>): Promise<T> {
  if (scopedClients.has(node)) return run(node);
  for (let attempt = 1; ; attempt++) {
    let accepted = false;
    const observed = new Map<string, Observation[]>();
    const scoped: NodeClient = {
      ...node,
      async queryAll(opts) {
        const result = await node.queryAll(opts);
        if (opts.filter) {
          const { schemaHash, filter } = opts;
          const rows = new Map(result.results.map((row) => [coordinateId(schemaHash, row.key), row]));
          const prior = observed.get(schemaHash);
          const observation = { filter, rows };
          if (prior) prior.push(observation);
          else observed.set(schemaHash, [observation]);
        }
        return result;
      },
      async mutateBatch(ops) {
        await node.mutateBatch(ops.map((op) => ({
          ...op,
          preimage: observedPreimage(op, observed.get(op.schemaHash) ?? []),
        })));
        if (ops.length) accepted = true;
      },
    };
    scopedClients.add(scoped);
    try {
      return await run(scoped);
    } catch (error) {
      if (!(error instanceof RecordConflict) || accepted || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
}
