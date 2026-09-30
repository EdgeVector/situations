import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("LastGit artifact producer config", () => {
  test("publishes the compiled Situations artifact bundle", () => {
    const config = JSON.parse(readFileSync(resolve(root, ".lastgit/artifacts.json"), "utf8")) as {
      artifacts?: Array<{ app?: string; platform?: string; paths?: string[] }>;
    };

    expect(config.artifacts).toEqual([
      { app: "situations", platform: "darwin-arm64", paths: ["dist"] },
    ]);
  });

  test("GitHub workflow gates on ci-required and publishes on a macOS runner", () => {
    const wf = readFileSync(resolve(root, ".github/workflows/ci-required.yml"), "utf8");
    expect(wf).toContain("name: ci-required");
    expect(wf).toContain("EdgeVector/last-stack/.github/workflows/host-track-artifact.yml@main");
    expect(wf).toContain("runs-on: macos-latest");
  });

  test("build script creates executable CLI aliases under dist", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.build).toBe("bash scripts/build-artifact.sh");

    const script = readFileSync(resolve(root, "scripts/build-artifact.sh"), "utf8");
    for (const name of ["situations", "fsituations"]) {
      expect(script).toContain(`dist/${name}`);
    }
    expect(statSync(resolve(root, "scripts/build-artifact.sh")).mode & 0o111).not.toBe(0);
  });

  test("host-track metadata describes verified artifact installation", () => {
    const app = JSON.parse(readFileSync(resolve(root, "fsituations.app.json"), "utf8")) as {
      host_track?: {
        install_mode?: string;
        artifact_app?: string;
        artifact_channel?: string;
        artifact_root?: string;
        install_root?: string;
        links?: Array<{ source: string; target: string }>;
      };
    };

    expect(app.host_track).toMatchObject({
      install_mode: "artifact",
      artifact_app: "situations",
      artifact_channel: "stable",
      artifact_root: "$HOME/.lastgit/artifacts",
      install_root: "$HOME/.host-track/apps/situations",
    });
    expect(app.host_track?.links).toEqual([
      { source: "dist/situations", target: "$HOME/.local/bin/situations" },
      { source: "dist/fsituations", target: "$HOME/.local/bin/fsituations" },
    ]);
  });

  test("compiled artifact alias can report its install root", () => {
    const binary = resolve(root, "dist/fsituations");
    if (!existsSync(binary)) return;

    const proc = Bun.spawnSync({
      cmd: [binary, "which", "--json"],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(payload.app).toBe("situations");
    expect(payload.command).toBe("fsituations");
    expect(payload.executable_path).toBe(binary);
    expect(payload.source_path).toBe(binary);
    expect(payload.checkout_root).toBe(root);
    expect(payload.expected_host_track).toContain("/.host-track/apps/situations");
  });
});
