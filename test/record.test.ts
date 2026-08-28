import { describe, expect, test } from "bun:test";

import {
  activeSituations,
  normalizeSituation,
  preflight,
  rejectConflictingActionLists,
  rejectGlobalFleetScope,
  requireSituation,
  situationToFields,
  rowToSituation,
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
