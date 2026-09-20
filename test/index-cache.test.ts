import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  findSituation,
  listActiveSituationsIndexed,
  listSituations,
  requireSituation,
  upsertSituation,
} from "../src/record.ts";
import { listNoticesIndexed, listNotices, upsertNotice } from "../src/notice.ts";

const SITUATION_HASH = "hash-situation";
const NOTICE_HASH = "hash-notice";
const INDEX_HASH = "hash-index";

function baseConfig(): Config {
  return {
    configVersion: 1,
    nodeUrl: "http://127.0.0.1:9001",
    schemaServiceUrl: "",
    userHash: "test-user",
    schemaHashes: { situation: SITUATION_HASH, notice: NOTICE_HASH, index: INDEX_HASH },
  };
}

/**
 * In-memory node double: point-reads (`filter.HashKey`) hit a single row;
 * anything else is a full-table scan, counted so tests can assert the hot
 * paths never trigger one.
 */
function makeNode(): {
  node: NodeClient;
  fullScans: () => number;
} {
  const stores = new Map<string, Map<string, Record<string, unknown>>>([
    [SITUATION_HASH, new Map()],
    [NOTICE_HASH, new Map()],
    [INDEX_HASH, new Map()],
  ]);
  let fullScans = 0;

  function storeFor(schemaHash: string): Map<string, Record<string, unknown>> {
    const store = stores.get(schemaHash);
    if (!store) throw new Error(`unknown schema hash ${schemaHash}`);
    return store;
  }

  function hashKeyOf(filter?: QueryFilter): string | undefined {
    if (!filter || typeof filter !== "object") return undefined;
    const value = (filter as Record<string, unknown>).HashKey;
    return typeof value === "string" ? value : undefined;
  }

  const node: NodeClient = {
    baseUrl: "http://127.0.0.1:9001",
    userHash: "test-user",
    async autoIdentity() {
      return { provisioned: true, userHash: "test-user" };
    },
    async listSchemas() {
      return [];
    },
    async declareAppSchema() {
      throw new Error("declareAppSchema not used by these tests");
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      storeFor(schemaHash).set(keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      storeFor(schemaHash).set(keyHash, fields);
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const store = storeFor(schemaHash);
      const key = hashKeyOf(filter);
      if (key !== undefined) {
        const row = store.get(key);
        const results = row ? [{ fields: row, key: { hash: key, range: null } }] : [];
        return { ok: true, results, returned_count: results.length, total_count: results.length };
      }
      fullScans += 1;
      const results = [...store.entries()].map(([hash, fields]) => ({
        fields,
        key: { hash, range: null },
      }));
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
  };

  return { node, fullScans: () => fullScans };
}

describe("listActiveSituationsIndexed", () => {
  test("fresh node with declared index returns empty without a full scan", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();

    const active = await listActiveSituationsIndexed(node, cfg);

    expect(active).toEqual([]);
    expect(fullScans()).toBe(0);
  });

  test("upserts seed the index and subsequent reads are point-reads", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();

    const { situation: created } = await upsertSituation(node, cfg, {
      slug: "forge-ci-freeze",
      title: "Forge CI freeze",
      status: "active",
      severity: "p1",
    });
    // upsertSituation patches the index directly (point read + point write) —
    // no full scan yet.
    expect(fullScans()).toBe(0);

    const first = await listActiveSituationsIndexed(node, cfg);
    expect(first.map((s) => s.slug)).toEqual([created.slug]);
    expect(fullScans()).toBe(0);

    const second = await listActiveSituationsIndexed(node, cfg);
    expect(second.map((s) => s.slug)).toEqual([created.slug]);
    expect(fullScans()).toBe(0);
  });

  test("rejects a conflicting create and accepts disjoint lists", async () => {
    const cfg = baseConfig();
    const { node } = makeNode();

    await expect(
      upsertSituation(node, cfg, {
        slug: "conflicting-create",
        blocked_actions: ["dispatch-claude-agents"],
        allowed_actions: ["dispatch-claude-agents"],
      }),
    ).rejects.toMatchObject({ code: "conflicting_action_lists" });
    expect(await findSituation(node, cfg, "conflicting-create")).toBeNull();

    const { situation } = await upsertSituation(node, cfg, {
      slug: "disjoint-create",
      blocked_actions: ["restart-lastdbd"],
      allowed_actions: ["read-only-probe"],
    });
    expect(situation.blocked_actions).toEqual(["restart-lastdbd"]);
    expect(situation.allowed_actions).toEqual(["read-only-probe"]);
  });

  test("rejects a conflicting update and leaves the prior record unchanged", async () => {
    const cfg = baseConfig();
    const { node } = makeNode();

    await upsertSituation(node, cfg, {
      slug: "stable-update",
      title: "Stable update",
      blocked_actions: ["dispatch-claude-agents"],
      allowed_actions: [],
    });
    const before = await requireSituation(node, cfg, "stable-update");

    await expect(
      upsertSituation(node, cfg, {
        slug: "stable-update",
        allowed_actions: ["dispatch_claude_agents"],
      }),
    ).rejects.toMatchObject({ code: "conflicting_action_lists" });

    const after = await requireSituation(node, cfg, "stable-update");
    expect(after).toEqual(before);
  });

  test("resolved situations drop out of the index on the next upsert", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();

    await upsertSituation(node, cfg, {
      slug: "forge-ci-freeze",
      title: "Forge CI freeze",
      status: "active",
      severity: "p1",
    });
    await upsertSituation(node, cfg, {
      slug: "forge-ci-freeze",
      status: "resolved",
    });

    const active = await listActiveSituationsIndexed(node, cfg);
    expect(active).toEqual([]);
    expect(fullScans()).toBe(0);
  });

  test("fails closed without scanning when the index schema isn't declared", async () => {
    const cfg = baseConfig();
    cfg.schemaHashes = { situation: SITUATION_HASH, notice: NOTICE_HASH };
    const { node, fullScans } = makeNode();

    await upsertSituation(node, cfg, {
      slug: "pre-upgrade-situation",
      title: "Pre-upgrade",
      status: "active",
      severity: "p2",
    });

    await expect(listActiveSituationsIndexed(node, cfg)).rejects.toMatchObject({
      code: "index_schema_required",
    });
    expect(fullScans()).toBe(0);
  });

  test("--all returns active, resolved, and archived situations through keyed history", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();

    await upsertSituation(node, cfg, { slug: "s1", title: "s1", status: "active", created_at: "2026-07-17T12:00:00.000Z" });
    await upsertSituation(node, cfg, { slug: "s2", title: "s2", status: "resolved", created_at: "2026-07-18T12:00:00.000Z" });
    await upsertSituation(node, cfg, { slug: "s3", title: "s3", status: "archived", created_at: "2026-07-19T12:00:00.000Z" });
    const all = await listSituations(node, cfg);
    expect(all.map((s) => s.slug).sort()).toEqual(["s1", "s2", "s3"]);
    expect(fullScans()).toBe(0);
  });
});

