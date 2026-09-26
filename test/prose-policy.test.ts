import { describe, expect, test } from "bun:test";

import {
  normalizeSituation,
  preflight,
  situationToFields,
  upsertSituation,
  preflightMessageForbidsAction,
  proseForbiddenActions,
  rejectProseOnlyPolicy,
  type Situation,
} from "../src/record.ts";
import { FsituationsError } from "../src/client.ts";
import type { NodeClient, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";

/**
 * The record this whole file exists for. Scope reaches loom and host-track; the
 * hold on the primary lives only in the prose, so `preflight --action
 * lastdb-safe-upgrade --system lastdbd` answered OK all day on 2026-09-25 while
 * the release canary was free to cut the primary over.
 */
const LOOM_HOLD_MESSAGE =
  "Hold Loom merge/deployment until the storage task proves compatibility with " +
  "the installed existing schema and updates this Situation. No primary LastDB " +
  "upgrade, restart, configuration change, copy or schema workaround is authorized. " +
  "Task-specific compatible source repair and isolated synthetic proof may continue.";

/** Real message that the keyword-anywhere matcher called a primary-upgrade hold. */
const GBRAIN_MESSAGE =
  "No more gbrain (Tom 2026-09-25). The brain is LastDB: brain ask/get/put/append/papercut. " +
  "Do not read, write, sync, migrate or self-upgrade gbrain. Re-enabling gbrain needs Tom.";

/** Real message that forbids a restart of the primary, and no upgrade. */
const OFFLOAD_MESSAGE =
  "Do not add a new consumer to the primary LastDB. Do not restart the primary for " +
  "slowness; slow reads are the known state this plan repairs.";

function loomHold(overrides: Partial<Situation> = {}): Situation {
  return normalizeSituation({
    slug: "loom-budget-schema-deployment-hold",
    title: "Hold Loom budget-recovery deployment",
    summary: "Hold until existing-schema compatibility passes.",
    status: "active",
    severity: "p0",
    scope_systems: ["loom", "host-track"],
    scope_repos: ["EdgeVector/loom"],
    blocked_actions: ["artifact-promote", "merge-pr", "deploy", "host-track-refresh"],
    preflight_message: LOOM_HOLD_MESSAGE,
    ...overrides,
  } as Situation);
}

describe("preflightMessageForbidsAction is sentence-scoped", () => {
  test("the sentence that forbids a primary upgrade matches", () => {
    expect(preflightMessageForbidsAction(LOOM_HOLD_MESSAGE, "lastdb-safe-upgrade")).toBe(true);
    expect(preflightMessageForbidsAction(LOOM_HOLD_MESSAGE, "lastdb-restart")).toBe(true);
  });

  test('"Do not ... self-upgrade gbrain" is not a primary-upgrade hold', () => {
    // The old matcher took any negation keyword anywhere plus the word
    // "upgrade" anywhere, so this real record forbade lastdb-safe-upgrade.
    expect(preflightMessageForbidsAction(GBRAIN_MESSAGE, "lastdb-safe-upgrade")).toBe(false);
  });

  test("forbidding a restart of the primary does not forbid an upgrade of it", () => {
    expect(preflightMessageForbidsAction(OFFLOAD_MESSAGE, "lastdb-restart")).toBe(true);
    expect(preflightMessageForbidsAction(OFFLOAD_MESSAGE, "lastdb-safe-upgrade")).toBe(false);
  });

  test("a prohibition and a subject in DIFFERENT sentences do not match", () => {
    const split = "Do not merge anything today. A primary upgrade is scheduled for Friday.";
    expect(preflightMessageForbidsAction(split, "lastdb-safe-upgrade")).toBe(false);
  });

  test("an action with no vocabulary needs its literal name in the sentence", () => {
    expect(preflightMessageForbidsAction("Do not run enable-ci here.", "enable-ci")).toBe(true);
    expect(preflightMessageForbidsAction("Do not run enable ci here.", "enable-ci")).toBe(true);
    expect(preflightMessageForbidsAction("Do not touch the runners.", "enable-ci")).toBe(false);
  });

  test("a mention without a prohibition is not a hold", () => {
    expect(preflightMessageForbidsAction("Primary upgrade in progress.", "lastdb-safe-upgrade"))
      .toBe(false);
  });

  test("proseForbiddenActions reports every checked action the text forbids", () => {
    expect(proseForbiddenActions(LOOM_HOLD_MESSAGE).sort()).toEqual([
      "lastdb-restart",
      "lastdb-safe-upgrade",
    ]);
    expect(proseForbiddenActions(GBRAIN_MESSAGE)).toEqual([]);
  });
});

describe("preflight reports an out-of-scope prose hold as an advisory", () => {
  test("OK stays OK, and the sentence is returned", () => {
    const result = preflight([loomHold()], { action: "lastdb-safe-upgrade", system: "lastdbd" });
    expect(result.ok).toBe(true);
    expect(result.blocks).toEqual([]);
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]?.reason).toBe("out_of_scope_prose_forbids");
    expect(result.advisories[0]?.situation.slug).toBe("loom-budget-schema-deployment-hold");
    expect(result.advisories[0]?.message).toContain("No primary LastDB");
  });

  test("an in-scope declared action still blocks, with no advisory", () => {
    const result = preflight([loomHold()], { action: "deploy", repo: "EdgeVector/loom" });
    expect(result.ok).toBe(false);
    expect(result.advisories).toEqual([]);
  });

  test("an unrelated action gets no advisory", () => {
    const result = preflight([loomHold()], { action: "pickup", system: "kanban" });
    expect(result.ok).toBe(true);
    expect(result.advisories).toEqual([]);
  });

  test("a resolved situation advises nothing", () => {
    const result = preflight([loomHold({ status: "resolved" })], {
      action: "lastdb-safe-upgrade",
      system: "lastdbd",
    });
    expect(result.ok).toBe(true);
    expect(result.advisories).toEqual([]);
  });
});

