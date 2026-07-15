#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

import pkg from "../package.json" with { type: "json" };
import { FsituationsError, newNodeClient } from "./client.ts";
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
  rejectGlobalFleetScope,
  requireSituation,
  upsertSituation,
  type Situation,
  type SituationInput,
} from "./record.ts";
import {
  filterNotices,
  hasNoticeSchema,
  listNotices,
  normalizeNotice,
  renderNotice,
  renderNoticesList,
  requireNotice,
  upsertNotice,
  type NoticeInput,
} from "./notice.ts";
import { resolveOrDeclareSchemaHashes } from "./init-schema.ts";
import {
  deliverPostureStatus,
  publishPostureStatus,
  type DeliveryRecipient,
} from "./publish-status.ts";
import { noticeSchema, situationSchema } from "./schemas.ts";

type CaptureSentryException = (error: unknown, tags?: Record<string, string>) => Promise<void>;

export const TOP_HELP = `situations — current operational posture + agent-impact notices over LastDB

Usage:
  situations <command> [options]

Commands:
  init                 write ~/.situations/config.json (declares Situation + Notice schemas on Mini)
  schema               print Situation and/or Notice schema JSON
  put <json-file|- >   create/update a situation from JSON
  list                 list active/current situations (--all, --json, --field)
  show <slug>          show one situation (--json, --field)
  preflight            check whether an action is blocked (--action plus scope)
  notice               post a non-blocking agent-impact FYI notice
  notices              list recent notices (never blocks preflight)
  publish-status       write slim posture+notices snapshot to LastDB (--json)
  deliver-status       publish + stage a situations slice delivery; --approve sends it
  version              print version
  help                 print this help

Common flags:
  --json               machine-readable output
  --field <a,b,c>      project fields as plain tab-separated text — one row per
                       record, missing field → empty. Use this instead of
                       piping --json into python/node to pull one field.
  --config <path>      config path (else $SITUATIONS_CONFIG, $FSITUATIONS_CONFIG, or ~/.situations/config.json)

Notices are non-blocking: upgrades/restarts that other agents should treat as
context, not policy. Situation preflight is unchanged.

Examples:
  situations schema
  situations put examples/forge-ci-containment.json
  situations list --field slug,status,severity
  situations notice --title "LastDB upgraded to 0.22.8" --kind upgrade --system lastdbd
  situations notices --since 30m
  situations preflight --action enable-ci --repo EdgeVector/fold

Compatibility: fsituations remains an alias during the migration.`;

