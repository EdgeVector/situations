import { canonicalProfilesForHashes } from "./init-schema.ts";
import { newNodeClient, type NodeClient, type Verbose } from "./client.ts";
import { readConfig, resolveSocketPath, type Config } from "./config.ts";

export type Ctx = {
  cfg: Config;
  node: NodeClient;
};

export function loadCtx(opts: { configPath?: string; verbose?: Verbose } = {}): Ctx {
  const cfg = readConfig(opts.configPath);
  const node = newNodeClient({
    baseUrl: cfg.nodeUrl,
    schemaFieldAliases: canonicalProfilesForHashes(cfg.schemaHashes),
    schemaIdentitiesByAddress: Object.fromEntries(
      Object.entries(cfg.schemaHashes).map(([key, address]) => [address, cfg.schemaIdentities![key]!]),
    ),
    userHash: cfg.userHash,
    verbose: opts.verbose,
    socketPath: resolveSocketPath(cfg),
  });
  return { cfg, node };
}
