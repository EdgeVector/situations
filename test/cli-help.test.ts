import { describe, expect, test } from "bun:test";

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
});