describe("rejectProseOnlyPolicy", () => {
  function put(overrides: Record<string, unknown> = {}, opts = {}) {
    return () =>
      rejectProseOnlyPolicy(
        {
          status: "active",
          scope_systems: ["loom", "host-track"],
          scope_repos: ["EdgeVector/loom"],
          blocked_actions: ["artifact-promote", "merge-pr", "deploy", "host-track-refresh"],
          preflight_message: LOOM_HOLD_MESSAGE,
          ...overrides,
        },
        opts,
      );
  }

  test("refuses the real record, naming the action and the scope to add", () => {
    let err: FsituationsError | undefined;
    try {
      put()();
    } catch (e) {
      err = e as FsituationsError;
    }
    expect(err).toBeInstanceOf(FsituationsError);
    expect(err?.code).toBe("prose_only_policy");
    expect(err?.message).toContain("lastdb-safe-upgrade");
    expect(err?.message).toContain("blocked_actions");
    expect(err?.message).toContain("scope_systems");
    expect(err?.hint).toContain("--allow-prose-only-policy");
  });

  test("accepts it once the action and the scope are declared", () => {
    expect(
      put({
        scope_systems: ["loom", "host-track", "lastdbd"],
        blocked_actions: ["deploy", "lastdb-safe-upgrade", "lastdb-restart"],
      }),
    ).not.toThrow();
  });

  test("the action alone is not enough — preflight still answers OK out of scope", () => {
    expect(
      put({ blocked_actions: ["deploy", "lastdb-safe-upgrade", "lastdb-restart"] }),
    ).toThrow(/scope_systems/);
  });

  test("the scope alone is not enough", () => {
    expect(put({ scope_systems: ["loom", "lastdbd"] })).toThrow(/blocked_actions/);
  });

  test("requires_human_clearance counts as declaring the action", () => {
    expect(
      put({
        scope_systems: ["lastdbd"],
        requires_human_clearance: ["lastdb-safe-upgrade", "lastdb-restart"],
      }),
    ).not.toThrow();
  });

  test("allowed_actions counts — the prose may carry an exception the matcher cannot read", () => {
    expect(
      put({
        scope_systems: ["lastdbd"],
        allowed_actions: ["lastdb-safe-upgrade", "lastdb-restart"],
      }),
    ).not.toThrow();
  });

  test("a phase list counts as declaring the action", () => {
    expect(
      put({
        scope_systems: ["lastdbd"],
        blocked_actions: [],
        phases: [
          {
            slug: "hold",
            label: "Hold",
            state: "active",
            summary: "Hold.",
            blocked_actions: ["lastdb-safe-upgrade", "lastdb-restart"],
          },
        ],
      }),
    ).not.toThrow();
  });

  test("an unscoped record needs no scope_systems — every preflight reaches it", () => {
    expect(
      put({
        scope_systems: [],
        scope_repos: [],
        blocked_actions: ["lastdb-safe-upgrade", "lastdb-restart"],
      }),
    ).not.toThrow();
  });

  test("a resolved record keeps its prose for the audit trail", () => {
    expect(put({ status: "resolved" })).not.toThrow();
  });

  test("the override accepts it and says so", () => {
    expect(put({}, { allowProseOnly: true })).not.toThrow();
  });

  test("a record whose prose forbids nothing checked is untouched", () => {
    expect(put({ preflight_message: GBRAIN_MESSAGE })).not.toThrow();
  });
});

