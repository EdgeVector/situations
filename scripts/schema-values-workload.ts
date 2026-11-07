/** Actual exported app operations against a generated, CI-owned LastDB home. No app CLI. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { APP_SCHEMAS } from "../src/schema-layout.ts";
import { canonicalProfilesForHashes } from "../src/init-schema.ts";
import { nodeOwnsValues } from "../src/schema-mode.ts";
import { fieldValueBytes } from "../src/field-value-size.ts";
import type { Config } from "../src/config.ts";
import type { BatchMutationOp, NodeClient } from "../src/client.ts";
import type { Situation } from "../src/record.ts";
import type { Notice } from "../src/notice.ts";

const { values: args } = parseArgs({
  options: Object.fromEntries(
    [
      "baseline",
      "candidate",
      "socket",
      "config",
      "output",
      "mode",
      "label",
      "records",
      "api-version",
    ].map((name) => [name, { type: "string" as const }]),
  ),
});
function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
require(process.env.GITHUB_ACTIONS === "true" &&
  process.env.RUNNER_ENVIRONMENT === "github-hosted", "Hosted CI only.");
for (const name of [
  "baseline",
  "candidate",
  "socket",
  "config",
  "output",
  "mode",
  "label",
])
  require(args[name], `Missing ${name}.`);
const output = resolve(args.output!);
const runner = resolve(process.env.RUNNER_TEMP!);
require(output.startsWith(
  runner + sep,
), "The output must use this runner's temporary directory.");
require(["baseline", "candidate"].includes(
  args.label!,
), "Unknown comparison arm.");
const count = Number(args.records ?? 64);
require(Number.isSafeInteger(count) &&
  count >= 64 &&
  count <= 256, "Use a declared 64 to 256 record seed.");
const apiVersion = Number(args["api-version"]);
const native = apiVersion >= 30;
require(Number.isInteger(apiVersion) && (native || (apiVersion === 26 && args.label === "baseline")),
  "The workload requires the native API or the exact migration baseline.");
const active = args.label === "baseline" ? args.baseline! : args.candidate!;
const load = (root: string, name: string): Promise<any> =>
  import(pathToFileURL(join(resolve(root), "src", name + ".ts")).href);
const save = (name: string, value: unknown) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
const read = (name: string) =>
  JSON.parse(readFileSync(join(output, name), "utf8"));
const stable = (value: any): string =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? "[" + value.map(stable).join(",") + "]"
      : "{" +
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => JSON.stringify(key) + ":" + stable(item))
          .join(",") +
        "}"
    : JSON.stringify(value);
const same = (left: unknown, right: unknown) => stable(left) === stable(right);
const sha = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex");
const slug = (type: string, index: number) =>
  `ci-${type}-${String(index).padStart(6, "0")}`;
const summary = (type: string, index: number, generation = 0) =>
  `${type}/${index}/${generation} ` +
  createHash("sha256")
    .update(`${type}/${index}/${generation}`)
    .digest("hex")
    .repeat(16);
const samples: Record<string, number[]> = {};
async function measure<T>(
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const result = await operation();
  (samples[name] ??= []).push(performance.now() - start);
  return result;
}
async function client(root: string, cfg?: Config): Promise<NodeClient> {
  const { newNodeClient } = await load(root, "client");
  return newNodeClient({
    baseUrl: "http://127.0.0.1",
    userHash: cfg?.userHash ?? "",
    socketPath: args.socket,
    schemaFieldAliases: cfg?.schemaFieldAliases,
    schemaIdentitiesByAddress: cfg?.schemaIdentities && Object.fromEntries(
      Object.entries(cfg.schemaIdentities).map(([key, identity]) => [cfg.schemaHashes[key], identity]),
    ),
    canonicalVocabulary: true,
    timeoutMs: 120000,
  });
}

type Written = {
  key: { hash: string; range: string | null };
  fields: Record<string, unknown>;
};
type Membership = Record<string, Record<string, Written>>;
let members: Membership = existsSync(join(output, "members.json"))
  ? read("members.json")
  : {};
function observe(node: NodeClient): NodeClient {
  // Account only for writes that the actual daemon accepted. This never supplies data replies.
  const accepted = (op: BatchMutationOp) => {
    const values = (members[op.schemaHash] ??= {});
    const key = { hash: op.keyHash, range: op.keyRange ?? null };
    const id = stable(key);
    if (op.mutationType === "delete") delete values[id];
    else values[id] = { key, fields: { ...values[id]?.fields, ...op.fields } };
  };
  return {
    ...node,
    async mutateBatch(ops) {
      await node.mutateBatch(ops);
      ops.forEach(accepted);
    },
    async createRecord(op) {
      await node.createRecord(op);
      accepted({ ...op, mutationType: "update" });
    },
    async updateRecord(op) {
      await node.updateRecord(op);
      accepted({ ...op, mutationType: "update" });
    },
  };
}

async function setup(
  root: string,
  prior?: Config,
): Promise<{ node: NodeClient; cfg: Config }> {
  let node = await client(root, prior);
  const identity = await node.autoIdentity();
  require(identity.provisioned, "The actual node did not provision an owner identity.");
  node = await client(root, {
    ...prior,
    userHash: identity.userHash,
  } as Config);
  const definitions = await load(root, "init-schema");
  const resolved = await definitions.resolveOrDeclareSchemaHashes(node, {
    quiet: true,
    canonicalVocabulary: true,
    expectedIdentities: prior?.schemaIdentities,
  });
  const hashes = resolved.schemaHashes ?? resolved;
  const config = await load(root, "config");
  const cfg: Config = {
    ...prior,
    configVersion: config.CONFIG_VERSION,
    nodeUrl: "http://127.0.0.1",
    schemaServiceUrl:
      "https://axo709qs11.execute-api.us-east-1.amazonaws.com/v1",
    userHash: identity.userHash,
    nodeSocketPath: args.socket!,
    schemaHashes: { ...prior?.schemaHashes, ...hashes },
    schemaFieldAliases: {
      ...prior?.schemaFieldAliases,
      ...definitions.canonicalProfilesForHashes(hashes),
    },
    ...(resolved.schemaIdentities
      ? { schemaIdentities: resolved.schemaIdentities }
      : {}),
  };
  config.writeConfig(cfg, args.config);
  return { node: observe(await client(root, cfg)), cfg };
}

async function snapshot(
  node: NodeClient,
  cfg: Config,
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  const pending = APP_SCHEMAS.flatMap(({ key, definition }) => {
    const address = cfg.schemaHashes[key];
    require(address, `The saved ${key} runtime address is absent.`);
    return Object.values(members[address] ?? {}).map((record) => ({
      key,
      address,
      definition,
      record,
    }));
  });
  for (let start = 0; start < pending.length; start += 64) {
    const group = pending.slice(start, start + 64);
    const queries = group.map(({ address, definition, record }) => ({
      schema_name: address,
      ...(native ? {} : { fields: definition.fields }),
      filter:
        record.key.range === null
          ? { HashKey: record.key.hash }
          : {
              HashRangeKey: { hash: record.key.hash, range: record.key.range },
            },
      response_format: "full",
      limit: 2,
      offset: 0,
    }));
    const result = await node.rawCall("POST", "/api/queries/batch", {
      queries,
    });
    const body = (result.body as any)?.data ?? result.body;
    require(result.status === 200 &&
      body.ok === true &&
      body.count === group.length &&
      Array.isArray(body.results) &&
      body.results.length ===
        group.length, "The complete known-key batch differs.");
    for (let index = 0; index < group.length; index++) {
      const { key, definition, record } = group[index]!;
      const item = body.results[index];
      const response = item.response?.data ?? item.response;
      require(item.status === 200 &&
        response?.ok === true &&
        response.has_more === false &&
        response.results?.length ===
          1, "A written record is absent or ambiguous.");
      const row = response.results[0];
      require(same(row.key, record.key) &&
        same(
          Object.keys(row.fields).sort(),
          [...definition.fields].sort(),
        ), "A written record key or field membership differs.");
      require(same(
        row.fields,
        record.fields,
      ), `The actual ${key} values differ from accepted app writes.`);
      if (native)
        require(typeof row.revision === "string" && row.revision.length > 0 &&
          same(row.alternates, {}), "A native record is missing its revision or explicit alternate membership.");
      // A record has one metadata block, or null.
      values[`${key}/${stable(record.key)}`] = {
        value_sha256: Object.fromEntries(
          definition.fields.map((field) => [field, sha(row.fields[field])]),
        ),
        metadata: row.metadata ?? null,
        ...(native ? { revision: row.revision, alternates: row.alternates } : {}),
      };
    }
  }
  // Entry membership has an explicit hash and range. Compare every range page to the accepted key set.
  for (const key of ["index_entry", "notice_history"]) {
    const entry = APP_SCHEMAS.find((item) => item.key === key)!;
    const address = cfg.schemaHashes[key]!;
    const records = Object.values(members[address] ?? {});
    const hashes = [...new Set(records.map((record) => record.key.hash))];
    await Promise.all(
      hashes.map(async (hash) => {
        const rows = await node.queryAll({
          schemaHash: address,
          fields: entry.definition.fields,
          filter: { HashKey: hash },
          pageSize: 17,
        });
        const actual = rows.results.map((row) => stable(row.key));
        const expected = records
          .filter((record) => record.key.hash === hash)
          .map((record) => stable(record.key))
          .sort();
        require(same(
          actual,
          expected,
        ), "The complete range membership differs.");
      }),
    );
  }
  return values;
}

async function checkLists(
  node: NodeClient,
  cfg: Config,
  root: string,
  expectedCount: number,
): Promise<void> {
  const record = await load(root, "record"),
    notice = await load(root, "notice");
  const [situations, activeRows, notices] = await Promise.all([
    record.listSituations(node, cfg),
    record.listActiveSituationsIndexed(node, cfg),
    notice.listNoticesIndexed(node, cfg, { all: true }),
  ]);
  for (const [type, rows] of [
    ["situation", situations],
    ["situation", activeRows],
    ["notice", notices],
  ] as const) {
    const expected = Array.from({ length: expectedCount }, (_, index) =>
      slug(type, index),
    ).sort();
    require(same(
      rows.map((row: any) => row.slug).sort(),
      expected,
    ), "The actual app list membership differs.");
    for (const row of rows) {
      const written =
        members[cfg.schemaHashes[type]!]![
          stable({ hash: row.slug, range: null })
        ];
      require(written &&
        row.summary ===
          written.fields
            .summary, "An actual app list returns a stale source summary.");
    }
  }
}

let snapshotPages = { snapshot_pages: 0, snapshot_page_max_field_bytes: 0 };
async function publish(
  node: NodeClient,
  cfg: Config,
  root: string,
  expectedCount: number,
): Promise<void> {
  const module = await load(root, "publish-status");
  const result = await module.publishPostureStatus({
    node,
    cfg,
    noticeLimit: expectedCount,
    noticeSince: "24h",
  });
  // A snapshot is one or more page records. LastDB refuses a page above its 64 KiB record cap.
  require(result.dryRun === false &&
    result.written.snapshots === result.snapshots.length &&
    result.snapshots.length >= 1 &&
    result.written.posture === expectedCount &&
    result.written.notices ===
      expectedCount, "The actual publication membership differs.");
  // The field value bytes of each page, as the node measures them. Field names and stamps are extra.
  const pageBytes = result.snapshots.map((page: Record<string, string>) =>
    Object.values(page).reduce((total, value) => total + fieldValueBytes(value), 0));
  snapshotPages = { snapshot_pages: pageBytes.length, snapshot_page_max_field_bytes: Math.max(...pageBytes) };
  for (const [key, address] of Object.entries(result.schemaHashes))
    cfg.schemaHashes[`admin_${key}`] = String(address);
  // Keep the publication addresses and their field profiles in the saved config.
  cfg.schemaFieldAliases = {
    ...cfg.schemaFieldAliases,
    ...canonicalProfilesForHashes(cfg.schemaHashes),
  };
  (await load(root, "config")).writeConfig(cfg, args.config);
}

async function runSetup(): Promise<void> {
  // Each app version seeds its own fresh home.
  let { node, cfg } = await setup(active);
  const record = await load(active, "record"),
    notice = await load(active, "notice");
  const now = new Date().toISOString();
  // Each app operation owns its batch request. Independent records run in bounded parallel sets.
  for (let start = 0; start < count; start += 8) {
    await Promise.all(
      Array.from({ length: Math.min(8, count - start) }, async (_, offset) => {
        const index = start + offset;
        await record.upsertSituation(node, cfg, {
          slug: slug("situation", index),
          title: `Situation ${index}`,
          summary: summary("situation", index),
          status: "active",
          severity: ["p0", "p1", "p2", "p3"][index % 4],
          scope_systems: ["ci-owned"],
          scope_repos: ["EdgeVector/situations"],
          phases: [],
          blocked_actions: [],
          created_at: now,
        });
        await notice.upsertNotice(node, cfg, {
          slug: slug("notice", index),
          title: `Notice ${index}`,
          summary: summary("notice", index),
          kind: "other",
          at: now,
          scope_systems: ["ci-owned"],
          actor: "github-ci",
          related_situation: "",
          expires_at: new Date(Date.now() + 48 * 3600000).toISOString(),
        });
      }),
    );
  }
  await checkLists(node, cfg, active, count);
  await publish(node, cfg, active, count);
  // Publication declarations update the real client's profiles. Reopen the adapter with all saved profiles.
  node = observe(await client(active, cfg));
  save("members.json", members);
  const before = await snapshot(node, cfg);
  save("seed-values.json", before);
  save("seed.json", {
    logical_situations: count,
    logical_notices: count,
    record_types: 8,
    written_keys: Object.fromEntries(
      APP_SCHEMAS.map(({ key }) => [
        key,
        Object.keys(members[cfg.schemaHashes[key]!] ?? {}).length,
      ]),
    ),
    current_records: Object.keys(before).length,
    source_hashes: cfg.schemaHashes,
    ...snapshotPages,
  });
}

async function runMeasure(): Promise<void> {
  const config = await load(active, "config");
  let cfg: Config = config.readConfig(args.config);
  let node = observe(await client(active, cfg));
  require(same(
    await snapshot(node, cfg),
    read("seed-values.json"),
  ), "Reopen changed values or record metadata.");
  const beforeCfg = stable(cfg.schemaHashes);
  const beforeIdentities = stable(cfg.schemaIdentities);
  if (args.label !== "baseline") {
    const repeated = await setup(active, cfg);
    cfg = repeated.cfg;
    node = repeated.node;
    require(stable(cfg.schemaHashes) === beforeCfg &&
      stable(cfg.schemaIdentities) === beforeIdentities &&
      same(
        await snapshot(node, cfg),
        read("seed-values.json"),
      ), "Repeat setup changed addresses or current values.");
    const [directory, version] = await Promise.all([
      node.rawCall("GET", "/api/schemas?include_full=true"),
      node.rawCall("GET", "/api/version"),
    ]);
    const body = (directory.body as any)?.data ?? directory.body;
    const owned = body.schemas.filter(
      (schema: any) => schema.owner_app_id === "situations",
    );
    require(directory.status === 200 &&
      version.status === 200 &&
      nodeOwnsValues(version.body) &&
      owned.length === 8 &&
      APP_SCHEMAS.every(({ key, definition }) => owned.some((schema: any) =>
        schema.name === cfg.schemaHashes[key] &&
        schema.identity_hash === cfg.schemaIdentities?.[key] &&
        schema.record_keys?.primary?.kind === (definition.schema_type === "HashRange" ? "hash_range" : "hash") &&
        same(schema.record_keys?.alternates, {}),
      )), "The app does not own exactly the eight expected native record types.");
  }
  const record = await load(active, "record"),
    notice = await load(active, "notice");
  const iterations = 64;
  let sourceUpdateKeepsPublicationValues = false;
  for (let index = 0; index < iterations; index++) {
    const key = index % count;
    const point = await measure<Situation>("point_read", () =>
      record.requireSituation(node, cfg, slug("situation", key)),
    );
    require(point.summary ===
      summary("situation", key), "The point read differs.");
    await measure("update", () =>
      record.upsertSituation(node, cfg, {
        slug: slug("situation", key),
        summary: summary("situation", key, 1),
      }),
    );
    if (index === 0 && args.label !== "baseline") {
      // This is the ordinary source update above, before the explicit publication below.
      const [source, published] = await Promise.all([
        record.requireSituation(node, cfg, slug("situation", key)),
        node.queryAll({
          schemaHash: cfg.schemaHashes.admin_posture!,
          fields: ["summary"],
          filter: { HashKey: slug("situation", key) },
        }),
      ]);
      require(source.summary === summary("situation", key, 1) &&
        source.title === point.title &&
        published.results.length === 1 &&
        published.results[0]!.fields.summary ===
          summary(
            "situation",
            key,
          ), "A source update changed a separate publication record without its explicit publication request.");
      sourceUpdateKeepsPublicationValues = true;
    }
    const noticeRow = await measure<Notice>("notice_read", () =>
      notice.requireNotice(node, cfg, slug("notice", key)),
    );
    require(noticeRow.summary ===
      summary("notice", key), "The notice read differs.");
    const activeRows = await measure<Situation[]>("active_list", () =>
      record.listActiveSituationsIndexed(node, cfg),
    );
    require(activeRows.length === count &&
      new Set(activeRows.map((row: any) => row.slug)).size ===
        count, "The active list is incomplete.");
    require(activeRows.find((row) => row.slug === slug("situation", key))
      ?.summary ===
      summary(
        "situation",
        key,
        1,
      ), "The timed active list returns a stale update.");
    await measure("publication", () => publish(node, cfg, active, count));
  }
  await checkLists(node, cfg, active, count);
  const final = await snapshot(node, cfg);
  save("members.json", members);
  save("final-values.json", final);
  save("result.json", {
    label: args.label,
    complete: true,
    records: count,
    samples_ms: samples,
    seed_records: Object.keys(read("seed-values.json")).length,
    final_records: Object.keys(final).length,
    unchanged_seed_values_on_reopen: true,
    repeat_setup: args.label !== "baseline",
    complete_membership: true,
    source_update_keeps_publication_values: sourceUpdateKeepsPublicationValues,
    ...snapshotPages,
  });
}

if (args.mode === "setup") await runSetup();
else if (args.mode === "measure") await runMeasure();
else if (args.mode === "verify") {
  const cfg = (await load(active, "config")).readConfig(args.config);
  require(same(
    await snapshot(await client(active, cfg), cfg),
    read("final-values.json"),
  ), "Final flush/reopen changed data or current values.");
  await checkLists(await client(active, cfg), cfg, active, count);
  save("final-reopen.json", { complete: true });
} else throw Error("Unknown workload phase.");
