// `situations doctor`: read-only checks of the index layout. It never writes.
//
// It answers four questions an operator needs after an upgrade:
//   1. Are the IndexEntry and NoticeHistory schemas pinned and loaded?
//   2. Did each gate partition get copied from its legacy blob (a marker)?
//   3. Did an older binary write a legacy blob AFTER the copy (drift)? Its
//      entries are invisible to the new code until they are merged in; a read
//      merges them, but two binaries on one host are a rollout error.
//   4. Can every entry be read?

import type { NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { hasIndexSchema } from "./index-cache.ts";
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
    else checks.push({ name: `schema ${label}`, status: "fail", detail: "not loaded on the node: a `put` or `notice` fails and reads use the legacy blobs. Run `situations init`" });
  }

  const layout = await resolveLayout(node, cfg);
  if (!layout || !hasIndexSchema(cfg)) return checks;

  const gates: ReadonlyArray<PartitionSpec<unknown>> = [ACTIVE_SPEC, SITUATION_DAYS_SPEC, NOTICE_DAYS_SPEC];
  for (const spec of gates) {
    const name = `partition ${spec.hash}`;
    try {
      const { info, entries } = await loadPartition(node, cfg, layout, spec);
      const marker = info.markerComplete
        ? `copied at ${info.migratedAt} (${info.markerIds?.size ?? 0} ids)`
        : "no complete marker";
      const legacy =
        info.legacyUpdatedAt === null
          ? "no legacy row read"
          : `legacy row updated ${info.legacyUpdatedAt}${info.legacyEntries === null ? "" : ` with ${info.legacyEntries} entries`}`;
      const detail = `${entries.length} entries; ${marker}; ${legacy}`;
      if (info.drift) {
        checks.push({
          name,
          status: "fail",
          detail: `${detail}. The legacy row is NEWER than the copy: an older situations binary wrote it. Reads merge it, but run one binary (\`command -v situations\`)`,
        });
      } else if (info.missingListed.length > 0) {
        checks.push({
          name,
          status: "warn",
          detail: `${detail}. The marker lists ${info.missingListed.length} id(s) with no entry yet (first: ${info.missingListed[0]}); they are read from the legacy row and the record`,
        });
      } else if (!info.markerComplete && info.legacyEntries !== null && info.legacyEntries > 0) {
        checks.push({ name, status: "warn", detail: `${detail}. Not copied yet; the next read or write copies it` });
      } else {
        checks.push({ name, status: "ok", detail });
      }
    } catch (err) {
      checks.push({ name, status: "fail", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return checks;
}