function usageFor(command: string): string {
  switch (command) {
    case "init":
      return `situations init

Options:
  --node-url <url>             loopback marker for local node (default http://127.0.0.1; transport is the Unix socket)
  --schema-service-url <url>   schema service URL kept for diagnostics
  --node-socket-path <path>    unix socket path (default ~/.lastdb/data/folddb.sock)
  --user-hash <hash>           user hash; if omitted, asks node /api/auto_identity
  --schema-hash <hash>         canonical hash for fsituations/Situation (legacy pin)
  --notice-schema-hash <hash>  canonical hash for fsituations/Notice
  --config <path>              write config path

If hashes are omitted, init asks the node for loaded fsituations schemas. On
LastDB Mini (POST /api/apps/declare-schema), missing schemas are declared
locally and pinned — Situation and Notice. On older nodes without that route,
publish/load from \`situations schema --json\`, then re-run init.`;
    case "put":
      return `situations put <json-file|-> [--allow-global-scope]

Creates or updates one situation. The JSON keys mirror the Situation record:
slug, title, status, severity, scope_repos, phases, blocked_actions, etc.

Scope rules (Tom 2026-07-14 — global fleet kill switch ban):
  - Do NOT set scope_routines / scope_automations to bare "*" for active
    situations. That skip-fences the entire routines fleet (pickup, dogfood,
    probes) and freezes shipping for unrelated incidents.
  - Prefer empty scope + blocked_actions (action preflight), or narrow globs
    (*dmg*, *cloud-sync*). See README "scope_routines is not a panic button".
  - --allow-global-scope: override only when the issue is truly fleet-wide
    (and after Discord needs-human). Default put REJECTS bare "*".`;
    case "list":
      return `situations list [--all] [--json] [--field <a,b,c>]

Options:
  --all                include resolved/expired situations, not just active
  --json               print the full situations array as JSON
  --field <a,b,c>      project fields as plain tab-separated text (one row per
                       situation). Prefer this over \`--json | python -c ...\`.
                       Common fields: slug, status, severity, title,
                       current_phase, scope_repos (arrays join with ,).

Human-readable list also prints a one-line banner when recent notices exist.

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
    case "notice":
      return `situations notice — post a non-blocking agent-impact FYI

Subcommands / forms:
  situations notice put <json-file|->
  situations notice show <slug> [--json] [--field ...]
  situations notice --title "..." --kind upgrade --system lastdbd [flags]

Flags (create form):
  --title <text>           required one-line headline
  --kind <k>               upgrade|restart|deploy|config|cutover|other (default other)
  --summary <text>         what happened / expected fallout
  --system <name>          repeatable; scope_systems
  --app <name>             repeatable; scope_apps
  --actor <id>             skill:… / agent:… / human
  --related-situation <s>  optional Situation slug
  --severity-hint <h>      info|warn (default info)
  --slug <slug>            optional; auto-generated if omitted
  --at <rfc3339>           event time (default now)
  --expires-at <rfc3339>   expiry (default at+24h)
  --expires-hours <n>      alternate TTL from --at
  --json

Notices never affect preflight. Use them so other agents can attribute flapping.

Examples:
  situations notice --title "LastDB upgraded to 0.22.8" --kind upgrade \\
    --system lastdbd --system primary-brain --actor skill:lastdb-safe-upgrade \\
    --summary "brew 0.22.7 → 0.22.8; brief socket blips expected ~10–15m"
  situations notice put examples/lastdb-upgrade-notice.json`;
    case "notices":
      return `situations notices — list recent non-blocking notices

Options:
  --since <dur>        only events with at >= now-dur (e.g. 30m, 2h, 1d)
  --system <name>      filter scope_systems
  --app <name>         filter scope_apps
  --kind <k>           filter kind
  --all                include expired
  --json
  --field <a,b,c>      TSV projection (common: slug,at,kind,title,scope_systems)

Examples:
  situations notices
  situations notices --since 30m --system lastdbd
  situations notices --field slug,at,kind,title`;
    case "schema":
      return `situations schema [--type situation|notice|all] [--json]

Print the schema payload(s) for publishing/loading. Default is both.`;
    case "publish-status":
      return `situations publish-status [--json] [--dry-run] [--since <dur>] [--notice-limit <n>]

Write a privacy-safe admin deliverable snapshot to the local LastDB Mini socket:
  - fsituations/SituationAdminSnapshot key posture-latest
  - fsituations/SituationAdminPosture per active/monitoring situation
  - fsituations/SituationAdminNotice per recent notice (default --since 24h)

Fields are intentionally slim (posture: slug/severity/status/summary/blocked_actions;
notices: kind/at/title/summary/systems). Full phases_json and preflight bodies are
never published.

Examples:
  situations publish-status --json
  situations publish-status --since 2h --notice-limit 20
  situations publish-status --dry-run --json`;
    case "deliver-status":
      return `situations deliver-status [options]

Publish the slim posture+notices slice, then stage a lastdb.slice.v1 delivery
to the admin kanban-consumer (or documented twin). Pass --approve to send.

Recipient keys are operational inputs (same bundle as kanban-consumer enroll).
Do not commit them:

  --recipient-pubkey / SITUATIONS_ADMIN_RECIPIENT_PUBKEY
  --messaging-public-key / SITUATIONS_ADMIN_MESSAGING_PUBLIC_KEY
  --messaging-pseudonym / SITUATIONS_ADMIN_MESSAGING_PSEUDONYM
  --recipient-name / SITUATIONS_ADMIN_RECIPIENT_NAME

Examples:
  situations deliver-status --dry-run --json
  situations deliver-status --max-records 50
  situations deliver-status --approve --max-records 50`;
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
    case "notice":
      return await noticeCmd(rest);
    case "notices":
      return await noticesCmd(rest);
    case "publish-status":
      return await publishStatusCmd(rest);
    case "deliver-status":
      return await deliverStatusCmd(rest);
    default:
      throw new FsituationsError({
        code: "unknown_command",
        message: `Unknown command "${command}".`,
        hint: "Run `situations help`.",
      });
  }
}

async function initCliSentry(): Promise<CaptureSentryException> {
  if (!process.env.OBS_SENTRY_DSN?.trim()) {
    return async () => {};
  }
  const sentry = await import("./observability/sentry.ts");
  await sentry.initSentry({
    service: "situations-cli",
    env: {
      ...process.env,
      OBS_SENTRY_RELEASE: process.env.OBS_SENTRY_RELEASE ?? `situations@${pkg.version}`,
    },
  });
  return sentry.captureSentryException;
}

function schemaCmd(rest: string[]): number {
  const parsed = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: false },
      type: { type: "string", default: "all" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (parsed.values.help) {
    console.log(usageFor("schema"));
    return 0;
  }
  const type = (parsed.values.type ?? "all").toLowerCase();
  let payload: unknown;
  if (type === "situation") payload = situationSchema;
  else if (type === "notice") payload = noticeSchema;
  else if (type === "all") payload = { situation: situationSchema, notice: noticeSchema };
  else {
    throw new FsituationsError({
      code: "invalid_type",
      message: `Unknown --type "${type}".`,
      hint: "Use situation, notice, or all.",
    });
  }
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

async function initCmd(rest: string[]): Promise<number> {
  const parsed = parseArgs({
    args: rest,
    options: {
      "node-url": { type: "string", default: "http://127.0.0.1" },
      "schema-service-url": { type: "string", default: "" },
      "node-socket-path": { type: "string" },
      "user-hash": { type: "string" },
      "schema-hash": { type: "string" },
      "notice-schema-hash": { type: "string" },
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
  const nodeUrl = parsed.values["node-url"] ?? "http://127.0.0.1";
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

  const declared = await resolveOrDeclareSchemaHashes(node, {
    quiet: Boolean(parsed.values.json),
  });
  const situationHash = parsed.values["schema-hash"] ?? declared.situation;
  const noticeHash = parsed.values["notice-schema-hash"] ?? declared.notice;

  if (!situationHash) {
    throw new FsituationsError({
      code: "schema_not_loaded",
      message: "No loaded fsituations/Situation schema was found on the node.",
      hint: "Publish/load the schema from `situations schema --type situation --json`, or pass --schema-hash.",
    });
  }

  const schemaHashes: Record<string, string> = { situation: situationHash };
  if (noticeHash) schemaHashes.notice = noticeHash;

  const cfg: Config = {
    configVersion: CONFIG_VERSION,
    nodeUrl,
    schemaServiceUrl: parsed.values["schema-service-url"] ?? "",
    userHash: identity.userHash,
    schemaHashes,
    ...(nodeSocketPath ? { nodeSocketPath } : {}),
  };
  writeConfig(cfg, cfgPath);
  const result = {
    config: cfgPath,
    schemaHash: situationHash,
    noticeSchemaHash: noticeHash ?? null,
    userHash: identity.userHash,
  };
  if (parsed.values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`wrote ${cfgPath}`);
    if (!noticeHash) {
      console.error(
        "warning: Notice schema not declared/loaded — `situations notices` will not work until re-init on Mini or pass --notice-schema-hash.",
      );
    }
  }
  return 0;
}

async function putCmd(rest: string[]): Promise<number> {
  const parsed = parseArgs({
    args: rest,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      "allow-global-scope": { type: "boolean", default: false },
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
  rejectGlobalFleetScope(input, { allowGlobal: Boolean(parsed.values["allow-global-scope"]) });
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
    const banner = await recentNoticesBanner(node, cfg);
    if (banner) console.log(banner);
    console.log(renderList(visible));
  }
  return 0;
}

async function recentNoticesBanner(
  node: ReturnType<typeof loadCtx>["node"],
  cfg: Config,
): Promise<string | null> {
  if (!hasNoticeSchema(cfg)) return null;
  try {
    const notices = filterNotices(await listNotices(node, cfg), { since: "2h" });
    if (notices.length === 0) return null;
    return `${notices.length} notice(s) in last 2h — run: situations notices --since 2h`;
  } catch {
    return null;
  }
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

async function noticeCmd(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(usageFor("notice"));
    return 0;
  }
  if (sub === "put") return await noticePutCmd(rest.slice(1));
  if (sub === "show") return await noticeShowCmd(rest.slice(1));

  // Create form with flags.
  const parsed = parseArgs({
    args: rest,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      title: { type: "string" },
      kind: { type: "string" },
      summary: { type: "string" },
      system: { type: "string", multiple: true },
      app: { type: "string", multiple: true },
      actor: { type: "string" },
      "related-situation": { type: "string" },
      "severity-hint": { type: "string" },
      slug: { type: "string" },
      at: { type: "string" },
      "expires-at": { type: "string" },
      "expires-hours": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (parsed.values.help) {
    console.log(usageFor("notice"));
    return 0;
  }
  if (!parsed.values.title) {
    throw new FsituationsError({
      code: "missing_title",
      message: "Missing --title (or use `situations notice put <file>`).",
      hint: 'Example: situations notice --title "LastDB upgraded" --kind upgrade --system lastdbd',
    });
  }

  const { cfg, node } = loadCtx({ configPath: parsed.values.config });
  requireNoticeSchema(cfg);

  let expires_at = parsed.values["expires-at"];
  if (!expires_at && parsed.values["expires-hours"]) {
    const hours = Number(parsed.values["expires-hours"]);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new FsituationsError({
        code: "invalid_expires_hours",
        message: `--expires-hours must be a positive number (got "${parsed.values["expires-hours"]}").`,
      });
    }
    const atMs = parsed.values.at ? Date.parse(parsed.values.at) : Date.now();
    const base = Number.isFinite(atMs) ? atMs : Date.now();
    expires_at = new Date(base + hours * 3_600_000).toISOString();
  }

  const input: NoticeInput = {
    slug: parsed.values.slug,
    title: parsed.values.title,
    kind: parsed.values.kind as NoticeInput["kind"],
    summary: parsed.values.summary,
    scope_systems: parsed.values.system,
    scope_apps: parsed.values.app,
    actor: parsed.values.actor,
    related_situation: parsed.values["related-situation"],
    severity_hint: parsed.values["severity-hint"] as NoticeInput["severity_hint"],
    at: parsed.values.at,
    expires_at,
  };

  const result = await upsertNotice(node, cfg, input);
  if (parsed.values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.action} notice ${result.notice.slug}`);
  }
  return 0;
}