describe("upsertSituation judges the record that lands, not the patch", () => {
  const cfg: Config = {
    configVersion: 1,
    nodeUrl: "http://127.0.0.1:9001",
    schemaServiceUrl: "",
    userHash: "test-user",
    schemaHashes: { situation: "test-situation-schema" },
  };

  /** Fake node holding one already-correct hold, recording every write. */
  function nodeWith(stored: Situation, writes: string[]): NodeClient {
    const row: QueryRow = {
      fields: situationToFields(stored),
      key: { hash: stored.slug, range: null },
    };
    return {
      baseUrl: cfg.nodeUrl,
      userHash: cfg.userHash,
      async autoIdentity() {
        return { provisioned: true, userHash: cfg.userHash };
      },
      async listSchemas() {
        return [];
      },
      async declareAppSchema() {
        throw new Error("not used");
      },
      async createRecord({ keyHash }) {
        writes.push(`create:${keyHash}`);
      },
      async updateRecord({ keyHash }) {
        writes.push(`update:${keyHash}`);
      },
      async queryAll() {
        return { ok: true, results: [row], returned_count: 1, total_count: 1 };
      },
    };
  }

  const stored = loomHold({
    scope_systems: ["loom", "host-track", "lastdbd"],
    blocked_actions: ["deploy", "lastdb-safe-upgrade", "lastdb-restart"],
  });

  test("a patch that drops the declaration while keeping the prose is refused", async () => {
    const writes: string[] = [];
    const node = nodeWith(stored, writes);
    // The patch never mentions preflight_message, so a check on the input alone
    // sees no prose and passes.
    await expect(
      upsertSituation(node, cfg, { slug: stored.slug, blocked_actions: ["deploy"] }),
    ).rejects.toThrow(/lastdb-safe-upgrade/);
    expect(writes).toEqual([]);
  });

  test("a patch that leaves the declaration alone lands", async () => {
    const writes: string[] = [];
    const node = nodeWith(stored, writes);
    const result = await upsertSituation(node, cfg, {
      slug: stored.slug,
      summary: "Still held; storage task has the ball.",
    });
    expect(result.action).toBe("updated");
    expect(writes).toEqual([`update:${stored.slug}`]);
  });

  test("the override still gets a dropped declaration past the merged check", async () => {
    const writes: string[] = [];
    const node = nodeWith(stored, writes);
    const result = await upsertSituation(
      node,
      cfg,
      { slug: stored.slug, blocked_actions: ["deploy"] },
      { allowProseOnly: true },
    );
    expect(result.action).toBe("updated");
    expect(writes).toEqual([`update:${stored.slug}`]);
  });
});
