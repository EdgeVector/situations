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
`~/.host-track/situations` from `http://localhost:3300/EdgeVector/situations.git` and creates
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
bun run src/cli.ts init     # once after an upgrade: declares + pins IndexEntry and NoticeHistory
bun run src/cli.ts doctor   # read only: schemas, legacy copy, drift, unreadable entries
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

The app owns eight separate record types. The types include the situation, notice,
summary, membership, history, and three privacy-safe publication schemas. Print the definitions:

```bash
bun run src/cli.ts schema --type all
bun run src/cli.ts schema --type notice
```

Setup requires LastDB API 13 or later (lastdb#803), `owned_app_schemas_v1`,
`independent_hash_range_v1`, and the eight exact definitions in schema service.
From API 13 the node owns the values of each declared schema, so setup refuses
an older node. Setup saves the definition identities separately from the
runtime addresses. The optional `--schema-hash` and
`--notice-schema-hash` flags assert definition identities. They cannot replace
the returned runtime address. Unsupported nodes and incomplete replies cause an error.

Canonical field reuse shares definitions only. The eight record types keep
their own values. The publication records contain summaries; they do not use
alternate keys on the full source records. A publication request uses the saved
owned schemas and one batch for each bounded set of writes.

The CLI still reads `~/.fsituations/config.json` as a compatibility fallback,
and the migration leaves `~/.fsituations` as a symlink to `~/.situations`.

### Index layout (a list that grows is one record per entry)

A LastDB node refuses one atom above its ceiling (256 KiB by default since
lastdb#154; HTTP 413 `atom_content_too_large`), and one field value is one
atom. A list that grows is therefore never one field. The old `fsituations/Index`
schema kept every list as one JSON blob and its blobs measured 66 to 161 KB and
grew 40 KB in a day: each notice rewrote a whole blob. Now:

- `fsituations/Index` (Hash) is LEGACY and READ ONLY. Nothing writes it. Each
  blob is read to seed the partitions below and is never rewritten or deleted.
  `recent_notices` is read only by a node that has not run `situations init` yet.
- `fsituations/IndexEntry_hashrange_v1` (HashRange, `ie_h` x `ie_r`): one record
  of at most 4 KiB per entry. No TTL.
- `fsituations/NoticeHistory_hashrange_v1` (HashRange, `nh_h` x `nh_r`): the
  notice log, shaped for a node TTL. Its range key starts with 20 digits.

| Schema | Partition (hash) | Entry key (range) | Entry holds |
|---|---|---|---|
| `IndexEntry` | `active_situations` | situation slug | `status`, `severity`, `updated_at`, `expires_at`, and the situation when it fits; `src: legacy` on a copy from an old blob |
| `IndexEntry` | `situation_history_day:<YYYY-MM-DD>` | situation slug | `created_at` |
| `IndexEntry` | `situation_history_days` | `YYYY-MM-DD` | nothing |
| `IndexEntry` | `notice_history_days` | `YYYY-MM-DD` | nothing |
| `IndexEntry` | `notice_long_expiry` | `<20-digit unix seconds of expires_at>#<slug>` | as a notice history entry; only long-lived notices |
| `NoticeHistory` | `notice_history_day:<YYYY-MM-DD>` (UTC day of `at`) | `<20-digit unix seconds of created_at>#<slug>` | `at`, `created_at`, `expires_at`, `kind`, `scope_systems`, `scope_apps`, and the notice when it fits |

A partition is read with one range query and grown with one small write. An
entry carries the whole notice or situation only when it stays under 4 KiB,
which every real one does (about 1 KiB). One record is 14 to 21 fields, and each
field is an atom the node loads and keeps in its warm set, against one atom for
the entry. A record that does not fit is read from its own schema by slug with
one multi-get (`HashRangeKeys`). `put` and `notice` write the record and its
entries in ONE `POST /api/mutations/batch`.

**A write touches only the entry of the record it writes.** Several devices may
write at once; per atom the last writer wins. A writer therefore never reads a
list, rewrites it, or deletes another entry (a stale reader's delete would have
the later write time and win). A reader drops an entry that has expired by its
own clock.

**Multi-device (the database keeps conflicts; the app owns the shape).**
1. Different slugs never conflict: each has its own record and its own entry.
2. The same slug is written by `put` as one batch, so one device wins both the
   record and the entry.
3. An entry copied from an old blob is UNTRUSTED: liveness comes from the
   RECORD, so a stale copy written later than a newer entry cannot change an
   answer. Both devices migrating at once, or a marker that syncs before its
   entries, fall back to the blob and the record, and are safe for that reason.
4. A reader never writes a trusted entry, and never deletes one.

**Preflight fails closed.** An entry that cannot be parsed, or that points at no
record, stops `preflight` with exit 3 (and `list --all`, `notices`) instead of
being skipped; the message names the command that removes it
(`echo '{"slug":"X","title":"X","status":"resolved"}' | situations put -`). A
node that has not loaded the legacy `Index` schema, or a failed read, is an error
and never an empty list; a node with the schema loaded and no row is a valid
empty answer (the legacy blob is read twice before "no row" is believed).

#### Default notices list

There is no cached "recent notices" row any more: it was one atom rewritten by
every writer (two writers lost a notice from it for good) and it had to be
capped. `situations notices` reads the day partitions that can hold the notice:
`--all` every day, `--since <window>` the days of the window, and with neither
today and yesterday (UTC), because the default expiry is 24 h from `at`.

The default list shows the **50 newest** non-expired notices and ends with
`N more notices; use --all or --since` (on stderr with `--json` or `--field`, so
stdout stays one JSON array). `--all` and `--since` are not capped.

A notice with a custom expiry over 24 h (revenant-watch uses 168 h), a future
`at`, or no expiry would be missed by the day read. Each also gets a small entry
in `notice_long_expiry`, keyed by when it expires, that the default read
includes (an ordered range read of the entries that have not expired yet).
`situations init` seeds it once from the legacy `recent_notices` blob.

#### TTL-ready shape (PROPOSED; this code sets no policy)

A node TTL (lastdb#155) reads the entry time from the first 20 digits of a range
key: a key in any other form never expires. So `NoticeHistory` uses
`<20-digit zero-padded unix seconds of created_at>#<slug>` (`created_at` never
changes, so an update rewrites one key; the slug is the text after the first
`#`). A negative or non-finite time THROWS instead of clamping to 0 (a TTL would
delete that entry at once). The hash is a UTC DAY slice, never an hour slice: the
node's registry of hash partitions never shrinks. Migration marker keys use year
2286 so a TTL never reaches them. `IndexEntry` (active set, situation history,
the day lists, `notice_long_expiry`) is not a log and gets no TTL; the day lists
grow by one tiny record a day.

After a TTL the marker of a notice day still lists the ids it copied. A notice
day does not read the legacy blob for a listed id with no entry (that entry is an
expired one; reading the blob would bring it back), so `notices --all` never
fails on it.

Proposed policy: `Notice` 90 days (docs/design-lastdb-atom-ceiling-and-lifecycle.md,
section 3.5). The manifest TTL step is built separately. A policy has no
backfill, must exist before the first write, and must name BOTH installed names
of the schema (`fsituations/NoticeHistory` and its canonical hash). Entries
written before a policy exists will never expire.

#### Migration from the old blobs (per partition, nothing deleted, no scan)

A reader or writer that finds a partition not yet copied reads that partition's
legacy blob and copies its entries in with ONE batch that ends with marker
records `__migrated__.<k>`: `{ migrated_at, chunk, of, ids }`: the `updated_at`
of the blob that was read (not the local clock, so a later write by an older
binary is always newer, and clock skew cannot hide it) and the ids (slugs or days)
it contained. Rules:

1. A marker is written only after a legacy row with at least one entry was
   really copied. A partition with no legacy row is never marked, because a
   missed read looks exactly like no row; it re-checks the legacy row on each
   read (one point read, asked twice before a reader believes "no row").
2. A copy writes ONLY the ids that are absent, and never rewrites an entry. For
   `active_situations` the copy is UNTRUSTED (`src: legacy`, no copy of the
   record): a stale process can write it with a LATER write time than a newer
   entry, so a reader decides liveness from the RECORD (it probes `status` and
   `expires_at`, 2 atoms, and reads the record in full only when it is live). A
   situation the new binary `put`s again gets a trusted entry again. A reader
   never promotes an entry itself: a promotion written from an older read of the
   record could overwrite a newer entry (last writer wins).
3. A reader trusts a marker only for the ids it lists, and only when every chunk
   is present. A listed id with no entry (a device synced the marker before the
   entries) is asked for twice, then served from the legacy blob and read from its
   record; a listed id whose record is gone is gone, not an error. A `put` that
   resolves a situation also drops it from the marker, so this costs nothing
   afterwards.
4. For a gate partition (`active_situations` and the two day lists), a legacy
   `updated_at` newer than the marker's `migrated_at` means an older binary wrote
   the blob after the copy ("drift"). Absent ids are copied (untrusted); a stored
   entry the blob has a newer version of is decided from the record and drift
   stays visible (stderr warning, `situations doctor` FAIL) until it is put again.
5. The legacy rows stay on the node for ever.

#### Upgrade and rollout

CAUTION: the host-track entry for `situations` (last-stack,
`config/host-track/apps.json`) has `soak_hours: 1` and probes `--help` and `list`.
A new build goes live after the soak, and both probes pass on a node that has not
run `situations init`; but `put` and `notice` fail until `situations init` has run.
So the last-stack host-track change below (a `post_install` that runs
`situations init`, and a `doctor` probe) must land BEFORE this change is
installed. It is not part of this repo.

Required order (the schemas must be declared while the old binary is current,
because a `put` or `notice` never declares and fails until they are):

1. Refresh the candidate (`app-safe-upgrade situations`, never a hand flip of
   `~/.local/bin`).
2. Run the CANDIDATE's `situations init` while the old binary is still current
   (it declares and pins `IndexEntry` and `NoticeHistory` and seeds the
   long-lived notices; harmless to the old binary). A node started from a release
   build with no `EXEMEM_ENV` uses the PROD Schema Service; a proof node must set
   `EXEMEM_ENV=dev`.
3. Activate.
4. Run `situations list`, then `situations doctor` (read only; exits 1 on a
   failed check), then `command -v situations`.

Before `init`, `situations preflight` and the list reads keep using the legacy
blobs (and fail closed if the node does not have the Index schema), and
`put`/`notice` fail at once, before any write, with
`situations init has not been run on this node ... run situations init`. A
config that cannot be written (a read-only home) works: with no pin the schemas
the node has loaded are used.

The host-track entry for `situations` lives in last-stack
(`config/host-track/apps.json`), not here. It needs: `post_install` set to a small
script that runs the candidate's `init`
(`"$HOST_TRACK_INSTALL_ROOT/versions/$HOST_TRACK_MANIFEST_DIGEST/dist/situations" init`),
`safe_upgrade.post_install_phase: "before-probe"`, and a third probe
`["dist/situations","doctor"]` (the existing probes are `--help` and `list`, which
pass before `init`).

Rollout hazard: an OLD binary writes only the legacy blob and the new preflight
reads the entries (drift is read from the records, see rule 4); the NEW `put`
stops writing the blob, so an old preflight misses situations put by the new
binary. No other reader exists (last-stack, routines, fkanban, loom, brain and
lastdb were searched). Flip once and do not run both.

## Standard canonical vocabulary

`src/canonical-fields.json` defines 53 standard concepts for the five operational schemas and three status publication schemas.
Publication uses their exact names, descriptions, types, and versions.
The command interface keeps its local names.
Exact-schema maps translate projections, mutations, batches, and schema metadata.
Delivery field selections use the same canonical vocabulary.
Record values, keys, cursors, and JSON payloads remain intact.

Fresh-home init submits canonical definitions through normal schema declarations.
The schema service checks names, definitions, types, and concept reuse for every caller.
No special vocabulary key or operator approval path exists.
Existing configs without field maps retain legacy definitions and data identities.
Init does not migrate those values.
Full timestamps use `DateTime`; optional expiration dates and decimal counts keep explicit text definitions.
