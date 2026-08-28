import { describe, expect, test } from "bun:test";

describe("situations put action-list validation", () => {
  const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

  test("returns nonzero and names every conflicting action", async () => {
    const proc = Bun.spawn(["bun", cliPath, "put", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(
      JSON.stringify({
        slug: "conflicting-cli-input",
        blocked_actions: ["dispatch-claude-agents", "restart_lastdbd"],
        allowed_actions: ["restart-lastdbd", "dispatch-claude-agents"],
      }),
    );
    proc.stdin.end();

    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain('"dispatch-claude-agents"');
    expect(stderr).toContain('"restart-lastdbd"');
  });
});
