import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSituation, preflight, type SituationInput } from "../src/record.ts";

// Shape of the 2026-09-22 fold pickup hold that made every preflight throw
// "Spread syntax requires ...iterable[Symbol.iterator] to be a function":
// scope_routines set AND requires_human_clearance: false (not a list).
const holdInput = {
  slug: "fixture-fold-pickup-hold",
  title: "Fixture fold pickup hold",
  status: "active",
  severity: "p1",
  scope_systems: ["kanban", "routines"],
  scope_repos: ["EdgeVector/fold"],
  scope_routines: ["last-stack-fkanban-pickup", "last-stack-fkanban-pickup-w2"],
  scope_automations: [],
  blocked_actions: ["pickup-card", "claim-card"],
  allowed_actions: ["merge-pr"],
  requires_human_clearance: false,
  phases: [],
  current_phase: "",
} as unknown as SituationInput;

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

function fixture(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "situations-preflight-"));
  const path = join(dir, "situation.json");
  writeFileSync(path, body);
  return path;
}

async function run(args: string[], stdin?: string) {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Point config at a missing file so no test can reach a live store.
    env: {
      ...process.env,
      SITUATIONS_CONFIG: "/nonexistent/situations-test-config.json",
      FSITUATIONS_CONFIG: "/nonexistent/situations-test-config.json",
      FOLDDB_SOCKET_PATH: "/nonexistent/folddb.sock",
    },
  });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("preflight with scope_routines and a non-list policy field", () => {
  test("normalizeSituation turns non-list fields into arrays", () => {
    const s = normalizeSituation(holdInput, undefined, { touchUpdatedAt: false });
    expect(s.requires_human_clearance).toEqual([]);
    expect(s.scope_routines).toEqual([
      "last-stack-fkanban-pickup",
      "last-stack-fkanban-pickup-w2",
    ]);
  });

  test("preflight returns verdicts instead of throwing", () => {
    const s = normalizeSituation(holdInput, undefined, { touchUpdatedAt: false });
    const blocked = preflight([s], { action: "pickup-card", repo: "EdgeVector/fold" });
    expect(blocked.ok).toBe(false);
    expect(blocked.blocks[0]?.reason).toBe("blocked");

    const byRoutine = preflight([s], {
      action: "pickup-card",
      routine: "last-stack-fkanban-pickup-w2",
    });
    expect(byRoutine.ok).toBe(false);

    const otherRepo = preflight([s], { action: "pickup-card", repo: "EdgeVector/loom" });
    expect(otherRepo.ok).toBe(true);
  });

  test("a cached index payload with a raw non-list field still normalizes", () => {
    // listActiveSituationsIndexed restores cached rows through normalizeSituation.
    const cached = { ...(holdInput as object), phases: [{ slug: "p", blocked_actions: "x" }] };
    const s = normalizeSituation(cached as unknown as SituationInput, undefined, { touchUpdatedAt: false });
    expect(s.phases[0]?.blocked_actions).toEqual(["x"]);
    expect(() => preflight([s], { action: "x", repo: "EdgeVector/fold" })).not.toThrow();
  });
});

describe("situations preflight CLI fails closed", () => {
  test("--file fixture with scope_routines gives a BLOCKED verdict (exit 3)", async () => {
    const path = fixture(JSON.stringify(holdInput));
    const r = await run(["preflight", "--action", "pickup-card", "--repo", "EdgeVector/fold", "--file", path]);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("BLOCKED: pickup-card by fixture-fold-pickup-hold");
    expect(r.stderr).not.toContain("TypeError");
  });

  test("--file fixture for another repo gives OK (exit 0)", async () => {
    const path = fixture(JSON.stringify(holdInput));
    const r = await run(["preflight", "--action", "pickup-card", "--repo", "EdgeVector/loom", "--file", path]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK: pickup-card");
  });

  test("a preflight that throws exits 3 with BLOCKED: preflight error", async () => {
    const path = fixture("{ not json");
    const r = await run(["preflight", "--action", "enable-ci", "--repo", "EdgeVector/fold", "--file", path]);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("BLOCKED: preflight error for enable-ci");
  });

  test("--json on a throwing preflight prints ok:false and exits 3", async () => {
    const path = fixture("{ not json");
    const r = await run(["preflight", "--action", "enable-ci", "--file", path, "--json"]);
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; error: { reason: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.reason).toBe("preflight_error");
  });

  test("put rejects a boolean in a list field before any store write", async () => {
    const r = await run(["put", "-"], JSON.stringify(holdInput));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("requires_human_clearance=false");
  });
});
