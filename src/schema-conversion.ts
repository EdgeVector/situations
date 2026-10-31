/** Explicit, scope-bound ownership conversion. No record values pass through this command. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  aliasesFor,
  canonicalSchema,
  profilesFor,
} from "./canonical-vocabulary.ts";
import {
  readConfig,
  writeConfig,
  CONFIG_VERSION,
  type Config,
} from "./config.ts";
import { type NodeClient } from "./client.ts";
import { APP_SCHEMAS } from "./schema-layout.ts";
import {
  nodeApiVersion,
  object,
  ownsValues,
  payload,
  type ObjectValue,
} from "./schema-mode.ts";
import { OWNER_APP_ID, type SchemaDefinition } from "./schemas.ts";

type Request = {
  schema: string;
  expected_identity: string;
  alternate_keys: Record<string, never>;
  membership: { kind: "field_exists"; field: string };
};
type Report = {
  change_id: string;
  phase: string;
  durable: true;
  converted_schemas: string[];
  retired_schemas: string[];
  schemas: Request[];
  selected_keys: number;
  expected_selected_keys: number;
  processed_keys: number;
  expected_keys: number;
};
type Scope = {
  source_config_sha256: string;
  target_config_sha256: string;
  change_id: string;
  schemas: Request[];
  retire: string[];
};
const ROUTE = "/api/db/alternate-keys";
function fail(message: string): never {
  throw new Error(`F-Situations schema conversion: ${message}`);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + stable(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const exactIdentity = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const terminal = (report: Report) =>
  ["complete", "aborted"].includes(report.phase);

function durableScope(
  path: string,
  value: Scope,
  previous: string | null,
): string {
  if ((existsSync(path) ? readFileSync(path, "utf8") : null) !== previous)
    fail("the saved conversion scope changed.");
  const raw = bytes(value);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, raw);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (previous === null) {
      const placeholder = openSync(path, "wx", 0o600);
      closeSync(placeholder);
    } else if (readFileSync(path, "utf8") !== previous)
      fail("the saved conversion scope changed before publication.");
    renameSync(temporary, path);
    barrier(path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return raw;
}
function barrier(path: string): void {
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function removeScope(path: string, expected: string): void {
  if (readFileSync(path, "utf8") !== expected)
    fail("the saved conversion scope changed before completion.");
  unlinkSync(path);
  barrier(path);
}
function receipt(value: unknown): Report {
  const report = object(payload(value).app_schema_conversion);
  const phases = [
    "backfill",
    "verifying",
    "verified",
    "retiring",
    "ready",
    "aborting",
    "complete",
    "aborted",
  ];
  const names = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.every((name) => typeof name === "string" && name.length > 0) &&
    new Set(value).size === value.length;
  if (
    report.durable !== true ||
    typeof report.change_id !== "string" ||
    !report.change_id ||
    typeof report.phase !== "string" ||
    !phases.includes(report.phase) ||
    !names(report.converted_schemas) ||
    !names(report.retired_schemas) ||
    !Array.isArray(report.schemas) ||
    report.schemas.length !== report.converted_schemas.length ||
    ![
      "selected_keys",
      "expected_selected_keys",
      "processed_keys",
      "expected_keys",
    ].every(
      (key) => Number.isSafeInteger(report[key]) && Number(report[key]) >= 0,
    ) ||
    Number(report.selected_keys) > Number(report.expected_selected_keys) ||
    Number(report.processed_keys) > Number(report.expected_keys)
  )
    fail("the node returned an invalid durable receipt.");
  return report as Report;
}
async function request(
  node: NodeClient,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<ObjectValue> {
  const reply = await node.rawCall(method, path, body);
  if (reply.status !== 200)
    fail(
      `${path} returned HTTP ${reply.status}; no next phase follows this reply.`,
    );
  return payload(reply.body);
}
async function metadata(
  node: NodeClient,
  address: string,
): Promise<ObjectValue> {
  const data = await request(
    node,
    "GET",
    `/api/schema/${encodeURIComponent(address)}`,
  );
  return object(data.schema ?? data);
}
function definitionFor(
  source: ObjectValue,
  local: SchemaDefinition,
): { definition: SchemaDefinition; canonical: boolean } {
  const canonical = canonicalSchema(local);
  const fields = Array.isArray(source.fields) ? [...source.fields].sort() : [];
  if (same(fields, [...canonical.fields].sort()))
    return { definition: canonical, canonical: true };
  if (same(fields, [...local.fields].sort()))
    return { definition: local, canonical: false };
  return fail(
    `installed ${local.descriptive_name} has different fields; no field rename is inferred.`,
  );
}
function validate(
  source: ObjectValue,
  local: SchemaDefinition,
): { definition: SchemaDefinition; canonical: boolean } {
  const matched = definitionFor(source, local);
  const definition = matched.definition;
  if (
    source.owner_app_id !== OWNER_APP_ID ||
    source.descriptive_name !== definition.descriptive_name ||
    source.schema_type !== definition.schema_type ||
    !exactIdentity(source.identity_hash) ||
    typeof source.name !== "string" ||
    !source.name ||
    !same(
      [object(source.key).hash_field, object(source.key).range_field ?? null],
      [definition.key.hash_field, definition.key.range_field ?? null],
    ) ||
    !same(source.field_types, definition.field_types) ||
    !same(source.field_descriptions, definition.field_descriptions) ||
    Object.keys(object(source.field_mappers)).length ||
    Object.keys(object(source.transform_fields)).length
  )
    fail(
      `installed ${local.descriptive_name} differs from its exact app definition.`,
    );
  return matched;
}
function checkScope(report: Report, scope: Scope): void {
  if (
    (scope.change_id && report.change_id !== scope.change_id) ||
    !same(report.schemas, scope.schemas) ||
    !same(
      [...report.converted_schemas].sort(),
      scope.schemas.map((item) => item.schema).sort(),
    ) ||
    !same([...report.retired_schemas].sort(), [...scope.retire].sort())
  )
    fail(
      "another conversion owns this node, or its definitions/membership/retirements differ.",
    );
}

export async function convertSchemaValues(
  node: NodeClient,
  configPath: string,
  options: { apply?: boolean; maintenance?: boolean; abort?: boolean },
): Promise<unknown> {
  if (options.abort && (!options.apply || !options.maintenance))
    fail("abort requires --apply --maintenance.");
  const initial = readFileSync(configPath, "utf8");
  const cfg = readConfig(configPath);
  const scopePath = configPath + ".conversion.json";
  let scopeRaw = existsSync(scopePath) ? readFileSync(scopePath, "utf8") : null;
  let saved: Scope | undefined = scopeRaw
    ? (JSON.parse(scopeRaw) as Scope)
    : undefined;
  const version = await request(node, "GET", "/api/version");
  const capabilities = object(version.capabilities);
  const apiVersion = nodeApiVersion(version);
  if (capabilities.app_schema_conversion_v1 !== true)
    fail("use a compatible LastDB release before the removal upgrade.");
  const status = await node.rawCall("POST", ROUTE, { action: "app_status" });
  if (
    status.status !== 200 &&
    !(status.status === 404 && status.body === "app conversion is absent")
  )
    fail("the app conversion status is unavailable.");
  let report = status.status === 200 ? receipt(status.body) : undefined;
  const pending = report && !terminal(report) ? report : undefined;
  if (report?.phase === "aborted" && saved) {
    if (
      saved.change_id !== report.change_id ||
      saved.source_config_sha256 !== sha(initial)
    )
      fail("the aborted scope differs from this config.");
    checkScope(report, saved);
    if (!options.apply)
      return { phase: "aborted", local_cleanup_required: true };
    if (scopeRaw) removeScope(scopePath, scopeRaw);
    if (options.abort) return report;
    saved = undefined;
    scopeRaw = null;
  }
  const directory = await request(node, "GET", "/api/schemas");
  if (directory.ready !== true || !Array.isArray(directory.schemas))
    fail("the schema directory is incomplete.");
  const owned = directory.schemas
    .map(object)
    .filter((source) => source.owner_app_id === OWNER_APP_ID);
  if (!owned.length || !cfg.schemaHashes.situation)
    fail("the saved Situation schema and installed app schemas are required.");
  const installed = await Promise.all(
    owned.map((source) => metadata(node, String(source.name))),
  );
  if (
    installed.some(
      (source) =>
        !APP_SCHEMAS.some(
          ({ definition }) =>
            definition.descriptive_name === source.descriptive_name,
        ),
    )
  )
    fail("the node contains an unreviewed F-Situations record type.");
  if (
    Object.keys(cfg.schemaHashes).some(
      (key) => !APP_SCHEMAS.some((entry) => entry.key === key),
    )
  )
    fail("the app config contains an unreviewed schema key.");
  const selected = APP_SCHEMAS.flatMap(({ key, definition: local, member }) => {
    const candidates = installed.filter(
      (source) =>
        source.descriptive_name === local.descriptive_name &&
        !Object.keys(object(source.field_mappers)).length,
    );
    const pin = cfg.schemaHashes[key];
    const source = pin
      ? candidates.find(
          (source) => source.name === pin || source.identity_hash === pin,
        )
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!source) {
      if (pin || candidates.length)
        fail(`cannot select one exact saved ${key} schema.`);
      return [];
    }
    const matched = validate(source, local);
    if (
      cfg.schemaIdentities?.[key] &&
      cfg.schemaIdentities[key] !== source.identity_hash
    )
      fail(`the saved ${key} definition identity differs.`);
    return [{ key, local, member, source, ...matched }];
  });
  const kept = new Set(selected.map(({ source }) => String(source.name)));
  if (
    kept.size !== selected.length ||
    !selected.some(({ key }) => key === "situation")
  )
    fail("kept runtime addresses are incomplete or duplicate.");
  const retire =
    pending && saved
      ? [...saved.retire]
      : installed
          .filter((source) => !kept.has(String(source.name)))
          .map((source) => {
            const mappings = Object.values(object(source.field_mappers));
            if (
              ownsValues(source, apiVersion) ||
              !mappings.length ||
              typeof source.name !== "string" ||
              !source.name.startsWith(OWNER_APP_ID + "/") ||
              mappings.some(
                (mapping) =>
                  typeof mapping !== "string" ||
                  !kept.has(mapping.split(".")[0]!),
              )
            )
              fail("a local alias owns values outside the kept sources.");
            return String(source.name);
          })
          .sort();
  if (retire.length && capabilities.app_schema_alias_retirement_v1 !== true)
    fail("alias retirement needs app_schema_alias_retirement_v1 before the request pause.");
  const schemas: Request[] = selected.map(
    ({ source, definition, local, canonical, member }) => ({
      schema: String(source.name),
      expected_identity: String(source.identity_hash),
      alternate_keys: {},
      membership: {
        kind: "field_exists",
        field: canonical ? aliasesFor(local)[member]! : member,
      },
    }),
  );
  const canonicalSources = selected.filter(({ canonical }) => canonical);
  const aliases = canonicalSources.length
    ? Object.assign(
        {},
        cfg.schemaFieldAliases,
        ...canonicalSources.map(({ local, source }) =>
          profilesFor(local, [
            String(source.name),
            String(source.identity_hash),
          ]),
        ),
      )
    : cfg.schemaFieldAliases;
  const target: Config = {
    ...cfg,
    configVersion: CONFIG_VERSION,
    schemaHashes: Object.fromEntries(
      selected.map(({ key, source }) => [key, String(source.name)]),
    ),
    schemaIdentities: Object.fromEntries(
      selected.map(({ key, source }) => [key, String(source.identity_hash)]),
    ),
    schemaFieldAliases: aliases,
  };
  const targetSha = sha(bytes(target));
  const currentSha = sha(initial);
  if (pending) {
    if (
      !saved ||
      !same(saved.schemas, schemas) ||
      saved.target_config_sha256 !== targetSha ||
      ![saved.source_config_sha256, saved.target_config_sha256].includes(
        currentSha,
      )
    )
      fail("the active conversion does not match this saved config and scope.");
    checkScope(pending, saved);
  }
  const allOwned = selected.every(({ source }) =>
    ownsValues(source, apiVersion),
  );
  if (!pending && allOwned) {
    if (
      selected.some(
        ({ source }) => Object.keys(object(source.alternate_keys)).length,
      )
    )
      fail("an unexpected alternate layout requires owner review.");
    if (saved) {
      if (
        !report ||
        report.phase !== "complete" ||
        saved.target_config_sha256 !== currentSha
      )
        fail("the saved scope is incomplete.");
      checkScope(report, saved);
    }
    if (options.apply) {
      writeConfig(target, configPath, initial);
      if (saved && scopeRaw) removeScope(scopePath, scopeRaw);
    }
    return {
      phase: "complete",
      already_converted: true,
      converted_schemas: [...kept],
    };
  }
  if (
    !pending &&
    selected.some(({ source }) => ownsValues(source, apiVersion))
  )
    fail("the app contains divergent schema ownership models.");
  if (!options.apply) return { phase: "plan", schemas, retire };
  if (!options.maintenance)
    fail("use --apply --maintenance for the explicit node request pause.");
  if (!pending) {
    if (options.abort) fail("no unpublished conversion is active.");
    const scope: Scope = {
      source_config_sha256: currentSha,
      target_config_sha256: targetSha,
      change_id: "",
      schemas,
      retire,
    };
    if (saved && !same(saved, scope))
      fail("a different saved conversion scope requires owner review.");
    scopeRaw = durableScope(scopePath, scope, scopeRaw);
    saved = scope;
    if (
      readFileSync(configPath, "utf8") !== initial ||
      readFileSync(scopePath, "utf8") !== scopeRaw
    )
      fail("the config or scope changed before the node request pause.");
    report = receipt(
      await request(node, "POST", ROUTE, {
        action: "app_begin",
        schemas,
        retire,
        maintenance: true,
      }),
    );
    checkScope(report, saved);
  }
  if (!saved || !report || !scopeRaw)
    fail("the durable conversion scope is absent.");
  if (!saved.change_id) {
    saved = { ...saved, change_id: report.change_id };
    scopeRaw = durableScope(scopePath, saved, scopeRaw);
  }
  for (let page = 0; page < 100000; page++) {
    if (
      readFileSync(scopePath, "utf8") !== scopeRaw ||
      ![saved.source_config_sha256, saved.target_config_sha256].includes(
        sha(readFileSync(configPath, "utf8")),
      )
    )
      fail("the config or scope changed; no next phase follows.");
    checkScope(report, saved);
    let action: string;
    if (options.abort) {
      if (
        !["backfill", "verifying", "verified", "aborting"].includes(
          report.phase,
        )
      )
        fail("the published conversion cannot abort.");
      action = "app_abort";
    } else if (["backfill", "verifying"].includes(report.phase))
      action = "app_page";
    else if (report.phase === "verified") action = "app_commit";
    else if (report.phase === "retiring") action = "app_cleanup";
    else if (report.phase === "ready") {
      if (
        report.selected_keys !== report.expected_selected_keys ||
        report.processed_keys !== report.expected_keys
      )
        fail("the conversion membership is incomplete.");
      const published = await Promise.all(
        selected.map(({ source }) => metadata(node, String(source.name))),
      );
      published.forEach((source, index) => {
        validate(source, selected[index]!.local);
        if (
          !ownsValues(source, apiVersion) ||
          source.identity_hash !== schemas[index]!.expected_identity ||
          Object.keys(object(source.alternate_keys)).length
        )
          fail("the published schema differs.");
      });
      const current = readFileSync(configPath, "utf8");
      if (
        readFileSync(scopePath, "utf8") !== scopeRaw ||
        ![saved.source_config_sha256, saved.target_config_sha256].includes(
          sha(current),
        )
      )
        fail("the config or scope changed before the final config write.");
      writeConfig(target, configPath, current);
      action = "app_finish";
    } else if (report.phase === "complete" || report.phase === "aborted") {
      removeScope(scopePath, scopeRaw);
      return report;
    } else
      return fail(
        `conversion ${report.change_id} remains in ${report.phase}; resume or abort that scope.`,
      );
    const next = receipt(
      await request(node, "POST", ROUTE, {
        action,
        change_id: report.change_id,
      }),
    );
    checkScope(next, saved);
    report = next;
    if (options.abort && report.phase === "aborted") {
      removeScope(scopePath, scopeRaw);
      return report;
    }
  }
  return fail(
    "the page limit stopped the command; resume the same conversion.",
  );
}
