#!/usr/bin/env python3
"""Hosted CI comparison of actual exported app functions. Each app version starts on its own fresh home."""
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
# LastDB refuses a record above its record cap.
RECORD_CAP_BYTES = 64 * 1024
LEGACY_SOURCE = "4b76c7c900707b964c90054363ee1a8452600f10"
NATIVE_API = 30


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


def product(args, node, output, label, phase, api_version):
    environment = {name: value for name, value in os.environ.items()
                   if not name.startswith(("LASTDB", "FOLD", "SITUATIONS", "FSITUATIONS", "SENTRY", "OBS_", "OTEL_"))
                   and name not in ("GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY")}
    environment.update(LASTDB_SUPPRESS_RECOVERY_PHRASE="1")
    command = ["bun", str(args.worker), "--baseline", str(args.baseline), "--candidate", str(args.candidate),
               "--socket", str(node.socket), "--config", str(output / "config.json"),
               "--output", str(output), "--label", label, "--mode", phase, "--records", str(args.records),
               "--api-version", str(api_version)]
    # The entrypoint is the exported-functions workload. Never run the Situations CLI.
    with (output / f"{phase}.log").open("w") as stream:
        subprocess.run(command, env=environment, stdout=stream, stderr=stream, check=True, timeout=3600)
    cloud_off(node, output, phase)


def finish_setup(node, output, cleanup):
    # Setup reclamation is a one-time cost, outside the steady-state requests.
    flushed = node.call("/api/db/flush", {})[0]
    require(flushed.get("durable") is True, "The app setup lacks a durable flush")
    save(output / "setup-cleanup.json", cleanup.request_and_wait(node))


def nightly_node(Node, expected_version):
    """The lastdb helper Node, for a prebuilt nightly daemon (the same shared fix as brain).

    The helper requires `bench-<revision>` in /api/version, the stamp of a CI cargo build. A nightly
    reports `<core>-nightly.<date>.g<oid9>` instead, so this subclass swallows only that one refusal while
    the daemon is still alive, then binds the running daemon to the selected source. This is valid only
    with workers=0: start() skips its worker-count check after the version refusal. No arm passes workers.
    """
    class NightlyNode(Node):
        def start(self):
            require(not self.workers, "NightlyNode does not check a worker count")
            try:
                super().start()
            except RuntimeError as error:
                if ("differs from the selected revision" not in str(error)
                        or self.process is None or self.process.poll() is not None):
                    raise
            # The caller's finally block stops the daemon and removes the owned home.
            version = json.dumps(json.loads((self.output / "version.json").read_text()))
            if "-nightly." not in version or f".g{self.revision[:9]}" not in version:
                raise RuntimeError("The actual daemon version is not the nightly of the selected revision")
            if expected_version not in version:
                raise RuntimeError("The actual daemon version differs from the nightly build version")
    return NightlyNode


def arm(args, Node, cleanup, label, pair):
    output = args.output / f"pair-{pair}-{label}"
    output.mkdir(mode=0o700)
    prefix = "before_daemon" if label == "baseline" else "daemon"
    binary, revision, expected_version = (
        getattr(args, prefix + suffix) for suffix in ("", "_revision", "_version")
    )
    node = nightly_node(Node, expected_version)(
        binary, revision, output, temporary_directory=Path(os.environ["RUNNER_TEMP"]).resolve(),
                environment={"LASTDB_SELF_METRICS_TO_DB": "false",
                    "LASTDB_BYTE_BACKUP_V2_ENABLED": "false", "LASTDB_TTL_SWEEP": "0"})
    try:
        node.start()
        # The home marker exists after the first start. Record the format the nightly writes.
        save(output / "home-format.json", {"format": node.home_format()})
        version = node.call("/api/version")[0]
        api = (version.get("data") or version).get("api_version", 0)
        if label == "baseline" and revision == LEGACY_SOURCE:
            require(api == 26 and node.home_format() == 11, "The legacy baseline identity differs")
        else:
            require(api >= NATIVE_API, "A native app arm lacks the complete-record API")
        cloud_off(node, output, "start")
        product(args, node, output, label, "setup", api)
        finish_setup(node, output, cleanup)
        node.stop()
        node.start()
        cloud_off(node, output, "reopen")
        product(args, node, output, label, "measure", api)
        finish_setup(node, output, cleanup)
        node.stop()
        node.start()
        cloud_off(node, output, "final-reopen")
        product(args, node, output, label, "verify", api)
        result = json.loads((output / "result.json").read_text())
        require(result.get("complete") is True and result.get("complete_membership") is True,
                "The product run did not confirm its complete membership")
        require(json.loads((output / "final-reopen.json").read_text()).get("complete") is True,
                "The final flush/reopen did not prove the complete app values")
        result["pair"] = pair
        result["api_version"] = api
        result["daemon_revision"] = revision
        result["daemon_version"] = expected_version
        result["home_format"] = node.home_format()
        result["cloud_sync_off"] = True
        result["disk"] = node.disk_breakdown()
        save(output / "result.json", result)
        return result
    finally:
        node.close()


