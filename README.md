# situations

`situations` is a LastDB app for current operational posture: active
situations, phase/set breakdowns, scope, links, agent-facing preflight
policy, and a **non-blocking notice feed** for agent-impacting changes
(upgrades, restarts, cutovers).

It fills the gap between F-Brain and F-Kanban:

- F-Brain stores durable rationale and decisions.
- F-Kanban stores work items.
- **Situations (posture)** store current shared reality agents must respect
  before mutating shared systems.
- **Notices** are time-stamped FYIs so agents can attribute flapping
  (“LastDB was upgraded 8 minutes ago”) without opening a false incident.

| | Situation | Notice |
|---|---|---|
| Job | Constrain agents | Contextualize anomalies |
| Blocks preflight? | Yes | **Never** |
| Lifecycle | Until resolved | Short TTL (default 24h) |

## Agent contract

### 0. `scope_routines` is not a panic button (Tom 2026-07-14)

**Do not set `scope_routines` / `scope_automations` to bare `"*"`** for active
situations unless the issue is *truly* fleet-wide **and** Tom has been paged
on Discord needs-human.

| Field | Job |
|-------|-----|
| `blocked_actions` / `requires_human_clearance` | Stop the **dangerous action** (restore cloud_sync, re-enable CI, …) |
| `scope_systems` / `scope_repos` | Scope **preflight** for agents touching those systems/repos |
| `scope_routines` | Only routines whose **id** should be skip-fenced by routinesd |

A bare `*` is a **global fleet kill switch**: routinesd skip-fences *every*
scheduled routine (kanban pickup, dogfood, probes, …). That froze PR shipping
during the 2026-07-14 cloud-sync memory incident even though the real hazard
was only `reenable-cloud-sync` / restore of `cloud_sync.json`.

**Right shape for a contained subsystem incident:**

- `blocked_actions`: the few verbs that must not run
- `scope_routines`: `[]` **or** narrow globs (`*dmg*`, `*cloud-sync*`)
- `allowed_actions`: keep shipping (`open-pr`, `draft-fix`, …) when safe

`situations put` **rejects** bare `*` on active/monitoring situations unless
you pass `--allow-global-scope` (escape hatch only).

Prior art: DMG deprecation used `["*dmg*", "*desktop*", "*fold-app*"]`, not `*`.

### 1. Posture (must respect)

Agents should check Situations before starting work. Use the readable
default, or `--field` to pull specific columns as plain tab-separated text —
**do not pipe `--json` into `python -c`/`node -e` to reformat it** (that trips
the inline-JSON-parse safety hook):

```bash
situations list                                # human-readable (+ notice banner if any)
situations list --field slug,status,severity   # plain TSV, one row per situation
```

`--field <comma,sep>` is available on `list`, `show`, `preflight`, and
`notices`. It prints the requested fields as tab-separated columns (missing
field → empty cell; array fields like `scope_repos` join with `,`). Common
fields: `slug`, `status`, `severity`, `title`, `current_phase`, `scope_repos`.
On `preflight` it projects the blocking situations (their fields plus
`reason`, `action`, `message`) and prints nothing when the action is allowed:

```bash
situations show forge-ci-containment --field slug,current_phase
situations preflight --action enable-ci --repo EdgeVector/fold --field slug,reason
```

`--json` (full machine-readable output) remains available when you need the
whole record, but prefer `--field` for pulling one or two values.

### 2. Notices (context when things look wrong)

Before declaring an incident, restarting shared infra, or treating timeouts /
socket blips as a new outage, check recent notices:

```bash
situations notices --since 1h
situations notices --since 30m --system lastdbd
situations notices --field slug,at,kind,title
```

If a matching notice exists (e.g. LastDB upgrade), treat symptoms as expected
fallout unless they continue past the notice window.

### 3. Producers (must post after the action)

Skills and scripts that change agent-facing shared systems **must** post a
notice in the same step that did the thing:

```bash
situations notice --title "LastDB upgraded to 0.22.8" --kind upgrade \
  --system lastdbd --system primary-brain \
  --app brain --app kanban --app situations \
  --actor skill:lastdb-safe-upgrade \
  --summary "brew 0.22.7 → 0.22.8; brief socket blips expected ~10–15m" \
  --expires-hours 12
```

Or from JSON: `situations notice put examples/lastdb-upgrade-notice.json`.

Prefer `last-stack-post-notice` (best-effort, never fails the caller) when
Last Stack is installed.

**Known producers (must post after the action):**

| Producer | When |
|---|---|
| `lastdb-safe-upgrade` / `safe-upgrade-lastdb.sh` | GREEN live brew upgrade of lastdbd |
| `last-stack-self-upgrade` | Fast-forward + setup succeeded |
| `last-stack-install-apps` | App clone/link completed |
| `cutover-to-mini.sh` | Mini cutover finished |

Volume rules: only agent-impacting shared systems; one notice per action (not
retry spam); not every PR merge.

## Install

Install the user PATH shim from this checkout:

```bash
bun run install-shim
```

The installer refreshes the durable host-track checkout
`~/.host-track/situations` from `lastdb:///situations` and creates
`~/.local/bin/situations` by default. It also installs the `fsituations`
compatibility alias during the migration. Set `SITUATIONS_INSTALL_BIN` or
`FSITUATIONS_INSTALL_BIN` to choose another directory.

To inspect the current install:

```bash
situations which --json
situations which --check
```

