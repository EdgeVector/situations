import { parseFieldAliases, type FieldAliasProfiles } from "./field-alias-transport.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { RecordType } from "./schemas.ts";

export const CONFIG_VERSION = 1;

export type Config = {
  schemaFieldAliases?: FieldAliasProfiles;
  configVersion: number;
  nodeUrl: string;
  schemaServiceUrl: string;
  userHash: string;
  schemaHashes: Record<string, string>;
  nodeSocketPath?: string;
};

const SOCKET_FILE_NAME = "folddb.sock";

// Resolve the node data-home when no explicit socket/home override is set.
// The FoldDB→LastDB rebrand (node v0.15.1+) moved the brew/CLI node's data home
// from `~/.folddb` to `~/.lastdb`, while the legacy desktop app still uses
// `~/.folddb`. Prefer whichever default home has a LIVE control socket on disk
// (that's the node actually running), `~/.lastdb` first; fall back to directory
// existence, `~/.lastdb` first, so a pre-launch machine still points somewhere
// real. Mirrors fbrain's `resolveDefaultNodeHome` so all three CLIs derive the
// same root on a mixed-version machine.
function resolveDefaultNodeHome(base: string): string {
  const lastdb = join(base, ".lastdb");
  const folddb = join(base, ".folddb");
  if (existsSync(join(lastdb, "data", SOCKET_FILE_NAME))) return lastdb;
  if (existsSync(join(folddb, "data", SOCKET_FILE_NAME))) return folddb;
  if (existsSync(lastdb)) return lastdb;
  return folddb;
}

export function resolveSocketPath(cfg?: { nodeSocketPath?: string }): string {
  const envOverride = process.env.FOLDDB_SOCKET_PATH;
  if (envOverride && envOverride.length > 0) return envOverride;
  if (cfg?.nodeSocketPath && cfg.nodeSocketPath.length > 0) return cfg.nodeSocketPath;
  // `LASTDB_HOME`/`FOLDDB_HOME` remain explicit overrides; absent those, probe
  // for the live node home (prefers `~/.lastdb`) rather than hardcoding the
  // now-retired `~/.folddb` default.
  const homeOverride = process.env.LASTDB_HOME ?? process.env.FOLDDB_HOME;
  const home =
    homeOverride && homeOverride.length > 0 ? homeOverride : resolveDefaultNodeHome(homedir());
  return join(home, "data", SOCKET_FILE_NAME);
}

export function defaultConfigPath(): string {
  const newOverride = process.env.SITUATIONS_CONFIG;
  if (newOverride && newOverride.length > 0) return newOverride;
  const override = process.env.FSITUATIONS_CONFIG;
  if (override && override.length > 0) return override;
  const base = homedir();
  const primary = join(base, ".situations", "config.json");
  const compat = join(base, ".fsituations", "config.json");
  return existsSync(primary) || !existsSync(compat) ? primary : compat;
}

export class ConfigMissingError extends Error {
  constructor(path: string) {
    super(`Config not found at ${path}. Run \`situations init\` first.`);
    this.name = "ConfigMissingError";
  }
}

export class ConfigInvalidError extends Error {
  constructor(path: string, reason: string) {
    super(`Config at ${path} is invalid: ${reason}. Re-run \`situations init\`.`);
    this.name = "ConfigInvalidError";
  }
}

export function readConfig(path: string = defaultConfigPath()): Config {
  if (!existsSync(path)) throw new ConfigMissingError(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigInvalidError(path, `not valid JSON (${msg})`);
  }
  return assertConfigShape(path, parsed);
}

export function writeConfig(config: Config, path: string = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write a sibling temp file, then rename: another situations process reading
  // this config at the same moment sees the old file or the new one, never half.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function schemaHashFor(type: RecordType, cfg: { schemaHashes: Record<string, string> }): string {
  const hash = cfg.schemaHashes[type];
  if (!hash) {
    throw new ConfigInvalidError(defaultConfigPath(), `no canonical hash registered for type "${type}"`);
  }
  return hash;
}

function assertConfigShape(path: string, raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigInvalidError(path, "not an object");
  }
  const r = raw as Record<string, unknown>;
  for (const key of ["nodeUrl", "userHash"] as const) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      throw new ConfigInvalidError(path, `field "${key}" not a non-empty string`);
    }
  }
  const rawHashes = r.schemaHashes;
  if (typeof rawHashes !== "object" || rawHashes === null || Array.isArray(rawHashes)) {
    throw new ConfigInvalidError(path, `field "schemaHashes" must be an object`);
  }
  const schemaHashes: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHashes as Record<string, unknown>)) {
    if (typeof v !== "string" || v.length === 0) {
      throw new ConfigInvalidError(path, `schemaHashes["${k}"] is not a non-empty string`);
    }
    schemaHashes[k] = v;
  }
  const schemaServiceUrl = typeof r.schemaServiceUrl === "string" ? r.schemaServiceUrl : "";
  const nodeSocketPath =
    typeof r.nodeSocketPath === "string" && r.nodeSocketPath.length > 0 ? r.nodeSocketPath : undefined;
  return {
    schemaFieldAliases:configFieldAliases(path, r.schemaFieldAliases),
    configVersion: typeof r.configVersion === "number" ? r.configVersion : CONFIG_VERSION,
    nodeUrl: r.nodeUrl as string,
    schemaServiceUrl,
    userHash: r.userHash as string,
    schemaHashes,
    ...(nodeSocketPath ? { nodeSocketPath } : {}),
  };
}

function configFieldAliases(path: string, input: unknown): FieldAliasProfiles | undefined {
  try { return parseFieldAliases(input); }
  catch (error) {
    throw new ConfigInvalidError(path, error instanceof Error ? error.message : String(error));
  }
}

/** Init recovers the vocabulary mode from the node if the old config is invalid.
 * Other commands still use readConfig and fail on invalid configuration.
 */
export function readConfigForInit(path: string = defaultConfigPath()): Config | null {
  try { return readConfig(path); }
  catch (error) {
    if (error instanceof ConfigMissingError || error instanceof ConfigInvalidError) return null;
    throw error;
  }
}