describe("listNoticesIndexed", () => {
  test("fresh node with declared index returns empty without a full scan", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();

    const visible = await listNoticesIndexed(node, cfg, { since: "2h" });

    expect(visible).toEqual([]);
    expect(fullScans()).toBe(0);
  });

  test("default --since window is a point read after the first seed", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();

    await upsertNotice(node, cfg, {
      slug: "notice-1",
      title: "LastDB restarted",
      kind: "restart",
      // Seeded relative to now, with a live TTL. A hardcoded past `at` with the
      // default 24h expiry makes this fixture time-brittle: the index only
      // carries unexpired notices, so a fixed date silently ages out of it.
      at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(fullScans()).toBe(0);

    const visible = await listNoticesIndexed(node, cfg, { since: "2h" });
    expect(visible.map((n) => n.slug)).toEqual(["notice-1"]);
    expect(fullScans()).toBe(0);
  });

  test("--all reads expired notice history without a full scan", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();
    await upsertNotice(node, cfg, {
      slug: "notice-1",
      title: "t",
      at: "2026-07-17T12:00:00.000Z",
      expires_at: "2026-07-18T12:00:00.000Z",
    });

    const visible = await listNoticesIndexed(node, cfg, { all: true });
    expect(visible.map((n) => n.slug)).toEqual(["notice-1"]);
    expect(fullScans()).toBe(0);
  });

  test("a --since window past the index retention reads keyed history buckets", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();
    // Seeded relative to now, like the live-TTL fixture above: a hardcoded
    // `at` silently left the 60d window on 2026-09-15 and the test went red
    // on the calendar, not on a code change. 30 days back is past the index
    // retention and inside the requested window on every date.
    await upsertNotice(node, cfg, {
      slug: "notice-1",
      title: "t",
      at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const visible = await listNoticesIndexed(node, cfg, { since: "60d" });
    expect(visible.map((n) => n.slug)).toEqual(["notice-1"]);
    expect(fullScans()).toBe(0);
  });

  test("fails closed without scanning when the index schema isn't declared", async () => {
    const cfg = baseConfig();
    cfg.schemaHashes = { situation: SITUATION_HASH, notice: NOTICE_HASH };
    const { node, fullScans } = makeNode();
    await upsertNotice(node, cfg, { slug: "notice-1", title: "t", at: "2026-07-17T12:00:00.000Z" });

    await expect(listNoticesIndexed(node, cfg, { since: "2h" })).rejects.toMatchObject({
      code: "index_schema_required",
    });
    expect(fullScans()).toBe(0);
  });

  test("listNotices (--all path) returns every notice through keyed history", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();
    await upsertNotice(node, cfg, { slug: "n1", title: "t", at: "2026-07-17T12:00:00.000Z" });
    const all = await listNotices(node, cfg);
    expect(all.map((n) => n.slug)).toEqual(["n1"]);
    expect(fullScans()).toBe(0);
  });
});
