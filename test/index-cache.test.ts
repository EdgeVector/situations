import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { listActiveSituationsIndexed, listSituations, upsertSituation } from "../src/record.ts";
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
  test("cold start does one full scan, seeds the index, then reads are point-reads", async () => {
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

  test("falls back to a full scan when the index schema isn't declared yet", async () => {
    const cfg = baseConfig();
    cfg.schemaHashes = { situation: SITUATION_HASH, notice: NOTICE_HASH };
    const { node, fullScans } = makeNode();

    await upsertSituation(node, cfg, {
      slug: "pre-upgrade-situation",
      title: "Pre-upgrade",
      status: "active",
      severity: "p2",
    });

    const active = await listActiveSituationsIndexed(node, cfg);
    expect(active.map((s) => s.slug)).toEqual(["pre-upgrade-situation"]);
    expect(fullScans()).toBeGreaterThan(0);
  });

  test("--all path (listSituations) still returns resolved situations via a full scan", async () => {
    const cfg = baseConfig();
    const { node } = makeNode();

    await upsertSituation(node, cfg, { slug: "s1", title: "s1", status: "resolved" });
    const all = await listSituations(node, cfg);
    expect(all.map((s) => s.slug)).toEqual(["s1"]);
  });
});

describe("listNoticesIndexed", () => {
  test("default --since window is a point read after the first seed", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();

    await upsertNotice(node, cfg, {
      slug: "notice-1",
      title: "LastDB restarted",
      kind: "restart",
      at: "2026-07-17T12:00:00.000Z",
    });
    expect(fullScans()).toBe(0);

    const visible = await listNoticesIndexed(node, cfg, { since: "2h" });
    expect(visible.map((n) => n.slug)).toEqual(["notice-1"]);
    expect(fullScans()).toBe(0);
  });

  test("--all bypasses the index with an explicit full scan", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();
    await upsertNotice(node, cfg, { slug: "notice-1", title: "t", at: "2026-07-17T12:00:00.000Z" });

    const visible = await listNoticesIndexed(node, cfg, { all: true });
    expect(visible.map((n) => n.slug)).toEqual(["notice-1"]);
    expect(fullScans()).toBe(1);
  });

  test("a --since window past the index retention falls back to a full scan", async () => {
    const cfg = baseConfig();
    const { node, fullScans } = makeNode();
    await upsertNotice(node, cfg, { slug: "notice-1", title: "t", at: "2026-07-17T12:00:00.000Z" });

    const visible = await listNoticesIndexed(node, cfg, { since: "60d" });
    expect(visible.map((n) => n.slug)).toEqual(["notice-1"]);
    expect(fullScans()).toBe(1);
  });

  test("falls back to a full scan when the index schema isn't declared yet", async () => {
    const cfg = baseConfig();
    cfg.schemaHashes = { situation: SITUATION_HASH, notice: NOTICE_HASH };
    const { node, fullScans } = makeNode();
    await upsertNotice(node, cfg, { slug: "notice-1", title: "t", at: "2026-07-17T12:00:00.000Z" });

    const visible = await listNoticesIndexed(node, cfg, { since: "2h" });
    expect(visible.map((n) => n.slug)).toEqual(["notice-1"]);
    expect(fullScans()).toBeGreaterThan(0);
    // Every read without a declared index schema is a fresh full scan.
    await listNoticesIndexed(node, cfg, { since: "2h" });
    expect(fullScans()).toBe(2);
  });

  test("listNotices (--all path) still returns every notice via a full scan", async () => {
    const cfg = baseConfig();
    const { node } = makeNode();
    await upsertNotice(node, cfg, { slug: "n1", title: "t", at: "2026-07-17T12:00:00.000Z" });
    const all = await listNotices(node, cfg);
    expect(all.map((n) => n.slug)).toEqual(["n1"]);
  });
});
