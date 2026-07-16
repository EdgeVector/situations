import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOP_HELP, usageFor } from "../src/cli.ts";

function advertisedCommands(topHelp: string): string[] {
  const match = topHelp.match(/^Commands:\n([\s\S]*?)\n\nCommon flags:/m);
  const commandsBlock = match?.[1];
  if (!commandsBlock) throw new Error("TOP_HELP is missing a Commands section");
  return commandsBlock
    .split("\n")
    .map((line) => line.match(/^\s{2}([a-z-]+)/)?.[1])
    .filter((command): command is string => Boolean(command));
}

describe("CLI help", () => {
  test("advertised commands have command-specific help", () => {
    const commands = advertisedCommands(TOP_HELP);
    expect(commands).toEqual([
      "init",
      "schema",
      "put",
      "list",
      "show",
      "preflight",
      "notice",
      "notices",
      "publish-status",
      "deliver-status",
      "which",
      "version",
      "help",
    ]);
    expect(commands).toContain("notice");
    expect(commands).toContain("notices");

    for (const command of commands) {
      const help = usageFor(command);
      expect(help).not.toBe(TOP_HELP);
      expect(help).toContain(`situations ${command}`);
    }
  });

  test("which reports install path details as JSON", () => {
    const repoRoot = new URL("..", import.meta.url).pathname;
    const proc = Bun.spawnSync({
      cmd: ["bun", "src/cli.ts", "which", "--json"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(payload.app).toBe("situations");
    expect(payload.command).toBe("situations");
    expect(payload.source_path).toContain("/src/cli.ts");
    expect(payload.checkout_root).toBe(repoRoot.replace(/\/$/, ""));
    expect(typeof payload.in_host_track).toBe("boolean");
  });

  test("bin shim invokes the CLI entrypoint", () => {
    const repoRoot = new URL("..", import.meta.url).pathname;
    const proc = Bun.spawnSync({
      cmd: ["bin/situations", "which", "--json"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(payload.app).toBe("situations");
    expect(payload.checkout_root).toBe(repoRoot.replace(/\/$/, ""));
  });

  test("symlinked bin shim resolves the checkout root", () => {
    const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const tmp = mkdtempSync(join(tmpdir(), "situations-shim-"));
    const shim = join(tmp, "situations");
    symlinkSync(join(repoRoot, "bin", "situations"), shim);
    const proc = Bun.spawnSync({
      cmd: [shim, "which", "--json"],
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(payload.app).toBe("situations");
    expect(payload.checkout_root).toBe(repoRoot);
  });
});
