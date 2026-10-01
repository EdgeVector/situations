import { describe, expect, test } from "bun:test";

import {
  activeSituations,
  effectiveStatus,
  findSituation,
  normalizeSituation,
  preflight,
  rejectConflictingActionLists,
  rejectGlobalFleetScope,
  requireSituation,
  situationToFields,
  rowToSituation,
  upsertSituation,
  type Situation,
} from "../src/record.ts";
import { FsituationsError } from "../src/client.ts";
import type { NodeClient, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";

function baseSituation(overrides: Partial<Situation> = {}): Situation {
  return normalizeSituation({
    slug: "forge-ci-containment-freeze",
    title: "Forge CI containment freeze",
    summary: "CI containment is active.",
    status: "active",
    severity: "p0",
    scope_repos: ["EdgeVector/fold"],
    scope_systems: ["forge-ci"],
    // Prefer empty / narrow globs — bare "*" is a global fleet kill switch.
    scope_routines: [],
    current_phase: "set-2",
    phases: [
      {
        slug: "set-1",
        label: "Detection",
        state: "complete",
        summary: "Detected.",
      },
      {
        slug: "set-2",
        label: "Containment",
        state: "active",
        summary: "Prevent accidental re-enable.",
        blocked_actions: ["merge-release"],
      },
    ],
    blocked_actions: ["enable-ci", "reenable-automation"],
    requires_human_clearance: ["change-ci-policy"],
    preflight_message: "Do not re-enable CI without clearance.",
    ...overrides,
  });
}

describe("rejectGlobalFleetScope", () => {
  test("rejects bare * in scope_routines for active situations", () => {
    expect(() =>
      rejectGlobalFleetScope({
        status: "active",
        scope_routines: ["*"],
        scope_automations: [],
      }),
    ).toThrow(FsituationsError);
  });

  test("allows empty scope and narrow globs", () => {
    expect(() =>
      rejectGlobalFleetScope({
        status: "active",
        scope_routines: ["*dmg*", "*desktop*"],
        scope_automations: [],
      }),
    ).not.toThrow();
    expect(() =>
      rejectGlobalFleetScope({
        status: "active",
        scope_routines: [],
        scope_automations: [],
      }),
    ).not.toThrow();
  });

  test("allows bare * only with allowGlobal or non-active status", () => {
    expect(() =>
      rejectGlobalFleetScope(
        { status: "active", scope_routines: ["*"] },
        { allowGlobal: true },
      ),
    ).not.toThrow();
    expect(() =>
      rejectGlobalFleetScope({ status: "resolved", scope_routines: ["*"] }),
    ).not.toThrow();
  });
});

describe("rejectConflictingActionLists", () => {
  test("rejects and names each normalized conflict", () => {
    try {
      rejectConflictingActionLists({
        blocked_actions: ["dispatch-claude-agents", "restart_lastdbd"],
        allowed_actions: ["restart-lastdbd", "dispatch-claude-agents"],
      });
      throw new Error("expected conflicting action lists to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(FsituationsError);
      expect((err as FsituationsError).code).toBe("conflicting_action_lists");
      expect((err as Error).message).toContain('"dispatch-claude-agents"');
      expect((err as Error).message).toContain('"restart-lastdbd"');
    }
  });

  test("allows valid disjoint lists", () => {
    expect(() =>
      rejectConflictingActionLists({
        blocked_actions: ["restart-lastdbd"],
        allowed_actions: ["read-only-probe"],
      }),
    ).not.toThrow();
  });
});

describe("preflight", () => {
  test("blocks matching active situations by action and repo scope", () => {
    const result = preflight([baseSituation()], {
      action: "enable_ci",
      repo: "EdgeVector/fold",
    });

    expect(result.ok).toBe(false);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.reason).toBe("blocked");
    expect(result.blocks[0]?.situation.slug).toBe("forge-ci-containment-freeze");
  });

  test("combines current phase policy with top-level policy", () => {
    const result = preflight([baseSituation()], {
      action: "merge release",
      repo: "EdgeVector/fold",
    });

    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("blocked");
  });

  test("requires human clearance when configured", () => {
    const result = preflight([baseSituation()], {
      action: "change-ci-policy",
      system: "forge-ci",
    });

    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("requires_human_clearance");
  });

  test("ignores resolved situations and non-matching scope", () => {
    const resolved = baseSituation({ status: "resolved" });
    const otherRepo = baseSituation({ slug: "other-ci-freeze", scope_repos: ["EdgeVector/lastgit"] });

    expect(preflight([resolved], { action: "enable-ci", repo: "EdgeVector/fold" }).ok).toBe(true);
    expect(preflight([otherRepo], { action: "enable-ci", repo: "EdgeVector/fold" }).ok).toBe(true);
  });

  test("treats unexpired monitoring situations as active", () => {
    const situation = baseSituation({
      status: "monitoring",
      expires_at: "2026-07-08T00:00:00.000Z",
    });

    const active = activeSituations([situation], new Date("2026-07-07T00:00:00.000Z"));
    expect(active).toHaveLength(1);
  });

  test("preflight_message forbidding text blocks upgrade actions", () => {
    const situation = baseSituation({
      slug: "budget-deployment-hold",
      title: "Budget schema deployment hold",
      summary: "Primary upgrades are forbidden during schema migration.",
      scope_repos: [],
      scope_systems: [],
      blocked_actions: [],
      requires_human_clearance: [],
      preflight_message: "Do not perform primary upgrades during this deployment.",
    });

    const result = preflight([situation], { action: "lastdb-safe-upgrade" });
    expect(result.ok).toBe(false);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.reason).toBe("blocked");
    expect(result.blocks[0]?.situation.slug).toBe("budget-deployment-hold");
    expect(result.blocks[0]?.message).toContain("Do not perform primary upgrades");
  });

  test("preflight_message forbidding without negation keywords does not block", () => {
    const situation = baseSituation({
      slug: "notice-only",
      title: "Notice of upgrade",
      blocked_actions: [],
      requires_human_clearance: [],
      preflight_message: "Primary upgrade in progress.",
    });

    const result = preflight([situation], { action: "lastdb-safe-upgrade" });
    expect(result.ok).toBe(true);
  });
});

