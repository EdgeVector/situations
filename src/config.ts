import { parseFieldAliases, type FieldAliasProfiles } from "./field-alias-transport.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { APP_SCHEMAS } from "./schema-layout.ts";
import { OWNER_APP_ID, type RecordType } from "./schemas.ts";

export const CONFIG_VERSION = 3;

export type Config = {
  schemaFieldAliases?: FieldAliasProfiles;
  configVersion: number;
  nodeUrl: string;
  schemaServiceUrl: string;
  userHash: string;
  /** Literal runtime addresses. Definition identities are separate. */
  schemaHashes: Record<string, string>;
  schemaIdentities?: Record<string,string>;
  nodeSocketPath?: string;
};

const SOCKET_FILE_NAME = "folddb.sock";


export function resolveSocketPath(cfg?: { nodeSocketPath?: string }): string {
  const envOverride = process.env.FOLDDB_SOCKET_PATH;
  if (envOverride && envOverride.length > 0) return envOverride;
  if (cfg?.nodeSocketPath && cfg.nodeSocketPath.length > 0) return cfg.nodeSocketPath;
  // The node home is `LASTDB_HOME` when it is set, else `~/.lastdb`, the same
  // rule as the node's own resolver.
  const homeOverride = process.env.LASTDB_HOME;
  const home = homeOverride && homeOverride.length > 0 ? homeOverride : join(homedir(), ".lastdb");
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

export function writeConfig(config: Config, path: string = defaultConfigPath(), expected?:string|null): void {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const current=existsSync(path)?readFileSync(path,"utf8"):null;
  if(expected!==undefined && current!==expected) throw new Error("The app config changed during the schema operation.");
  const temporary=`${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd=openSync(temporary,"wx",0o600);
  try { writeFileSync(fd,JSON.stringify(config,null,2)+"\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    if(expected!==undefined && (existsSync(path)?readFileSync(path,"utf8"):null)!==expected) throw new Error("The app config changed before publication.");
    renameSync(temporary,path);
    const parent=openSync(dirname(path),"r");
    try {fsyncSync(parent);} finally {closeSync(parent);}
  } finally { if(existsSync(temporary)) unlinkSync(temporary); }
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
  const schemaIdentities = parseIdentities(path, r.schemaIdentities);
  if (r.configVersion !== CONFIG_VERSION || Object.keys(schemaHashes).length !== APP_SCHEMAS.length ||
      !schemaIdentities || Object.keys(schemaIdentities).length !== APP_SCHEMAS.length ||
      APP_SCHEMAS.some(({ key, definition }) => schemaHashes[key] !== `${OWNER_APP_ID}/${definition.name}` || !Object.hasOwn(schemaIdentities, key))) {
    throw new ConfigInvalidError(path, "this config does not bind the native Situations schemas. Keep the old config and convert legacy data explicitly before switching to a native home.");
  }
  const schemaServiceUrl = typeof r.schemaServiceUrl === "string" ? r.schemaServiceUrl : "";
  const nodeSocketPath =
    typeof r.nodeSocketPath === "string" && r.nodeSocketPath.length > 0 ? r.nodeSocketPath : undefined;
  return {
    schemaFieldAliases:configFieldAliases(path, r.schemaFieldAliases),
    configVersion: CONFIG_VERSION,
    nodeUrl: r.nodeUrl as string,
    schemaServiceUrl,
    userHash: r.userHash as string,
    schemaHashes,
    schemaIdentities,
    ...(nodeSocketPath ? { nodeSocketPath } : {}),
  };
}

function configFieldAliases(path: string, input: unknown): FieldAliasProfiles | undefined {
  try { return parseFieldAliases(input); }
  catch (error) {
    throw new ConfigInvalidError(path, error instanceof Error ? error.message : String(error));
  }
}

/** An existing legacy or malformed config must never be silently replaced. */
export function readConfigForInit(path: string = defaultConfigPath()): Config | null {
  try { return readConfig(path); }
  catch (error) {
    if (error instanceof ConfigMissingError) return null;
    throw error;
  }
}

function parseIdentities(path:string,input:unknown):Record<string,string>|undefined {
  if(input===undefined)return undefined;
  if(!input || typeof input!=="object" || Array.isArray(input) || Object.values(input).some((value)=>typeof value!=="string" || !/^[a-f0-9]{64}$/.test(value))) {
    throw new ConfigInvalidError(path,"schemaIdentities must contain exact definition identities");
  }
  return {...input} as Record<string,string>;
}
