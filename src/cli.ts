#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

import pkg from "../package.json" with { type: "json" };
import { FsituationsError, newNodeClient, type NodeClient } from "./client.ts";
import {
  ConfigInvalidError,
  ConfigMissingError,
  CONFIG_VERSION,
  defaultConfigPath,
  resolveSocketPath,
  writeConfig,
  type Config,
} from "./config.ts";
import { loadCtx } from "./context.ts";
import {
  parseFieldProjection,
  printFieldProjection,
  type FieldProjectionSource,
} from "./field-projection.ts";
import {
  activeSituations,
  listSituations,
  preflight,
  requireSituation,
  upsertSituation,
  type Situation,
  type SituationInput,
} from "./record.ts";
import { OWNER_APP_ID, situationSchema } from "./schemas.ts";

export const TOP_HELP = `situations — current operational posture over LastDB

Usage:
  situations <command> [options]

Commands:
  init                 write ~/.situations/config.json from node/schema details
  schema               print the Situation schema JSON for publishing/loading
  put <json-file|- >   create/update a situation from JSON
  list                 list active/current situations (--all, --json, --field)
  show <slug>          show one situation (--json, --field)
  preflight            check whether an action is blocked (--action plus scope)
  version              print version
  help                 print this help

Common flags:
  --json               machine-readable output
  --field <a,b,c>      project fields as plain tab-separated text — one row per
                       situation, missing field → empty. Use this instead of
                       piping --json into python/node to pull one field. Common
                       fields: slug, status, severity, title, current_phase,
                       scope_repos (arrays join with ,).
  --config <path>      config path (else $SITUATIONS_CONFIG, $FSITUATIONS_CONFIG, or ~/.situations/config.json)

Examples:
  situations schema
  situations put examples/forge-ci-containment.json
  situations list --field slug,status,severity
  situations preflight --file examples/forge-ci-containment.json --action enable-ci --repo EdgeVector/fold
  situations preflight --action enable-ci --repo EdgeVector/fold --field slug,reason

Compatibility: fsituations remains an alias during the migration.`;

function usageFor(command: string): string {
  switch (command) {
    case "init":
      return `situations init

Options:
  --node-url <url>             node identity URL (default http://127.0.0.1:9001)
  --schema-service-url <url>   schema service URL kept for diagnostics
  --node-socket-path <path>    unix socket path (default ~/.lastdb/data/folddb.sock)
  --user-hash <hash>           user hash; if omitted, asks node /api/auto_identity
  --schema-hash <hash>         canonical hash for fsituations/Situation
  --config <path>              write config path

If --schema-hash is omitted, init asks the node for loaded schemas and resolves
the loaded fsituations/Situation schema. If missing, publish/load the schema
printed by \`situations schema\`, then rerun init.`;
    case "put":
      return `situations put <json-file|->

Creates or updates one situation. The JSON keys mirror the Situation record:
slug, title, status, severity, scope_repos, phases, blocked_actions, etc.`;
    case "list":
      return `situations list [--all] [--json] [--field <a,b,c>]

Options:
  --all                include resolved/expired situations, not just active
  --json               print the full situations array as JSON
  --field <a,b,c>      project fields as plain tab-separated text (one row per
                       situation). Prefer this over \`--json | python -c ...\`.
                       Common fields: slug, status, severity, title,
                       current_phase, scope_repos (arrays join with ,).

Examples:
  situations list --field slug,status,severity
  situations list --all --field slug,status`;
    case "show":
      return `situations show <slug> [--json] [--field <a,b,c>]

Options:
  --json               print the full situation as JSON
  --field <a,b,c>      project fields as plain tab-separated text (one row).
                       Common fields: slug, status, severity, title,
                       current_phase, scope_repos (arrays join with ,).

Example:
  situations show forge-ci-containment --field slug,current_phase`;
    case "preflight":
      return `situations preflight --action <action> [scope]

Scope options:
  --repo <owner/name>
  --system <name>
  --routine <name>
  --automation <name>
  --file <json-file>  check one JSON situation file instead of LastDB
  --json               print the full preflight result as JSON
  --field <a,b,c>     project the blocking situations as plain tab-separated
                      text (one row per block; nothing when allowed). Fields
                      include the situation fields plus reason, action, message.
                      Prefer this over \`--json | python -c ...\`.

Examples:
  situations preflight --action enable-ci --repo EdgeVector/fold --field slug,reason
  situations preflight --action enable-ci --repo EdgeVector/fold --json`;
    default:
      return TOP_HELP;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command = "help", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(rest[0] ? usageFor(rest[0]) : TOP_HELP);
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-V") {
    console.log(pkg.version);
    return 0;
  }

  switch (command) {
    case "schema":
      return schemaCmd(rest);
    case "init":
      return await initCmd(rest);
    case "put":
      return await putCmd(rest);
    case "list":
      return await listCmd(rest);
    case "show":
      return await showCmd(rest);
    case "preflight":
      return await preflightCmd(rest);
    default:
      throw new FsituationsError({
        code: "unknown_command",
        message: `Unknown command "${command}".`,
        hint: "Run `situations help`.",
      });
  }
}

