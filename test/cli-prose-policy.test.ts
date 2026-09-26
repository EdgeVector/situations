import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

const PROSE_ONLY_HOLD = {
  slug: "cli-prose-only-hold",
  title: "Hold Loom deployment",
  status: "active",
  severity: "p0",
  scope_systems: ["loom", "host-track"],
  scope_repos: ["EdgeVector/loom"],
  blocked_actions: ["deploy", "host-track-refresh"],
  preflight_message:
    "Hold Loom deployment until compatibility passes. No primary LastDB upgrade, " +
    "restart, configuration change or copy is authorized.",
};

async function runCli(args: string[], stdin?: string) {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin ?? "");
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("situations put prose-only policy gate", () => {
  // Every `put` here names a config that does not exist, so the validator runs
  // and the store is never reached. Without it this file wrote a live active
  // Situation into Tom's node on the first run.
  const NO_STORE = ["--config", "/nonexistent/situations-test-config.json"];

  test("refuses a hold that only the prose expresses", async () => {
    const { stderr, code } = await runCli(
      ["put", "-", ...NO_STORE],
      JSON.stringify(PROSE_ONLY_HOLD),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("preflight_message forbids");
    expect(stderr).toContain("lastdb-safe-upgrade");
    expect(stderr).toContain('"scope_systems": ["lastdbd"]');
    expect(stderr).toContain("--allow-prose-only-policy");
    // It never reached the store, so the refusal is the only thing that ran.
    expect(stderr).not.toContain("Config not found");
  });

  test("--allow-prose-only-policy gets past the gate", async () => {
    const { stderr, code } = await runCli(
      ["put", "-", "--allow-prose-only-policy", ...NO_STORE],
      JSON.stringify(PROSE_ONLY_HOLD),
    );
    expect(code).toBe(1);
    expect(stderr).not.toContain("preflight_message forbids");
    // Past the gate and into the store, which this test deliberately denies.
    expect(stderr).toContain("Config not found");
  });

  test("declaring the action and the scope gets past the gate", async () => {
    const { stderr } = await runCli(
      ["put", "-", ...NO_STORE],
      JSON.stringify({
        ...PROSE_ONLY_HOLD,
        scope_systems: ["loom", "host-track", "lastdbd"],
        blocked_actions: ["deploy", "lastdb-safe-upgrade", "lastdb-restart"],
      }),
    );
    expect(stderr).not.toContain("preflight_message forbids");
    expect(stderr).toContain("Config not found");
  });
});

describe("situations preflight advisory", () => {
  const dir = mkdtempSync(join(tmpdir(), "situations-prose-"));
  const file = join(dir, "hold.json");
  writeFileSync(file, JSON.stringify(PROSE_ONLY_HOLD));

  test("OK exits 0 and still prints the forbidding sentence", async () => {
    const { stdout, code } = await runCli([
      "preflight",
      "--action",
      "lastdb-safe-upgrade",
      "--system",
      "lastdbd",
      "--file",
      file,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("OK: lastdb-safe-upgrade");
    expect(stdout).toContain("ADVISORY: cli-prose-only-hold");
    expect(stdout).toContain("did not block");
    expect(stdout).toContain("No primary LastDB upgrade");
  });

  test("--json carries the advisory", async () => {
    const { stdout, code } = await runCli([
      "preflight",
      "--action",
      "lastdb-safe-upgrade",
      "--system",
      "lastdbd",
      "--file",
      file,
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      blocks: unknown[];
      advisories: Array<{ reason: string; action: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.blocks).toEqual([]);
    expect(parsed.advisories[0]?.reason).toBe("out_of_scope_prose_forbids");
    expect(parsed.advisories[0]?.action).toBe("lastdb-safe-upgrade");
  });

  test("a declared in-scope action still exits 3", async () => {
    const { stdout, code } = await runCli([
      "preflight",
      "--action",
      "deploy",
      "--repo",
      "EdgeVector/loom",
      "--file",
      file,
    ]);
    expect(code).toBe(3);
    expect(stdout).toContain("BLOCKED: deploy");
  });
});