async function noticePutCmd(rest: string[]): Promise<number> {
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
    console.log(usageFor("notice"));
    return 0;
  }
  const file = parsed.positionals[0];
  if (!file) {
    throw new FsituationsError({
      code: "missing_input",
      message: "Missing JSON file path.",
      hint: "Use `situations notice put <file>` or `situations notice put -` for stdin.",
    });
  }
  const body = file === "-" ? await new Response(Bun.stdin.stream()).text() : readFileSync(file, "utf8");
  const raw = JSON.parse(body) as NoticeInput;
  const { cfg, node } = loadCtx({ configPath: parsed.values.config });
  requireNoticeSchema(cfg);
  // Validate early so bad JSON fails before network.
  normalizeNotice(raw);
  const result = await upsertNotice(node, cfg, raw);
  if (parsed.values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.action} notice ${result.notice.slug}`);
  }
  return 0;
}

async function noticeShowCmd(rest: string[]): Promise<number> {
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
    console.log(usageFor("notice"));
    return 0;
  }
  const slug = parsed.positionals[0];
  if (!slug) {
    throw new FsituationsError({ code: "missing_slug", message: "Missing notice slug." });
  }
  const fields = parseFieldProjection(parsed.values.field);
  const { cfg, node } = loadCtx({ configPath: parsed.values.config });
  requireNoticeSchema(cfg);
  const notice = await requireNotice(node, cfg, slug);
  if (fields.length > 0) {
    printFieldProjection([notice as unknown as FieldProjectionSource], fields, (line) =>
      console.log(line),
    );
  } else {
    console.log(parsed.values.json ? JSON.stringify(notice, null, 2) : renderNotice(notice));
  }
  return 0;
}

async function noticesCmd(rest: string[]): Promise<number> {
  const parsed = parseArgs({
    args: rest,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      since: { type: "string" },
      system: { type: "string" },
      app: { type: "string" },
      kind: { type: "string" },
      field: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (parsed.values.help) {
    console.log(usageFor("notices"));
    return 0;
  }
  const fields = parseFieldProjection(parsed.values.field);
  const { cfg, node } = loadCtx({ configPath: parsed.values.config });
  requireNoticeSchema(cfg);
  const all = await listNotices(node, cfg);
  const visible = filterNotices(all, {
    all: parsed.values.all,
    since: parsed.values.since,
    system: parsed.values.system,
    app: parsed.values.app,
    kind: parsed.values.kind,
  });
  if (fields.length > 0) {
    printFieldProjection(visible as unknown as FieldProjectionSource[], fields, (line) =>
      console.log(line),
    );
  } else if (parsed.values.json) {
    console.log(JSON.stringify(visible, null, 2));
  } else {
    console.log(renderNoticesList(visible));
  }
  return 0;
}

function requireNoticeSchema(cfg: Config): void {
  if (hasNoticeSchema(cfg)) return;
  throw new FsituationsError({
    code: "notice_schema_missing",
    message: "No Notice schema hash in config.",
    hint: "Run `situations init` (re-declares Notice on Mini) or pass --notice-schema-hash.",
  });
}

async function publishStatusCmd(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      since: { type: "string" },
      "notice-limit": { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(usageFor("publish-status"));
    return 0;
  }
  const noticeLimit = parsePositiveIntFlag(values["notice-limit"], "--notice-limit");
  if (noticeLimit instanceof Error) {
    console.error(noticeLimit.message);
    return 2;
  }

  const { cfg, node } = loadCtx({ configPath: values.config });
  const result = await publishPostureStatus({
    node,
    cfg,
    dryRun: values["dry-run"] === true,
    noticeSince: values.since,
    noticeLimit,
    socketPath: resolveSocketPath(cfg),
  });
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const action = result.dryRun ? "DRY-RUN" : "PUBLISHED";
  console.log(
    `${action} situations posture snapshot captured_at=${result.capturedAt} posture=${result.posture.length} notices=${result.notices.length}`,
  );
  console.log(
    `schemas snapshot=${result.schemaHashes.snapshot} posture=${result.schemaHashes.posture} notice=${result.schemaHashes.notice}`,
  );
  return 0;
}

async function deliverStatusCmd(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      approve: { type: "boolean" },
      since: { type: "string" },
      "notice-limit": { type: "string" },
      "max-records": { type: "string" },
      "recipient-pubkey": { type: "string" },
      "recipient-name": { type: "string" },
      "messaging-public-key": { type: "string" },
      "messaging-pseudonym": { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(usageFor("deliver-status"));
    return 0;
  }
  const noticeLimit = parsePositiveIntFlag(values["notice-limit"], "--notice-limit");
  if (noticeLimit instanceof Error) {
    console.error(noticeLimit.message);
    return 2;
  }
  const maxRecords = parsePositiveIntFlag(values["max-records"], "--max-records");
  if (maxRecords instanceof Error) {
    console.error(maxRecords.message);
    return 2;
  }

  const recipient: DeliveryRecipient = {
    recipientPubkey: firstString(
      values["recipient-pubkey"],
      process.env.SITUATIONS_ADMIN_RECIPIENT_PUBKEY,
    ),
    messagingPublicKey: firstString(
      values["messaging-public-key"],
      process.env.SITUATIONS_ADMIN_MESSAGING_PUBLIC_KEY,
    ),
    messagingPseudonym: firstString(
      values["messaging-pseudonym"],
      process.env.SITUATIONS_ADMIN_MESSAGING_PSEUDONYM,
    ),
    recipientDisplayName: firstString(
      values["recipient-name"],
      process.env.SITUATIONS_ADMIN_RECIPIENT_NAME,
    ),
  };
  const missing = [
    ["--recipient-pubkey", recipient.recipientPubkey],
    ["--messaging-public-key", recipient.messagingPublicKey],
    ["--messaging-pseudonym", recipient.messagingPseudonym],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    console.error(
      `missing ${missing.map(([flag]) => flag).join(", ")} (or SITUATIONS_ADMIN_RECIPIENT_PUBKEY / SITUATIONS_ADMIN_MESSAGING_PUBLIC_KEY / SITUATIONS_ADMIN_MESSAGING_PSEUDONYM)`,
    );
    return 2;
  }

  const { cfg, node } = loadCtx({ configPath: values.config });
  const result = await deliverPostureStatus({
    node,
    cfg,
    recipient,
    approve: values.approve === true,
    dryRun: values["dry-run"] === true,
    noticeSince: values.since,
    noticeLimit,
    maxRecords,
    socketPath: resolveSocketPath(cfg),
  });
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.dryRun) {
    console.log(
      `DRY-RUN situations delivery posture=${result.posture.length} notices=${result.notices.length} max_records=${result.deliveryRequest.max_records}`,
    );
    console.log(
      `schemas snapshot=${result.schemaHashes.snapshot} posture=${result.schemaHashes.posture} notice=${result.schemaHashes.notice}`,
    );
    return 0;
  }
  if (!result.staged) {
    console.error("delivery stage returned no result");
    return 1;
  }
  if (result.approved) {
    console.log(
      `DELIVERED situations posture delivery_id=${result.approved.deliveryId} shared=${result.approved.shared} message_type=${result.approved.messageType}`,
    );
  } else {
    console.log(
      `STAGED situations posture delivery_id=${result.staged.deliveryId} records=${result.staged.recordCount}; re-run with --approve to send`,
    );
  }
  console.log(
    `schemas snapshot=${result.schemaHashes.snapshot} posture=${result.schemaHashes.posture} notice=${result.schemaHashes.notice}`,
  );
  return 0;
}

function parsePositiveIntFlag(value: string | undefined, name: string): number | undefined | Error {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return new Error(`invalid ${name} ${value}`);
  return parsed;
}

function firstString(...values: Array<string | undefined>): string {
  return values.find((value) => value && value.trim())?.trim() ?? "";
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

let captureTopLevel: CaptureSentryException = async () => {};

initCliSentry()
  .then((capture) => {
    captureTopLevel = capture;
    return main(Bun.argv.slice(2));
  })
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
    void captureTopLevel(err, { entrypoint: "cli", top_level: "true" }).finally(() => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exit(1);
    });
  });