function schemaCmd(rest: string[]): number {
  const parsed = parseArgs({
    args: rest,
    options: { json: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } },
    allowPositionals: false,
  });
  if (parsed.values.help) {
    console.log("situations schema -- print the Situation schema JSON");
    return 0;
  }
  if (parsed.values.json) {
    console.log(JSON.stringify(situationSchema, null, 2));
  } else {
    console.log(JSON.stringify(situationSchema, null, 2));
  }
  return 0;
}

async function initCmd(rest: string[]): Promise<number> {
  const parsed = parseArgs({
    args: rest,
    options: {
      "node-url": { type: "string", default: "http://127.0.0.1:9001" },
      "schema-service-url": { type: "string", default: "" },
      "node-socket-path": { type: "string" },
      "user-hash": { type: "string" },
      "schema-hash": { type: "string" },
      config: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (parsed.values.help) {
    console.log(usageFor("init"));
    return 0;
  }

  const cfgPath = parsed.values.config ?? defaultConfigPath();
  const nodeUrl = parsed.values["node-url"] ?? "http://127.0.0.1:9001";
  const nodeSocketPath = parsed.values["node-socket-path"];
  const userHash = parsed.values["user-hash"] ?? "";
  const node = newNodeClient({
    baseUrl: nodeUrl,
    userHash,
    socketPath: resolveSocketPath(nodeSocketPath ? { nodeSocketPath } : undefined),
  });
  const identity = userHash ? { provisioned: true as const, userHash } : await node.autoIdentity();
  if (!identity.provisioned) {
    throw new FsituationsError({
      code: "missing_identity",
      message: "Could not resolve a LastDB user identity.",
      hint: "Pass --user-hash or provision the local node before running init.",
    });
  }

  const schemaHash = parsed.values["schema-hash"] ?? (await resolveLoadedSituationHash(node));
  if (!schemaHash) {
    throw new FsituationsError({
      code: "schema_not_loaded",
      message: "No loaded fsituations/Situation schema was found on the node.",
      hint: "Publish/load the schema from `situations schema --json`, or pass --schema-hash.",
    });
  }

  const cfg: Config = {
    configVersion: CONFIG_VERSION,
    nodeUrl,
    schemaServiceUrl: parsed.values["schema-service-url"] ?? "",
    userHash: identity.userHash,
    schemaHashes: { situation: schemaHash },
    ...(nodeSocketPath ? { nodeSocketPath } : {}),
  };
  writeConfig(cfg, cfgPath);
  const result = { config: cfgPath, schemaHash, userHash: identity.userHash };
  console.log(parsed.values.json ? JSON.stringify(result, null, 2) : `wrote ${cfgPath}`);
  return 0;
}

async function resolveLoadedSituationHash(node: NodeClient): Promise<string | null> {
  const loaded = await node.listSchemas();
  const candidates = loaded.filter(
    (schema) =>
      schema.owner_app_id === OWNER_APP_ID &&
      schema.descriptive_name === situationSchema.schema.descriptive_name,
  );
  const full = candidates.find((schema) =>
    situationSchema.schema.fields.every((field) => schema.fields.includes(field)),
  );
  return full?.name ?? candidates[0]?.name ?? null;
}

async function putCmd(rest: string[]): Promise<number> {
  const parsed = parseArgs({
    args: rest,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (parsed.values.help) {
    console.log(usageFor("put"));
    return 0;
  }
  const file = parsed.positionals[0];
  if (!file) {
    throw new FsituationsError({
      code: "missing_input",
      message: "Missing JSON file path.",
      hint: "Use `situations put <file>` or `situations put -` for stdin.",
    });
  }
  const body = file === "-" ? await new Response(Bun.stdin.stream()).text() : readFileSync(file, "utf8");
  const input = JSON.parse(body) as SituationInput;
  const { cfg, node } = loadCtx({ configPath: parsed.values.config });
  const result = await upsertSituation(node, cfg, input);
  if (parsed.values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.action} ${result.situation.slug}`);
  }
  return 0;
}

async function listCmd(rest: string[]): Promise<number> {
  const parsed = parseArgs({
    args: rest,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      field: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (parsed.values.help) {
    console.log(usageFor("list"));
    return 0;
  }
  const fields = parseFieldProjection(parsed.values.field);
  const { cfg, node } = loadCtx({ configPath: parsed.values.config });
  const situations = await listSituations(node, cfg);
  const visible = parsed.values.all ? situations : activeSituations(situations);
  if (fields.length > 0) {
    printFieldProjection(visible as unknown as FieldProjectionSource[], fields, (line) =>
      console.log(line),
    );
  } else if (parsed.values.json) {
    console.log(JSON.stringify(visible, null, 2));
  } else {
    console.log(renderList(visible));
  }
  return 0;
}

async function showCmd(rest: string[]): Promise<number> {
  const parsed = parseArgs({
    args: rest,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      field: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (parsed.values.help) {
    console.log(usageFor("show"));
    return 0;
  }
  const fields = parseFieldProjection(parsed.values.field);
  const slug = parsed.positionals[0];
  if (!slug) throw new FsituationsError({ code: "missing_slug", message: "Missing situation slug." });
  const { cfg, node } = loadCtx({ configPath: parsed.values.config });
  const situation = await requireSituation(node, cfg, slug);
  if (fields.length > 0) {
    printFieldProjection([situation as unknown as FieldProjectionSource], fields, (line) =>
      console.log(line),
    );
  } else {
    console.log(parsed.values.json ? JSON.stringify(situation, null, 2) : renderSituation(situation));
  }
  return 0;
}

async function preflightCmd(rest: string[]): Promise<number> {
  const parsed = parseArgs({
    args: rest,
    options: {
      config: { type: "string" },
      action: { type: "string" },
      repo: { type: "string" },
      system: { type: "string" },
      routine: { type: "string" },
      automation: { type: "string" },
      file: { type: "string" },
      json: { type: "boolean", default: false },
      field: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (parsed.values.help) {
    console.log(usageFor("preflight"));
    return 0;
  }
  const fields = parseFieldProjection(parsed.values.field);
  const action = parsed.values.action;
  if (!action) {
    throw new FsituationsError({
      code: "missing_action",
      message: "Missing --action.",
      hint: "Example: situations preflight --action enable-ci --repo EdgeVector/fold",
    });
  }
  const situations = parsed.values.file
    ? [loadSituationFile(parsed.values.file)]
    : await listSituationsFromConfig(parsed.values.config);
  const result = preflight(situations, {
    action,
    repo: parsed.values.repo,
    system: parsed.values.system,
    routine: parsed.values.routine,
    automation: parsed.values.automation,
  });
  if (fields.length > 0) {
    // Project over the blocking situations: each row is the blocking
    // situation's fields plus the block's reason/action/message, so
    // `preflight --action X --field slug,reason` needs no JSON parse. No
    // blocks (allowed) prints nothing; exit code is unchanged.
    const rows: FieldProjectionSource[] = result.blocks.map((block) => ({
      ...(block.situation as unknown as FieldProjectionSource),
      reason: block.reason,
      action: block.action,
      message: block.message,
    }));
    printFieldProjection(rows, fields, (line) => console.log(line));
  } else if (parsed.values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderPreflight(result));
  }
  return result.ok ? 0 : 3;
}

async function listSituationsFromConfig(configPath?: string): Promise<Situation[]> {
  const { cfg, node } = loadCtx({ configPath });
  return await listSituations(node, cfg);
}

function loadSituationFile(path: string): Situation {
  const body = readFileSync(path, "utf8");
  return JSON.parse(body) as Situation;
}

function renderList(situations: Situation[]): string {
  if (situations.length === 0) return "No active situations.";
  const lines = situations.map((s) => {
    const phase = s.current_phase ? ` phase=${s.current_phase}` : "";
    return `${s.severity.toUpperCase()} ${s.status.padEnd(10)} ${s.slug}${phase}\n  ${s.title}`;
  });
  return lines.join("\n");
}

function renderSituation(s: Situation): string {
  const scopes = [
    s.scope_repos.length ? `repos=${s.scope_repos.join(",")}` : "",
    s.scope_systems.length ? `systems=${s.scope_systems.join(",")}` : "",
    s.scope_routines.length ? `routines=${s.scope_routines.join(",")}` : "",
    s.scope_automations.length ? `automations=${s.scope_automations.join(",")}` : "",
  ].filter(Boolean);
  const phases = s.phases.map((phase) => {
    const current = phase.slug === s.current_phase ? "*" : " ";
    return `${current} ${phase.slug} [${phase.state}] ${phase.label}\n    ${phase.summary}`;
  });
  return [
    `${s.title}`,
    `${s.severity.toUpperCase()} ${s.status} ${s.slug}`,
    s.summary,
    scopes.length ? `Scope: ${scopes.join(" ")}` : "Scope: global",
    s.blocked_actions.length ? `Blocked: ${s.blocked_actions.join(", ")}` : "",
    s.requires_human_clearance.length
      ? `Requires clearance: ${s.requires_human_clearance.join(", ")}`
      : "",
    s.preflight_message ? `Preflight: ${s.preflight_message}` : "",
    phases.length ? `Phases:\n${phases.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderPreflight(result: ReturnType<typeof preflight>): string {
  if (result.ok) return `OK: ${result.checked.action}`;
  return result.blocks
    .map((block) => {
      const label =
        block.reason === "blocked" ? "BLOCKED" : "REQUIRES HUMAN CLEARANCE";
      return `${label}: ${block.action} by ${block.situation.slug}\n  ${block.message}`;
    })
    .join("\n");
}

main(Bun.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (
      err instanceof FsituationsError ||
      err instanceof ConfigMissingError ||
      err instanceof ConfigInvalidError
    ) {
      console.error(`situations: ${err.message}`);
      if (err instanceof FsituationsError && err.hint) console.error(`hint: ${err.hint}`);
      process.exit(err instanceof FsituationsError && err.code.startsWith("missing") ? 2 : 1);
    }
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
