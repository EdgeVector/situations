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

Volume rules: only agent-impacting shared systems; one notice per action (not
retry spam); not every PR merge.

## Install

Install the user PATH shim from this checkout:

```bash
bun run install-shim
```

The installer creates `~/.local/bin/situations` by default, or `~/bin` when
that is the user bin directory already on PATH. It also installs the
`fsituations` compatibility alias during the migration. Set
`FSITUATIONS_INSTALL_BIN` to choose another directory.

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
```

`preflight` exits `0` when the action is allowed and `3` when an active
situation blocks the action or requires human clearance. Notices never change
preflight exit codes.

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