describe("record mapping", () => {
  test("round-trips phases through fields", () => {
    const situation = baseSituation();
    const fields = situationToFields(situation);
    const row: QueryRow = {
      fields,
      key: { hash: situation.slug, range: null },
    };

    const restored = rowToSituation(row);
    expect(restored.phases.map((phase) => phase.slug)).toEqual(["set-1", "set-2"]);
    expect(restored.current_phase).toBe("set-2");
    expect(restored.blocked_actions).toEqual(["enable-ci", "reenable-automation"]);
    expect(restored.created_at).toBe(situation.created_at);
    expect(restored.updated_at).toBe(situation.updated_at);
  });

  test("reads are pure and preserve updated_at across repeated gets", async () => {
    const stored = {
      ...baseSituation(),
      updated_at: "2026-07-12T18:49:06.950Z",
    };
    const row: QueryRow = {
      fields: situationToFields(stored),
      key: { hash: stored.slug, range: null },
    };
    const updates: string[] = [];
    const cfg: Config = {
      configVersion: 1,
      nodeUrl: "http://127.0.0.1:9001",
      schemaServiceUrl: "",
      userHash: "test-user",
      schemaHashes: { situation: "test-situation-schema" },
    };
    const node: NodeClient = {
      baseUrl: cfg.nodeUrl,
      userHash: cfg.userHash,
      async autoIdentity() {
        return { provisioned: true, userHash: cfg.userHash };
      },
      async listSchemas() {
        return [];
      },
      async declareAppSchema() {
        throw new Error("read path must not declare schemas");
      },
      async createRecord() {
        throw new Error("read path must not create records");
      },
      async updateRecord({ keyHash }) {
        updates.push(keyHash);
        throw new Error("read path must not update records");
      },
      async queryAll() {
        return { ok: true, results: [row], returned_count: 1, total_count: 1 };
      },
    };

    const first = await requireSituation(node, cfg, stored.slug);
    const second = await requireSituation(node, cfg, stored.slug);

    expect(first.updated_at).toBe("2026-07-12T18:49:06.950Z");
    expect(second.updated_at).toBe(first.updated_at);
    expect(updates).toEqual([]);
  });
});

