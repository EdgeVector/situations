import { describe, expect, test } from "bun:test";

import {
  parseFieldProjection,
  printFieldProjection,
  renderProjectedValue,
  resolveField,
  type FieldProjectionSource,
} from "../src/field-projection.ts";
import { normalizeSituation, type Situation } from "../src/record.ts";
import { FsituationsError } from "../src/client.ts";

function seeded(overrides: Partial<Situation> = {}): Situation {
  return normalizeSituation({
    slug: "forge-ci-containment-freeze",
    title: "Forge CI containment freeze",
    summary: "CI containment is active.",
    status: "active",
    severity: "p0",
    scope_repos: ["EdgeVector/fold", "EdgeVector/lastgit"],
    current_phase: "set-2",
    phases: [
      { slug: "set-1", label: "Detection", state: "complete", summary: "Detected." },
      { slug: "set-2", label: "Containment", state: "active", summary: "Contain." },
    ],
    ...overrides,
  });
}

describe("field projection helpers", () => {
  test("accepts repeated and comma-separated fields", () => {
    expect(parseFieldProjection(["slug,status", "severity"])).toEqual([
      "slug",
      "status",
      "severity",
    ]);
  });

  test("returns [] when no --field given", () => {
    expect(parseFieldProjection(undefined)).toEqual([]);
  });

  test("rejects an all-empty --field value", () => {
    expect(() => parseFieldProjection([" , "])).toThrow(FsituationsError);
  });

  test("resolves dot paths and bracket array indexes", () => {
    const row: FieldProjectionSource = {
      slug: "s1",
      phases: [{ slug: "set-1" }, { slug: "set-2" }],
    };
    expect(resolveField(row, "slug")).toBe("s1");
    expect(resolveField(row, "phases[1].slug")).toBe("set-2");
    expect(resolveField(row, "missing")).toBeUndefined();
  });

  test("renders scalar arrays as comma-joined plain values", () => {
    expect(renderProjectedValue(["EdgeVector/fold", "EdgeVector/lastgit"])).toBe(
      "EdgeVector/fold,EdgeVector/lastgit",
    );
  });

  test("renders a missing field as an empty string", () => {
    expect(renderProjectedValue(undefined)).toBe("");
  });
});

describe("list --field projection over seeded situations", () => {
  test("prints one tab-separated row per situation with the requested fields", () => {
    const lines: string[] = [];
    printFieldProjection(
      [seeded()] as unknown as FieldProjectionSource[],
      ["slug", "status"],
      (line) => lines.push(line),
    );
    expect(lines).toEqual(["forge-ci-containment-freeze\tactive"]);
  });

  test("joins array fields (scope_repos) with commas within the cell", () => {
    const lines: string[] = [];
    printFieldProjection(
      [seeded()] as unknown as FieldProjectionSource[],
      ["slug", "severity", "scope_repos", "current_phase"],
      (line) => lines.push(line),
    );
    expect(lines).toEqual([
      "forge-ci-containment-freeze\tp0\tEdgeVector/fold,EdgeVector/lastgit\tset-2",
    ]);
  });

  test("emits an empty cell for a field the situation does not set", () => {
    const lines: string[] = [];
    printFieldProjection(
      [seeded({ current_phase: "" })] as unknown as FieldProjectionSource[],
      ["slug", "current_phase"],
      (line) => lines.push(line),
    );
    expect(lines).toEqual(["forge-ci-containment-freeze\t"]);
  });
});

describe("preflight --field end-to-end (no node required)", () => {
  const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
  const examplePath = new URL("../examples/forge-ci-containment.json", import.meta.url).pathname;

  async function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(["bun", cliPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code, stdout };
  }

  test("projects the blocking situation as TSV and keeps exit code 3", async () => {
    const { code, stdout } = await runCli([
      "preflight",
      "--file",
      examplePath,
      "--action",
      "enable-ci",
      "--repo",
      "EdgeVector/fold",
      "--field",
      "slug,reason,action",
    ]);
    expect(code).toBe(3);
    expect(stdout.trim()).toBe("forge-ci-containment-freeze\tblocked\tenable-ci");
  });

  test("prints nothing and exits 0 when the action is allowed", async () => {
    const { code, stdout } = await runCli([
      "preflight",
      "--file",
      examplePath,
      "--action",
      "some-unblocked-action",
      "--repo",
      "EdgeVector/fold",
      "--field",
      "slug,reason",
    ]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});
