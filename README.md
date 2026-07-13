# situations

`situations` is a LastDB app for current operational posture: active
situations, phase/set breakdowns, scope, links, and agent-facing preflight
policy.

It fills the gap between F-Brain and F-Kanban:

- F-Brain stores durable rationale and decisions.
- F-Kanban stores work items.
- Situations stores current shared reality that agents must respect before
  mutating shared systems.

## Agent contract

Agents should check F-Situations before starting work. Use the readable
default, or `--field` to pull specific columns as plain tab-separated text —
**do not pipe `--json` into `python -c`/`node -e` to reformat it** (that trips
the inline-JSON-parse safety hook):

```bash
situations list                                # human-readable
situations list --field slug,status,severity   # plain TSV, one row per situation
```

`--field <comma,sep>` is available on `list`, `show`, and `preflight`. It
prints the requested fields as tab-separated columns (missing field → empty
cell; array fields like `scope_repos` join with `,`). Common fields: `slug`,
`status`, `severity`, `title`, `current_phase`, `scope_repos`. On `preflight`
it projects the blocking situations (their fields plus `reason`, `action`,
`message`) and prints nothing when the action is allowed:

```bash
situations show forge-ci-containment --field slug,current_phase
situations preflight --action enable-ci --repo EdgeVector/fold --field slug,reason
```

`--json` (full machine-readable output) remains available when you need the
whole record, but prefer `--field` for pulling one or two values.

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
bun run src/cli.ts init --schema-hash <loaded-fsituations-situation-hash>
bun run src/cli.ts put examples/forge-ci-containment.json
bun run src/cli.ts list
bun run src/cli.ts list --field slug,status,severity
bun run src/cli.ts preflight --action enable-ci --repo EdgeVector/fold
```

`preflight` exits `0` when the action is allowed and `3` when an active
situation blocks the action or requires human clearance.

## Schema

The app owns `fsituations/Situation`. Print the schema payload with:

```bash
bun run src/cli.ts schema --json
```

The schema follows the same published-out-of-band pattern as F-Kanban: the CLI
does not register schemas itself. Publish/load the schema on the node, then run
`init` so the CLI records the canonical hash in `~/.situations/config.json`.
The CLI still reads `~/.fsituations/config.json` as a compatibility fallback,
and the migration leaves `~/.fsituations` as a symlink to `~/.situations`.