describe("expiry-aware status", () => {
  function cfgFor(hash: string): Config {
    return {
      configVersion: 1,
      nodeUrl: "http://127.0.0.1:9001",
      schemaServiceUrl: "",
      userHash: "test-user",
      schemaHashes: { situation: hash },
    };
  }

  function nodeWithStore(initial: Situation): {
    node: NodeClient;
    stored: () => Record<string, unknown>;
  } {
    let fields = situationToFields(initial);
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
        throw new Error("not exercised by this fixture");
      },
      async createRecord() {
        throw new Error("not exercised: record already exists");
      },
      async updateRecord({ fields: next }) {
        fields = next;
      },
      async queryAll() {
        return {
          ok: true,
          results: [{ fields, key: { hash: initial.slug, range: null } }],
          returned_count: 1,
          total_count: 1,
        };
      },
    };
    return { node, stored: () => fields };
  }

  test("findSituation/requireSituation report an expired active record as expired, not active", async () => {
    const stored = baseSituation({
      slug: "expiry-test-active",
      status: "active",
      expires_at: "2026-01-01T00:00:00.000Z",
    });
    const { node } = nodeWithStore(stored);
    const cfg = cfgFor("test-situation-schema");
    const at = new Date("2026-01-02T00:00:00.000Z");

    const found = await findSituation(node, cfg, stored.slug, at);
    expect(found?.status).toBe("expired");

    // Regression shape for the original incident: nobody re-upserted the
    // record after expires_at passed, so the stored row still literally
    // says status=active. A direct `show` read must not repeat that claim.
    expect(stored.status).toBe("active");
  });

  test("findSituation leaves an unexpired or non-active/monitoring record untouched", async () => {
    const future = baseSituation({
      slug: "expiry-test-future",
      status: "monitoring",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    expect(effectiveStatus(future)).toBe("monitoring");

    const resolved = baseSituation({
      slug: "expiry-test-resolved",
      status: "resolved",
      expires_at: "2026-01-01T00:00:00.000Z",
    });
    expect(effectiveStatus(resolved, new Date("2026-06-01T00:00:00.000Z"))).toBe("resolved");
  });

  test("activeSituations and findSituation agree on the same expired record", async () => {
    const stored = baseSituation({
      slug: "expiry-test-agree",
      status: "active",
      expires_at: "2026-01-01T00:00:00.000Z",
    });
    const at = new Date("2026-01-02T00:00:00.000Z");

    expect(activeSituations([stored], at)).toEqual([]);

    const { node } = nodeWithStore(stored);
    const found = await findSituation(node, cfgFor("test-situation-schema"), stored.slug, at);
    expect(found?.status).toBe("expired");
  });

  test("upsertSituation merges against the literal stored status, not the expiry-computed one", async () => {
    const stored = baseSituation({
      slug: "expiry-test-merge",
      status: "monitoring",
      expires_at: "2026-01-01T00:00:00.000Z",
    });
    const { node, stored: storedFields } = nodeWithStore(stored);
    const cfg = cfgFor("test-situation-schema");

    // Patch an unrelated field, long after expiry, without touching status.
    const { situation } = await upsertSituation(node, cfg, {
      slug: stored.slug,
      summary: "Refreshed detail, lifetime not renewed.",
    });

    // If the merge read the expiry-computed "expired" value instead of the
    // raw stored one, normalizeStatus would reject "expired" (not a
    // recognized write value) and silently fall back to "active" — wrongly
    // reactivating a lapsed fence as a side effect of an unrelated edit.
    expect(situation.status).toBe("monitoring");
    expect((storedFields() as { status?: unknown }).status).toBe("monitoring");
  });
});