`which --check` exits nonzero when the running checkout is not under
`~/.host-track/situations`.

For direct legacy linking from the current checkout, set
`SITUATIONS_INSTALL_DIRECT=1` before running the installer.

If the shim is not installed but this checkout is available, use the fallback:

```bash
bun --cwd /Users/tomtang/code/edgevector/situations src/cli.ts list --json
```

The old checkout path `/Users/tomtang/code/edgevector/fsituations` remains a
compatibility symlink until the fleet reference sweep lands, so older agent
fallback commands continue to run.

If Situations is not initialized, agents may continue read-only local
inspection, but must not mutate shared systems until the Situation check
succeeds or Tom explicitly clears the action. Shared-system mutations include
CI changes, routine or automation restarts, deployment/release-gate changes, PR
merge settings, and production/shared infrastructure changes.

Before a shared-system mutation, run a scoped preflight:

```bash
situations preflight --action enable-ci --repo EdgeVector/fold
```

If preflight blocks the action or requires human clearance, stop and cite the
Situation slug.

## Observability

The CLI initializes Sentry only when `OBS_SENTRY_DSN` is set. Without a DSN,
startup and command behavior are unchanged. Unexpected top-level failures are
reported with `service=situations-cli`; typed Situations/config errors keep
their normal stderr and exit-code paths.

Supported environment tags:

```bash
OBS_SENTRY_DSN=<resolved-at-launch>   # resolve from LastSecrets; do not commit raw DSNs
OBS_SENTRY_ENVIRONMENT=dev            # optional
OBS_SENTRY_RELEASE=situations@0.1.0   # optional; defaults to package version
```

## Commands

```bash
bun run src/cli.ts schema
bun run src/cli.ts init
# optional pin: bun run src/cli.ts init --schema-hash <canonical-hash> --notice-schema-hash <hash>
bun run src/cli.ts put examples/forge-ci-containment.json
bun run src/cli.ts list
bun run src/cli.ts list --field slug,status,severity
bun run src/cli.ts notice --title "…" --kind upgrade --system lastdbd
bun run src/cli.ts notices --since 30m
bun run src/cli.ts preflight --action enable-ci --repo EdgeVector/fold
bun run src/cli.ts publish-status --json
bun run src/cli.ts deliver-status --dry-run --json
```

`preflight` exits `0` when the action is allowed and `3` when an active
situation blocks the action or requires human clearance. Notices never change
preflight exit codes.

## Admin posture+notices deliver (dogfood)

`situations publish-status` / `situations deliver-status` close the gap between
"situations data on Mini" and "admin can receive it over deliver", reusing the
same `delivery_slice` / `lastdb.slice.v1` path as the kanban admin consumer
(not a second transport).

### What gets published (privacy-safe only)

| Record | Key | Fields |
|--------|-----|--------|
| `fsituations/SituationAdminSnapshot` | `posture-latest` | captured_at, posture/notice counts + JSON bundles, schema_hashes_json |
| `fsituations/SituationAdminPosture` | `<slug>` | slug, severity, status, summary, blocked_actions |
| `fsituations/SituationAdminNotice` | `<slug>` | kind, at, title, summary, systems |

Active/monitoring posture only. Notices default to `--since 24h` (not expired).
Full `phases_json`, preflight message bodies, and secret material are never
written to these slim schemas.

### Dogfood command (stage → approve → mailbox)

v1 **reuses the existing kanban-consumer identity** (deliver is schema-agnostic).
Pass the enrolled admin consumer keys as env/flags — do not commit them:

```bash
export SITUATIONS_ADMIN_RECIPIENT_PUBKEY=...      # ed25519 from enroll-kanban-consumer
export SITUATIONS_ADMIN_MESSAGING_PUBLIC_KEY=...  # x25519 messaging public key
export SITUATIONS_ADMIN_MESSAGING_PSEUDONYM=...   # consumer messaging pseudonym
# optional:
export SITUATIONS_ADMIN_RECIPIENT_NAME=admin

# 1) Publish slim records on Mini
situations publish-status --json

# 2) Stage a delivery (prints delivery_id + record counts; no send yet)
situations deliver-status --max-records 50

# 3) Approve to seal + send delivery_slice through Exemem
situations deliver-status --approve --max-records 50

# Dry-run without Mini writes / network stage:
situations deliver-status --dry-run --json
```

Non-secret evidence to record after a successful `--approve` run: `delivery_id`,
`shared` count, `message_type` (`delivery_slice`), the three schema hashes, and
`posture`/`notices` row counts. Mailbox poll + `openDelivery` with the admin
consumer private key lives in the admin SPA / consumer tooling (sibling card
`admin-situations-tab`), not in this CLI.

## Schema

The app owns `fsituations/Situation` and `fsituations/Notice`. Print payloads:

```bash
bun run src/cli.ts schema --type all
bun run src/cli.ts schema --type notice
```

On LastDB Mini (and other nodes with `POST /api/apps/declare-schema`), bare
`situations init` declares both schemas locally and writes the canonical hashes
to `~/.situations/config.json` — same first-run path as brain/kanban. You can
still pass `--schema-hash` / `--notice-schema-hash` to pin pre-published
schemas, or load payloads from `situations schema` on older nodes that lack
declare-schema.

The CLI still reads `~/.fsituations/config.json` as a compatibility fallback,
and the migration leaves `~/.fsituations` as a symlink to `~/.situations`.