def render(args, arms):
    stacks = {item["label"]: item for item in arms}
    daemon_lines = [
        f'{label.capitalize()} daemon: `{item["daemon_version"]}` at `{item["daemon_revision"]}` '
        f'(API {item["api_version"]}, home format {item["home_format"]}).'
        for label, item in stacks.items()
    ]
    pages = sorted({str(item.get("snapshot_pages")) for item in arms})
    largest = max(item.get("snapshot_page_max_field_bytes", 0) for item in arms)
    lines = ["## F-Situations schema ownership and latency", "",
             f"App: `{args.baseline_revision}` → `{args.candidate_revision}`.",
             *daemon_lines,
             ("This migration comparison changes both app and daemon. Do not attribute the timing change to the app alone."
              if args.before_daemon_revision != args.daemon_revision
              else "Both arms use the same daemon. Each declared schema owns its values."),
             f"Admin snapshot: {', '.join(pages)} page records per publication. The largest page holds {largest:,} field value bytes."
             f" LastDB refuses a record above {RECORD_CAP_BYTES:,} bytes.",
             f"Each arm seeds {args.records} situations and {args.records} notices through actual exported app functions.",
             "Two AB/BA pairs each retain 64 samples per operation. Each arm starts on its own fresh home.",
             "The proof checks accepted app-written keys, full values, record metadata, range membership, repeated setup, and flush/reopen.",
             "The legacy summary schema is empty because the current product no longer writes it.",
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
                  "The untimed verifier uses the matching wire contract for each arm.",
                  "Timed reads, writes, list reads, and publications use their own exact source revision."])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("baseline", "candidate", "worker", "daemon", "before-daemon", "lastdb-source", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("baseline-revision", "candidate-revision", "daemon-revision", "daemon-version",
                 "daemon-archive-sha256", "before-daemon-revision", "before-daemon-version",
                 "before-daemon-archive-sha256"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--records", type=int, default=64)
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "Hosted CI only")
    require(64 <= args.records <= 256, "Use a declared 64 to 256 record seed")
    require(all(re.fullmatch(r"[a-f0-9]{40}", getattr(args, name)) for name in
                ("baseline_revision", "candidate_revision", "daemon_revision", "before_daemon_revision")),
            "Exact source revisions are required")
    require(args.before_daemon_revision in (args.daemon_revision, LEGACY_SOURCE),
            "The before daemon is neither the current release nor the exact legacy baseline")
    for prefix in ("daemon", "before_daemon"):
        revision, version, digest = (getattr(args, prefix + suffix)
                                     for suffix in ("_revision", "_version", "_archive_sha256"))
        require(f".g{revision[:9]}" in version, "The nightly build version does not name its source")
        require(re.fullmatch(r"[a-f0-9]{64}", digest), "The verified archive checksum is required")
    for path, revision in ((args.baseline, args.baseline_revision), (args.candidate, args.candidate_revision),
                           (args.lastdb_source, args.daemon_revision)):
        require(subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip() == revision,
                "A source checkout differs from its selected revision")
    runner = Path(os.environ["RUNNER_TEMP"]).resolve()
    require(not args.output.exists() and args.output.parent.resolve().is_relative_to(runner), "A fresh runner output path is required")
    args.output.mkdir(mode=0o700)
    (args.output / "revisions.txt").write_text(
        f"App before: {args.baseline_revision}\nApp after: {args.candidate_revision}\n"
        f"Daemon before: {args.before_daemon_version}, source {args.before_daemon_revision}, "
        f"archive SHA-256 {args.before_daemon_archive_sha256}\n"
        f"Daemon after: {args.daemon_version}, source {args.daemon_revision}, "
        f"archive SHA-256 {args.daemon_archive_sha256}\n"
    )
    sys.path.insert(0, str(args.lastdb_source / "scripts/benchmarks"))
    sys.path.append(str(args.lastdb_source / "scripts/disk_v2"))
    from node import Node, file_hash
    import cleanup
    result = {"complete": False, "sources": {name: str(value) for name, value in vars(args).items()},
              "binary_sha256": {"daemon": file_hash(args.daemon), "before_daemon": file_hash(args.before_daemon)},
              "arms": []}
    try:
        for pair, order in enumerate((("baseline", "candidate"), ("candidate", "baseline"))):
            for label in order:
                result["arms"].append(arm(args, Node, cleanup, label, pair))
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
            stream.write(render(args, result["arms"]))
        result["complete"] = True
    finally:
        save(args.output / "comparison.json", result)


if __name__ == "__main__":
    main()
