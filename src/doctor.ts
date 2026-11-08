// `situations doctor`: read-only checks of the index layout. It never writes.
//
// It answers two questions:
//   1. Are the IndexEntry and NoticeHistory schemas pinned and loaded?
//   2. Can every entry be read?

import type { NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { loadPartition, resolveLayout, type PartitionSpec } from "./index-entry.ts";
import { resolveLoadedLayoutHashes } from "./init-schema.ts";
import { NOTICE_DAYS_SPEC } from "./notice.ts";
import { ACTIVE_SPEC, SITUATION_DAYS_SPEC } from "./record.ts";

export type DoctorCheck = { name: string; status: "ok" | "warn" | "fail"; detail: string };

export async function runDoctor(node: NodeClient, cfg: Config): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const loaded = await resolveLoadedLayoutHashes(node);
  for (const [label, key] of [
    ["IndexEntry", "index_entry"],
    ["NoticeHistory", "notice_history"],
  ] as const) {
    const pinned = Boolean(cfg.schemaHashes[key]);
    const onNode = loaded[key] !== null;
    if (onNode && pinned) checks.push({ name: `schema ${label}`, status: "ok", detail: "loaded on the node and pinned in the config" });
    else if (onNode) checks.push({ name: `schema ${label}`, status: "warn", detail: "loaded on the node but not pinned in the config; run `situations init`" });
    else checks.push({ name: `schema ${label}`, status: "fail", detail: "not loaded on the node. Run `situations init`" });
  }

  const layout = await resolveLayout(node, cfg);
  if (!layout) return checks;

  const gates: ReadonlyArray<PartitionSpec<unknown>> = [ACTIVE_SPEC, SITUATION_DAYS_SPEC, NOTICE_DAYS_SPEC];
  for (const spec of gates) {
    const name = `partition ${spec.hash}`;
    try {
      const { entries } = await loadPartition(node, layout, spec);
      checks.push({ name, status: "ok", detail: `${entries.length} entries` });
    } catch (err) {
      checks.push({ name, status: "fail", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return checks;
}
