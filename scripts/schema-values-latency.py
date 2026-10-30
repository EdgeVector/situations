#!/usr/bin/env python3
"""Hosted CI comparison of actual exported app functions and explicit ownership conversion."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys

OPERATIONS = ("point_read", "update", "notice_read", "active_list", "publication")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def save(path, value):
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")


def cloud_off(node, output, phase):
    status = node.call("/api/sync/byte-backup-v2", {"action": "status"})[0]
    require(all(status.get(name) is False for name in ("enabled", "automatic_backup_enabled", "running")),
            "The generated node did not confirm that cloud sync stays OFF")
    require(status.get("manual_connection") is None, "The generated node has a cloud connection")
    save(output / f"cloud-off-{phase}.json", status)


def product(args, node, output, label, phase):
    environment = {name: value for name, value in os.environ.items()
                   if not name.startswith(("LASTDB", "FOLD", "SITUATIONS", "FSITUATIONS", "SENTRY", "OBS_", "OTEL_"))
                   and name not in ("GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY")}
    environment.update(LASTDB_SUPPRESS_RECOVERY_PHRASE="1")
    command = ["bun", str(args.worker), "--baseline", str(args.baseline), "--candidate", str(args.candidate),
               "--socket", str(node.socket), "--config", str(output / "config.json"),
               "--output", str(output), "--label", label, "--mode", phase, "--records", str(args.records)]
    # The entrypoint is the exported-functions workload. Never run the Situations CLI.
    with (output / f"{phase}.log").open("w") as stream:
        subprocess.run(command, env=environment, stdout=stream, stderr=stream, check=True, timeout=3600)
    cloud_off(node, output, phase)


def arm(args, Node, finish_setup, label, pair):
    output = args.output / f"pair-{pair}-{label}"
    output.mkdir(mode=0o700)
    fresh = label == "fresh"
    binary, revision = (args.daemon_after, args.daemon_after_revision) if fresh else (args.daemon_before, args.daemon_before_revision)
    node = Node(binary, revision, output, temporary_directory=Path(os.environ["RUNNER_TEMP"]).resolve(),
                full_socket_name="folddb-full.sock", environment={"LASTDB_SELF_METRICS_TO_DB": "false",
                    "LASTDB_BYTE_BACKUP_V2_ENABLED": "false", "LASTDB_TTL_SWEEP": "0"})
    try:
        node.start()
        cloud_off(node, output, "start")
        product(args, node, output, label, "setup")
        finish_setup(node, output)
        node.stop()
        if label == "candidate":
            node.binary, node.revision = args.daemon_after, args.daemon_after_revision
        node.start()
        cloud_off(node, output, "reopen")
        product(args, node, output, label, "measure")
        finish_setup(node, output)
        node.stop()
        node.start()
        cloud_off(node, output, "final-reopen")
        product(args, node, output, label, "verify")
        result = json.loads((output / "result.json").read_text())
        require(result.get("complete") is True and result.get("complete_membership") is True,
                "The product run did not confirm its complete membership")
        result["pair"] = pair
        result["cloud_sync_off"] = True
        result["disk"] = node.disk_breakdown()
        save(output / "result.json", result)
        return result
    finally:
        node.close()


def render(args, arms):
    lines = ["## F-Situations schema ownership and latency", "",
             f"App: `{args.baseline_revision}` → `{args.candidate_revision}`.",
             f"Compatible daemon: `{args.daemon_before_revision}`. Removal daemon: `{args.daemon_after_revision}`.",
             f"Each arm seeds {args.records} situations and {args.records} notices through actual exported app functions.",
             "Two AB/BA pairs each retain 64 samples per operation. A separate fresh owned-home arm retains 16 samples.",
             "The candidate converts the real legacy home on the compatible daemon, then reopens that home on the removal daemon.",
             "The proof checks accepted app-written keys, full values, current atom identities, author metadata, range membership, repeated setup, and flush/reopen.",
             "The legacy summary schema is empty because the current product no longer writes it. Its exact definition still converts.",
             "Cloud sync stays OFF. The workflow does not invoke the Situations CLI or alter app identity gates.",
             "Times cover the complete exported app operation and accepted-write accounting. They exclude the verifier and process startup.", "",
             "| Operation | Before P50 ms | After P50 ms | Before P95 ms | After P95 ms | P95 change |",
             "|---|---:|---:|---:|---:|---:|"]
    for operation in OPERATIONS:
        cells = {}
        for label in ("baseline", "candidate"):
            values = [item["samples_ms"][operation] for item in arms if item["label"] == label]
            require(len(values) == 2 and all(len(samples) == 64 and all(math.isfinite(value) and value > 0 for value in samples)
                                          for samples in values), "The latency sample set is incomplete or invalid")
            cells[label] = [statistics.median(sorted(samples)[math.ceil(len(samples) * percentile) - 1]
                                            for samples in values) for percentile in (.50, .95)]
        old, new = cells["baseline"], cells["candidate"]
        lines.append(f"| {operation} | {old[0]:.3f} | {new[0]:.3f} | {old[1]:.3f} | {new[1]:.3f} | {(new[1]/old[1]-1)*100:+.1f}% |")
    lines.extend(["", "No sample is removed or trimmed. Each arm retains its full raw samples.",
                  "The common untimed verifier uses the candidate adapter for both sources; the baseline adapter lacks a raw metadata call.",
                  "Timed reads, writes, list reads, and publications use their own exact source revision."])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("baseline", "candidate", "worker", "daemon-before", "daemon-after", "lastdb-source", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("baseline-revision", "candidate-revision", "daemon-before-revision", "daemon-after-revision"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--records", type=int, default=64)
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "Hosted CI only")
    require(64 <= args.records <= 256, "Use a declared 64 to 256 record seed")
    require(all(re.fullmatch(r"[a-f0-9]{40}", getattr(args, name)) for name in
                ("baseline_revision", "candidate_revision", "daemon_before_revision", "daemon_after_revision")), "Exact source revisions are required")
    for path, revision in ((args.baseline, args.baseline_revision), (args.candidate, args.candidate_revision),
                           (args.lastdb_source, args.daemon_after_revision)):
        require(subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip() == revision,
                "A source checkout differs from its selected revision")
    runner = Path(os.environ["RUNNER_TEMP"]).resolve()
    require(not args.output.exists() and args.output.parent.resolve().is_relative_to(runner), "A fresh runner output path is required")
    args.output.mkdir(mode=0o700)
    sys.path.insert(0, str(args.lastdb_source / "scripts/benchmarks"))
    from node import Node, file_hash
    from app_multi_key_compare import finish_setup
    result = {"complete": False, "sources": {name: str(value) for name, value in vars(args).items()},
              "binary_sha256": {name: file_hash(getattr(args, name)) for name in ("daemon_before", "daemon_after")}, "arms": []}
    try:
        for pair, order in enumerate((("baseline", "candidate"), ("candidate", "baseline"), ("fresh",))):
            for label in order:
                result["arms"].append(arm(args, Node, finish_setup, label, pair))
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
            stream.write(render(args, result["arms"]))
        result["complete"] = True
    finally:
        save(args.output / "comparison.json", result)


if __name__ == "__main__":
    main()
