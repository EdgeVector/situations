import { FsituationsError, type BatchMutationOp, type NodeClient, type QueryRow } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";
import {
  fieldsFor,
  INDEX_ENTRY_MAX_BYTES,
  SEVERITY_VALUES,
  STATUS_VALUES,
  type Severity,
  type SituationStatus,
} from "./schemas.ts";
import { atomBytes } from "./atom-size.ts";
import { hasIndexSchema, readIndexPayload, readLegacyRow, requireIndexSchema } from "./index-cache.ts";
import {
  commitOps,
  dayOf,
  daysPartition,
  deleteOp,
  entryExists,
  hydrateBySlug,
  legacyList,
  mapLimit,
  migrationOpsForWrite,
  normalizeHistoryDays,
  putOp,
  readPartitions,
  requireAll,
  requireLayout,
  trimMarkerOps,
  resolveLayout,
  resolveLayoutInfo,
  unreadable,
  warn,
  type Entry,
  type Layout,
  type PartitionSpec,
} from "./index-entry.ts";

const ACTIVE_SITUATIONS_INDEX_KEY = "active_situations";
const SITUATION_HISTORY_DAYS_INDEX_KEY = "situation_history_days";
const SITUATION_HISTORY_DAY_PREFIX = "situation_history_day:";

type PhaseState = "pending" | "active" | "complete" | "skipped";

type SituationPhase = {
  slug: string;
  label: string;
  state: PhaseState;
  summary: string;
  entry_condition?: string;
  exit_condition?: string;
  blocked_actions?: string[];
  allowed_actions?: string[];
  requires_human_clearance?: string[];
};

export type Situation = {
  slug: string;
  title: string;
  summary: string;
  // "expired" is never persisted (normalizeStatus never accepts it as a
  // write); findSituation/requireSituation compute it on read when an
  // active/monitoring record's expires_at has passed.
  status: SituationStatus | "expired";
  severity: Severity;
  scope_systems: string[];
  scope_repos: string[];
  scope_routines: string[];
  scope_automations: string[];
  current_phase: string;
  phases: SituationPhase[];
  blocked_actions: string[];
  allowed_actions: string[];
  requires_human_clearance: string[];
  preflight_message: string;
  links_kanban: string[];
  links_brain: string[];
  owner: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export type SituationInput = Partial<Situation> & {
  slug: string;
  title?: string;
  phases_json?: string;
};

export type PreflightRequest = {
  action: string;
  repo?: string;
  system?: string;
  routine?: string;
  automation?: string;
};

type PreflightBlock = {
  situation: Situation;
  reason: "blocked" | "requires_human_clearance";
  action: string;
  message: string;
};

/**
 * An active Situation whose preflight_message forbids the requested action while
 * its declared scope does not reach the request. It never changes `ok` — it is
 * the text a caller would otherwise never see.
 */
export type PreflightAdvisory = {
  situation: Situation;
  reason: "out_of_scope_prose_forbids";
  action: string;
  message: string;
};

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function nowIso(): string {
  return new Date().toISOString();
}

export function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new FsituationsError({
      code: "invalid_slug",
      message: `Invalid slug "${slug}".`,
      hint: "Use lowercase letters, digits, hyphens, and underscores; start with a letter or digit.",
    });
  }
}

/**
 * Reject bare `*` in scope_routines / scope_automations for active situations.
 *
 * A bare star is a global fleet kill switch: routinesd skip-fences every
 * scheduled routine, which freezes kanban pickup / board pipeline for
 * unrelated incidents. Prefer empty scope + blocked_actions (action preflight)
 * or narrow globs (`*dmg*`, `*cloud-sync*`). Only allow with an explicit
 * opt-in when the issue is truly fleet-wide.
 */
export function rejectGlobalFleetScope(
  input: { status?: string; scope_routines?: unknown; scope_automations?: unknown },
  opts: { allowGlobal?: boolean } = {},
): void {
  if (opts.allowGlobal) return;
  const status = String(input.status ?? "active").toLowerCase();
  // Resolved/expired records may keep historical * for audit; only active
  // posture can fence the fleet.
  if (status !== "active" && status !== "monitoring") return;

  const bad: string[] = [];
  for (const [field, raw] of [
    ["scope_routines", input.scope_routines],
    ["scope_automations", input.scope_automations],
  ] as const) {
    const list = normalizeList(raw);
    if (list.some((g) => g === "*")) bad.push(field);
  }
  if (bad.length === 0) return;

  throw new FsituationsError({
    code: "global_fleet_scope_forbidden",
    message:
      `${bad.join(" and ")} contain bare "*" — that is a global fleet kill ` +
      `switch (routinesd skip-fences every routine).`,
    hint:
      "Use blocked_actions / requires_human_clearance for the real hazard, " +
      "or narrow globs (e.g. *cloud-sync*, *dmg*). Only if the issue is " +
      "truly fleet-wide: `situations put --allow-global-scope <file>` " +
      "(Tom-only; page Discord needs-human first).",
  });
}

const LIST_FIELDS = [
  "scope_systems",
  "scope_repos",
  "scope_routines",
  "scope_automations",
  "blocked_actions",
  "allowed_actions",
  "requires_human_clearance",
  "links_kanban",
  "links_brain",
] as const;

/**
 * Reject a list field that is not an array of strings (or a comma string).
 *
 * `"requires_human_clearance": false` once reached the live store and made
 * every preflight throw. Normalization now tolerates it, but a boolean in a
 * policy list is ambiguous (did `true` mean "every action"?), so `put` asks
 * the author to say it as a list.
 */
export function rejectMalformedListFields(input: Record<string, unknown>): void {
  const bad: string[] = [];
  for (const field of LIST_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null || typeof value === "string") continue;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) continue;
    bad.push(`${field}=${JSON.stringify(value)}`);
  }
  if (bad.length === 0) return;
  throw new FsituationsError({
    code: "malformed_list_field",
    message: `List fields must be arrays of strings: ${bad.join(", ")}.`,
    hint: 'Use [] for "none", or list the values, e.g. "requires_human_clearance": ["enable-ci"].',
  });
}

export function rejectConflictingActionLists(input: {
  blocked_actions?: unknown;
  allowed_actions?: unknown;
}): void {
  const blocked = new Set(normalizeList(input.blocked_actions).map(normalizeAction));
  const conflicts = normalizeList(input.allowed_actions)
    .map(normalizeAction)
    .filter((action, index, actions) => blocked.has(action) && actions.indexOf(action) === index)
    .sort();
  if (conflicts.length === 0) return;

  throw new FsituationsError({
    code: "conflicting_action_lists",
    message:
      "blocked_actions and allowed_actions contain the same action(s): " +
      conflicts.map((action) => `"${action}"`).join(", ") +
      ".",
    hint:
      "Remove each listed action from either blocked_actions or allowed_actions, " +
      "then rerun `situations put <file>`.",
  });
}

/** The `--system` values a caller passes for one PROSE_POLICY_ACTION. */
export function proseActionScopeSystems(action: string): string[] {
  return ACTION_VOCABULARY[normalizeAction(action)]?.scopeSystems ?? [];
}

/**
 * Reject a hold that exists only in prose.
 *
 * `preflight` matches `blocked_actions` against the request, and only for a
 * Situation whose scope the request reaches. So a hold written as
 * "No primary LastDB upgrade ... is authorized" with scope_systems
 * [loom, host-track] blocks nothing: the nightly release canary preflights
 * `--action lastdb-safe-upgrade`, gets OK, and cuts over Tom's primary during
 * the hold. That happened on 2026-09-25
 * (papercut-situations-preflight-ok-while-situation-text-forbids-primary-upgrade-20260925);
 * only a human noticing the prose stopped it.
 *
 * So when the prose forbids a high-cost action, the record has to say it in the
 * fields preflight reads — the action in a policy list AND a scope the caller's
 * `--system` reaches. Both, because either one alone still answers OK.
 *
 * Called twice: on the raw input, so `put` refuses without a node read, and on
 * the merged record inside `upsertSituation`, which is the one that lands.
 */
export function rejectProseOnlyPolicy(
  input: {
    status?: string;
    preflight_message?: unknown;
    blocked_actions?: unknown;
    allowed_actions?: unknown;
    requires_human_clearance?: unknown;
    scope_systems?: unknown;
    scope_repos?: unknown;
    scope_routines?: unknown;
    scope_automations?: unknown;
    phases?: unknown;
    phases_json?: unknown;
  },
  opts: { allowProseOnly?: boolean } = {},
): void {
  if (opts.allowProseOnly) return;
  const status = String(input.status ?? "active").toLowerCase();
  // A resolved record keeps its prose for the audit trail; it fences nothing.
  if (status !== "active" && status !== "monitoring") return;

  const forbidden = proseForbiddenActions(String(input.preflight_message ?? ""));
  if (forbidden.length === 0) return;

  const phases = parsePhases(input.phases ?? input.phases_json);
  const declared = new Set<string>(
    [
      ...normalizeList(input.blocked_actions),
      ...normalizeList(input.allowed_actions),
      ...normalizeList(input.requires_human_clearance),
      ...phases.flatMap((phase) => [
        ...(phase.blocked_actions ?? []),
        ...(phase.allowed_actions ?? []),
        ...(phase.requires_human_clearance ?? []),
      ]),
    ].map(normalizeAction),
  );
  const scopeSystems = normalizeList(input.scope_systems).map((s) => s.toLowerCase());
  const unscoped =
    scopeSystems.length === 0 &&
    normalizeList(input.scope_repos).length === 0 &&
    normalizeList(input.scope_routines).length === 0 &&
    normalizeList(input.scope_automations).length === 0;

  const problems: string[] = [];
  for (const action of forbidden) {
    const missing: string[] = [];
    if (!declared.has(action) && !declared.has("*")) {
      missing.push(
        `"blocked_actions": ["${action}"] (or allowed_actions, if the prose does not mean it)`,
      );
    }
    const wanted = proseActionScopeSystems(action);
    const reached =
      unscoped ||
      scopeSystems.includes("*") ||
      wanted.some((system) => scopeSystems.includes(system));
    if (!reached && wanted.length > 0) {
      missing.push(`"scope_systems": ["${wanted[0]}"] (a caller passes --system ${wanted[0]})`);
    }
    if (missing.length > 0) problems.push(`${action} → add ${missing.join(" and ")}`);
  }
  if (problems.length === 0) return;

  throw new FsituationsError({
    code: "prose_only_policy",
    message:
      `preflight_message forbids ${problems.length === 1 ? "an action" : "actions"} that ` +
      `preflight cannot see: ${problems.join("; ")}.`,
    hint:
      "preflight only reads blocked_actions / requires_human_clearance, and only " +
      "for a Situation whose scope the caller reaches — prose alone answers OK. " +
      "Declare the action and the scope, or, if the prose is advice rather than a " +
      "hold, `situations put --allow-prose-only-policy <file>` (the text still " +
      "shows up as an ADVISORY on an out-of-scope preflight).",
  });
}

function normalizeList(value: unknown): string[] {
  const input = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const s = String(item).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizeStatus(value: unknown): SituationStatus {
  const s = String(value ?? "active").trim().toLowerCase();
  return (STATUS_VALUES as readonly string[]).includes(s) ? (s as SituationStatus) : "active";
}

function normalizeSeverity(value: unknown): Severity {
  const s = String(value ?? "p2").trim().toLowerCase();
  return (SEVERITY_VALUES as readonly string[]).includes(s) ? (s as Severity) : "p2";
}

function parsePhases(value: unknown): SituationPhase[] {
  if (Array.isArray(value)) return normalizePhases(value);
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? normalizePhases(parsed) : [];
  } catch {
    return [];
  }
}

function normalizePhases(raw: unknown[]): SituationPhase[] {
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const state = String(item.state ?? "pending").toLowerCase();
      const phase: SituationPhase = {
        slug: String(item.slug ?? "").trim(),
        label: String(item.label ?? item.slug ?? "").trim(),
        state: ["pending", "active", "complete", "skipped"].includes(state)
          ? (state as PhaseState)
          : "pending",
        summary: String(item.summary ?? "").trim(),
        blocked_actions: normalizeList(item.blocked_actions),
        allowed_actions: normalizeList(item.allowed_actions),
        requires_human_clearance: normalizeList(item.requires_human_clearance),
      };
      const entry = String(item.entry_condition ?? "").trim();
      const exit = String(item.exit_condition ?? "").trim();
      if (entry) phase.entry_condition = entry;
      if (exit) phase.exit_condition = exit;
      return phase;
    })
    .filter((phase) => phase.slug.length > 0);
}

type NormalizeOptions = {
  touchUpdatedAt?: boolean;
};

export function normalizeSituation(
  input: SituationInput,
  existing?: Situation,
  options: NormalizeOptions = {},
): Situation {
  validateSlug(input.slug);
  const now = nowIso();
  const touchUpdatedAt = options.touchUpdatedAt ?? true;
  // Normalize every list-shaped field on the way in. A JSON input or a cached
  // index payload can carry a non-array (e.g. `"requires_human_clearance":
  // false`); left raw, it reaches the preflight spread and throws a TypeError
  // that silently removes every verdict (2026-09-22 papercut).
  const rawPhases =
    input.phases ??
    (input.phases_json !== undefined ? parsePhases(input.phases_json) : existing?.phases) ??
    [];
  const phases = Array.isArray(rawPhases) ? normalizePhases(rawPhases) : [];
  const currentPhase =
    input.current_phase ??
    existing?.current_phase ??
    phases.find((phase) => phase.state === "active")?.slug ??
    phases[0]?.slug ??
    "";

  return {
    slug: input.slug,
    title: input.title ?? existing?.title ?? input.slug,
    summary: input.summary ?? existing?.summary ?? "",
    status: normalizeStatus(input.status ?? existing?.status),
    severity: normalizeSeverity(input.severity ?? existing?.severity),
    scope_systems: normalizeList(input.scope_systems ?? existing?.scope_systems),
    scope_repos: normalizeList(input.scope_repos ?? existing?.scope_repos),
    scope_routines: normalizeList(input.scope_routines ?? existing?.scope_routines),
    scope_automations: normalizeList(input.scope_automations ?? existing?.scope_automations),
    current_phase: currentPhase,
    phases,
    blocked_actions: normalizeList(input.blocked_actions ?? existing?.blocked_actions),
    allowed_actions: normalizeList(input.allowed_actions ?? existing?.allowed_actions),
    requires_human_clearance: normalizeList(input.requires_human_clearance ?? existing?.requires_human_clearance),
    preflight_message: input.preflight_message ?? existing?.preflight_message ?? "",
    links_kanban: normalizeList(input.links_kanban ?? existing?.links_kanban),
    links_brain: normalizeList(input.links_brain ?? existing?.links_brain),
    owner: input.owner ?? existing?.owner ?? "",
    created_at: existing?.created_at ?? input.created_at ?? now,
    updated_at: touchUpdatedAt ? now : (input.updated_at ?? existing?.updated_at ?? ""),
    expires_at: input.expires_at ?? existing?.expires_at ?? "",
  };
}

export function situationToFields(situation: Situation): Record<string, unknown> {
  return {
    slug: situation.slug,
    title: situation.title,
    summary: situation.summary,
    status: situation.status,
    severity: situation.severity,
    scope_systems: normalizeList(situation.scope_systems),
    scope_repos: normalizeList(situation.scope_repos),
    scope_routines: normalizeList(situation.scope_routines),
    scope_automations: normalizeList(situation.scope_automations),
    current_phase: situation.current_phase,
    phases_json: JSON.stringify(situation.phases),
    blocked_actions: normalizeList(situation.blocked_actions),
    allowed_actions: normalizeList(situation.allowed_actions),
    requires_human_clearance: normalizeList(situation.requires_human_clearance),
    preflight_message: situation.preflight_message,
    links_kanban: normalizeList(situation.links_kanban),
    links_brain: normalizeList(situation.links_brain),
    owner: situation.owner,
    created_at: situation.created_at,
    updated_at: situation.updated_at,
    expires_at: situation.expires_at,
  };
}

export function rowToSituation(row: QueryRow): Situation {
  const f = row.fields;
  return normalizeSituation(
    {
      slug: String(f.slug ?? ""),
      title: String(f.title ?? ""),
      summary: String(f.summary ?? ""),
      status: String(f.status ?? "active") as SituationStatus,
      severity: String(f.severity ?? "p2") as Severity,
      scope_systems: normalizeList(f.scope_systems),
      scope_repos: normalizeList(f.scope_repos),
      scope_routines: normalizeList(f.scope_routines),
      scope_automations: normalizeList(f.scope_automations),
      current_phase: String(f.current_phase ?? ""),
      phases: parsePhases(f.phases_json),
      blocked_actions: normalizeList(f.blocked_actions),
      allowed_actions: normalizeList(f.allowed_actions),
      requires_human_clearance: normalizeList(f.requires_human_clearance),
      preflight_message: String(f.preflight_message ?? ""),
      links_kanban: normalizeList(f.links_kanban),
      links_brain: normalizeList(f.links_brain),
      owner: String(f.owner ?? ""),
      created_at: String(f.created_at ?? ""),
      updated_at: String(f.updated_at ?? ""),
      expires_at: String(f.expires_at ?? ""),
    },
    undefined,
    { touchUpdatedAt: false },
  );
}

/**
 * Raw point-read, no expiry computation. Used internally by `upsertSituation`
 * to read the existing stored record for a merge — a merge must see the
 * literal persisted status, not a read-time "expired" decoration, or an
 * unrelated field update on a lapsed record would normalize its status back
 * to "active" (normalizeStatus falls back to "active" on any value it
 * doesn't recognize, and "expired" is deliberately not a recognized value).
 */
async function fetchSituationRaw(
  node: NodeClient,
  cfg: Config,
  slug: string,
): Promise<Situation | null> {
  validateSlug(slug);
  const res = await node.queryAll({
    schemaHash: schemaHashFor("situation", cfg),
    fields: fieldsFor("situation"),
    filter: { HashKey: slug },
  });
  const row = res.results[0];
  return row ? rowToSituation(row) : null;
}

/** Same expiry rule `activeSituations` filters by, exposed for a single record. */
export function effectiveStatus(situation: Situation, at: Date = new Date()): SituationStatus | "expired" {
  if (situation.status !== "active" && situation.status !== "monitoring") return situation.status;
  if (!situation.expires_at) return situation.status;
  const expires = Date.parse(situation.expires_at);
  if (!Number.isFinite(expires)) return situation.status;
  return expires > at.getTime() ? situation.status : "expired";
}

export async function findSituation(
  node: NodeClient,
  cfg: Config,
  slug: string,
  at: Date = new Date(),
): Promise<Situation | null> {
  const situation = await fetchSituationRaw(node, cfg, slug);
  if (!situation) return null;
  const status = effectiveStatus(situation, at);
  return status === situation.status ? situation : { ...situation, status };
}

export async function requireSituation(
  node: NodeClient,
  cfg: Config,
  slug: string,
): Promise<Situation> {
  const situation = await findSituation(node, cfg, slug);
  if (!situation) {
    throw new FsituationsError({
      code: "not_found",
      message: `Situation "${slug}" not found.`,
    });
  }
  return situation;
}

function situationHistoryDay(createdAt: string): string | null {
  return dayOf(createdAt);
}

function situationHistoryDayKey(day: string): string {
  return `${SITUATION_HISTORY_DAY_PREFIX}${day}`;
}

/**
 * What an index entry holds of one situation.
 *
 * The day entry (`DayEntryPayload`) names a situation and nothing else: a full
 * history read is rare, and it hydrates each record from the Situation schema.
 *
 * The active-set entry (`ActiveEntryPayload`) is read by every preflight. It
 * holds the fields that decide whether the situation is still active, plus the
 * whole situation (`situation`) whenever the entry stays inside the 4 KiB entry
 * budget. One situation is 21 fields = 21 atoms the node must load (and keep in
 * its warm set) per preflight against ONE for the entry; a typical situation is
 * under 1 KiB. A situation that does not fit (a long `phases_json`) keeps only
 * the deciding fields and is hydrated from its record by slug. The record write
 * and the entry write are one batch, so the copy cannot lag the record.
 */
type DayEntryPayload = { created_at: string };
export type ActiveEntryPayload = {
  status: string;
  severity: Severity;
  updated_at: string;
  expires_at: string;
  situation?: Situation;
  /**
   * `legacy`: written by a migration or a drift repair from an old blob. UNTRUSTED:
   * a stale process can write it with a later write time than a newer entry, so a
   * reader decides liveness from the RECORD, never from this entry.
   */
  src?: "legacy";
};

function activeEntryPayload(situation: Situation): ActiveEntryPayload {
  const entry: ActiveEntryPayload = {
    status: situation.status,
    severity: situation.severity,
    updated_at: situation.updated_at,
    expires_at: situation.expires_at,
  };
  const withSituation = { ...entry, situation };
  return atomBytes(JSON.stringify(withSituation)) <= INDEX_ENTRY_MAX_BYTES ? withSituation : entry;
}

function objectOf(stored: unknown, where: string): Record<string, unknown> {
  if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
    return stored as Record<string, unknown>;
  }
  throw unreadable(where, "its payload is not an object");
}

/** A legacy blob item as a situation. An item that is not one THROWS: it is a hold nobody can read. */
function legacySituation(raw: unknown, key: string): Situation {
  if (raw === null || typeof raw !== "object") {
    throw unreadable(`legacy Index row "${key}"`, "an item is not a situation");
  }
  return normalizeSituation(raw as SituationInput, undefined, { touchUpdatedAt: false });
}

function daySpec(day: string, legacyKnown = true): PartitionSpec<DayEntryPayload> {
  const key = situationHistoryDayKey(day);
  return {
    store: "entry",
    hash: key,
    legacyKey: legacyKnown ? key : null,
    checkDrift: false,
    fillMissing: true,
    fromLegacy: (legacy) =>
      legacyList(legacy, key).map((raw) => {
        const situation = legacySituation(raw, key);
        return { id: situation.slug, range: situation.slug, payload: { created_at: situation.created_at } };
      }),
    coerce: (stored, id) => ({
      created_at: String(objectOf(stored, `${key}/${id}`).created_at ?? ""),
    }),
  };
}

export const SITUATION_DAYS_SPEC = daysPartition(SITUATION_HISTORY_DAYS_INDEX_KEY);

export const ACTIVE_SPEC: PartitionSpec<ActiveEntryPayload> = {
  store: "entry",
  hash: ACTIVE_SITUATIONS_INDEX_KEY,
  legacyKey: ACTIVE_SITUATIONS_INDEX_KEY,
  checkDrift: true,
  fillMissing: true,
  fromLegacy: (legacy) =>
    legacyList(legacy, ACTIVE_SITUATIONS_INDEX_KEY).map((raw) => {
      const situation = legacySituation(raw, ACTIVE_SITUATIONS_INDEX_KEY);
      return { id: situation.slug, range: situation.slug, payload: activeEntryPayload(situation) };
    }),
  // An entry with no readable `status` THROWS: it is a hold this gate cannot read.
  coerce(stored, id) {
    const where = `${ACTIVE_SITUATIONS_INDEX_KEY}/${id}`;
    const o = objectOf(stored, where);
    if (typeof o.status !== "string") throw unreadable(where, "it has no `status`");
    let situation: Situation | undefined;
    if (o.situation !== null && typeof o.situation === "object") {
      try {
        situation = normalizeSituation(o.situation as SituationInput, undefined, {
          touchUpdatedAt: false,
        });
      } catch {
        // An unreadable COPY is not used; the record is read instead.
      }
    }
    return {
      status: o.status,
      severity: normalizeSeverity(o.severity),
      updated_at: String(o.updated_at ?? ""),
      expires_at: String(o.expires_at ?? ""),
      ...(situation ? { situation } : {}),
      ...(o.src === "legacy" ? { src: "legacy" as const } : {}),
    };
  },
  // A snapshot from an old blob is stored without its copy of the record and flagged.
  untrusted: ({ situation: _copy, ...rest }) => ({ ...rest, src: "legacy" as const }),
  version: (payload) => payload.updated_at,
  isUntrusted: (payload) => payload.src === "legacy",
};

/** Could an active-set entry still be active at `at`? Same rule as `activeSituations`. */
function activeEntryLive(slug: string, entry: ActiveEntryPayload, at: Date): boolean {
  const probe = { slug, status: entry.status, expires_at: entry.expires_at } as unknown as Situation;
  return activeSituations([probe], at).length > 0;
}

/** The exact command that removes an entry that points at no record (a resolved situation has no active entry). */
function danglingFix(slug: string): string {
  return (
    `echo '{"slug":"${slug}","title":"${slug}","status":"resolved"}' | situations put - ` +
    "(it writes the record as resolved and deletes the entry)."
  );
}

/** Full records by slug. A slug with no record is absent from the map; the caller decides what that means. */
async function hydrateSituations(
  node: NodeClient,
  cfg: Config,
  slugs: readonly string[],
): Promise<Map<string, Situation>> {
  return hydrateBySlug(node, {
    schemaHash: schemaHashFor("situation", cfg),
    fields: fieldsFor("situation"),
    slugs,
    toItem: rowToSituation,
  });
}

/** Only what decides liveness: `status` and `expires_at` (2 atoms, not 21). */
type LiveProbe = { status: string; expires_at: string };

async function probeSituations(
  node: NodeClient,
  cfg: Config,
  slugs: readonly string[],
): Promise<Map<string, LiveProbe>> {
  return hydrateBySlug(node, {
    schemaHash: schemaHashFor("situation", cfg),
    fields: ["status", "expires_at"],
    slugs,
    toItem: (row) => ({
      status: String(row.fields.status ?? ""),
      expires_at: String(row.fields.expires_at ?? ""),
    }),
  });
}

function probeIsLive(slug: string, probe: LiveProbe, at: Date): boolean {
  return activeSituations([{ slug, ...probe } as unknown as Situation], at).length > 0;
}

/** The pre-entry full-history read, for a node that has not loaded the entry schemas yet. */
async function listSituationsLegacy(node: NodeClient, cfg: Config): Promise<Situation[]> {
  const days = normalizeHistoryDays(
    legacyList(
      await readIndexPayload<unknown>(node, cfg, SITUATION_HISTORY_DAYS_INDEX_KEY),
      SITUATION_HISTORY_DAYS_INDEX_KEY,
    ),
  );
  const bySlug = new Map<string, Situation>();
  const active = await readIndexPayload<Situation[]>(node, cfg, ACTIVE_SITUATIONS_INDEX_KEY);
  for (const raw of legacyList(active, ACTIVE_SITUATIONS_INDEX_KEY)) {
    const situation = legacySituation(raw, ACTIVE_SITUATIONS_INDEX_KEY);
    bySlug.set(situation.slug, situation);
  }
  const buckets = await mapLimit(days, 4, (day) =>
    readIndexPayload<Situation[]>(node, cfg, situationHistoryDayKey(day)),
  );
  for (const bucket of buckets) {
    for (const raw of legacyList(bucket, "situation_history_day")) {
      const situation = legacySituation(raw, "situation_history_day");
      const existing = bySlug.get(situation.slug);
      if (!existing || situation.updated_at.localeCompare(existing.updated_at) >= 0) {
        bySlug.set(situation.slug, situation);
      }
    }
  }
  return [...bySlug.values()].sort(compareSituations);
}

/**
 * Full history through the keyed day partitions, never a Situation scan. The
 * partitions name the situations; each situation is read from its own record
 * (one multi-get), so the answer is the record, not a copy that could be stale.
 * An entry that points at no record THROWS.
 */
export async function listSituations(node: NodeClient, cfg: Config): Promise<Situation[]> {
  requireIndexSchema(cfg);
  const layout = await resolveLayout(node, cfg);
  if (!layout) return listSituationsLegacy(node, cfg);

  const [daysState] = await readPartitions(node, cfg, layout, [SITUATION_DAYS_SPEC]);
  const days = normalizeHistoryDays(daysState!.entries.map((entry) => entry.id));
  const legacyDays = daysState!.info.markerIds;
  const partitions = await readPartitions<unknown>(node, cfg, layout, [
    ACTIVE_SPEC,
    ...days.map((day) => daySpec(day, legacyDays === null || legacyDays.has(day))),
  ]);
  // A stored entry with no record THROWS; an id only a marker or a blob lists
  // (resolved, expired, never synced) with no record is gone.
  const strict = new Set<string>();
  const slugs = new Set<string>();
  for (const state of partitions) {
    for (const entry of state.entries) {
      slugs.add(entry.id);
      if (!entry.fromLegacy) strict.add(entry.id);
    }
  }
  const hydrated = await hydrateSituations(node, cfg, [...slugs]);
  requireAll(hydrated, [...strict], "situation", danglingFix);
  return [...hydrated.values()].sort(compareSituations);
}

/** An entry whose liveness is decided from the RECORD: a snapshot from an old blob, or one the blob has a newer version of. */
function isUntrusted(entry: Entry<ActiveEntryPayload>): boolean {
  return Boolean(entry.fromLegacy || entry.decideFromRecord || entry.payload.src === "legacy");
}

/**
 * The pre-entry read, for a node that has not loaded the entry schemas yet. It
 * reads the legacy blob twice before it believes "no row", and it FAILS CLOSED:
 * if the node does not report the legacy Index schema as loaded, or the query
 * fails, the answer is an error (preflight exits 3), never an empty list. A node
 * with the schema loaded and no row is a valid empty answer.
 */
async function listActiveLegacy(
  node: NodeClient,
  cfg: Config,
  indexLoaded: boolean,
  at: Date,
): Promise<Situation[]> {
  if (!hasIndexSchema(cfg) || !indexLoaded) {
    throw new FsituationsError({
      code: "index_schema_not_loaded",
      message:
        "The node has not loaded the situations Index schema, so the active situations cannot be read: run `situations init`.",
      hint: "Fail closed: an empty answer here would let preflight say OK without having looked.",
    });
  }
  const row = await readLegacyRow(node, cfg, ACTIVE_SITUATIONS_INDEX_KEY, { confirmAbsent: true });
  if (!row) return [];
  const restored = legacyList(row.payload, ACTIVE_SITUATIONS_INDEX_KEY).map((raw) =>
    legacySituation(raw, ACTIVE_SITUATIONS_INDEX_KEY),
  );
  return activeSituations(restored, at).sort(compareSituations);
}

/**
 * Cheap default read for preflight and `list`/`notices`: one range query on the
 * `active_situations` partition (a handful of small entries), and a multi-get of
 * only the situations whose entry does not carry them. It never reads every
 * Situation ever filed. A declared-but-empty index is a valid fresh-node state
 * and returns an empty list; `--all` reads the keyed day partitions.
 *
 * Liveness comes from the entry only for a TRUSTED entry (written by `put`, in
 * the same batch as its record). An UNTRUSTED entry (a snapshot copied from an old
 * blob) is decided from the RECORD: its `status` and `expires_at` are probed (2
 * atoms), and only a live one is read in full. So a stale copy with an old expiry
 * can never drop a situation whose record is still active, and a resolved one
 * never blocks.
 *
 * Preflight is the fleet's gate and fails closed: an entry that cannot be read,
 * or that points at no record, THROWS (the CLI answers exit 3) instead of being
 * skipped.
 */
export async function listActiveSituationsIndexed(
  node: NodeClient,
  cfg: Config,
  at: Date = new Date(),
): Promise<Situation[]> {
  const info = await resolveLayoutInfo(node, cfg);
  if (!info.layout) return listActiveLegacy(node, cfg, info.indexLoaded, at);
  requireIndexSchema(cfg);
  const [state] = await readPartitions(node, cfg, info.layout, [ACTIVE_SPEC]);
  const { entries, info: partition } = state!;
  if (partition.drift) {
    warn(
      `legacy Index row "${ACTIVE_SITUATIONS_INDEX_KEY}" changed after it was copied (${partition.legacyUpdatedAt} is newer than ` +
        `${partition.migratedAt}): an older situations binary wrote it. Its entries are read from their records. ` +
        (partition.contested.length > 0
          ? `Entries the blob has newer versions of (${partition.contested.join(", ")}) stay decided from the record until each is put again. `
          : "") +
        "Run one situations binary (`command -v situations`) and `situations doctor`.",
    );
  }

  const trusted = entries.filter((entry) => !isUntrusted(entry));
  const untrusted = entries.filter(isUntrusted);
  const liveTrusted = trusted.filter((entry) => activeEntryLive(entry.id, entry.payload, at));

  // Stage 1: an untrusted entry is probed from its record.
  const probes = await probeSituations(node, cfg, untrusted.map((entry) => entry.id));
  // A STORED untrusted entry with no record is dangling (throw); an id only a
  // marker or a blob listed, with no record, is gone.
  requireAll(probes, untrusted.filter((entry) => !entry.fromLegacy).map((entry) => entry.id), "situation", danglingFix);
  const liveUntrusted = untrusted.filter((entry) => {
    const probe = probes.get(entry.id);
    return probe !== undefined && probeIsLive(entry.id, probe, at);
  });

  // Stage 2: full records for what is live and not carried by its own entry.
  const needFull = [
    ...liveUntrusted.map((entry) => entry.id),
    ...liveTrusted.filter((entry) => !entry.payload.situation).map((entry) => entry.id),
  ];
  const hydrated = await hydrateSituations(node, cfg, needFull);
  requireAll(hydrated, needFull, "situation", danglingFix);

  const found: Situation[] = [
    ...liveTrusted.map((entry) => entry.payload.situation ?? hydrated.get(entry.id)!),
    ...liveUntrusted.map((entry) => hydrated.get(entry.id)!),
  ];
  return activeSituations(found, at).sort(compareSituations);
}

/**
 * Every index write one situation upsert makes, as ops for the SAME batch as
 * the Situation record write (record and entries commit together: a situation
 * that lands but is missing from the active set would answer a preflight OK).
 *
 * It writes only the entries of THIS situation. Another device may have
 * extended or changed any other situation since this process last read it, and a
 * delete from a stale reader has the later write time and wins: so no other
 * entry is read for pruning, rewritten or deleted. A reader drops an entry that
 * has expired by its own clock.
 *
 * Reads first; nothing is written here.
 */
async function situationIndexOps(
  node: NodeClient,
  cfg: Config,
  layout: Layout,
  situation: Situation,
): Promise<BatchMutationOp[]> {
  const day = situationHistoryDay(situation.created_at);

  const activeOps = async (): Promise<BatchMutationOp[]> => {
    const migration = await migrationOpsForWrite(node, cfg, layout, ACTIVE_SPEC);
    const ops = [...migration];
    if (activeSituations([situation]).length > 0) {
      ops.push(
        putOp(layout, "entry", ACTIVE_SITUATIONS_INDEX_KEY, situation.slug, activeEntryPayload(situation)),
      );
    } else {
      ops.push(deleteOp(layout, "entry", ACTIVE_SITUATIONS_INDEX_KEY, situation.slug));
      // It no longer has an entry, so the marker stops listing it (a copy in `ops`
      // already rewrote the marker: leave that one alone).
      if (migration.length === 0) {
        ops.push(...(await trimMarkerOps(node, layout, ACTIVE_SPEC, situation.slug)));
      }
    }
    return ops;
  };
  const dayOps = async (): Promise<BatchMutationOp[]> => {
    if (!day) return [];
    // Every upsert (not only the first) lists the situation under its creation
    // day: a situation filed before history existed is listed by its next update.
    return [
      ...(await migrationOpsForWrite(node, cfg, layout, daySpec(day))),
      putOp(layout, "entry", situationHistoryDayKey(day), situation.slug, {
        created_at: situation.created_at,
      }),
    ];
  };
  const daysOps = async (): Promise<BatchMutationOp[]> => {
    if (!day) return [];
    if (await entryExists(node, layout, "entry", SITUATION_HISTORY_DAYS_INDEX_KEY, day)) return [];
    return [
      ...(await migrationOpsForWrite(node, cfg, layout, SITUATION_DAYS_SPEC)),
      putOp(layout, "entry", SITUATION_HISTORY_DAYS_INDEX_KEY, day, ""),
    ];
  };
  const [active, inDay, inDays] = await Promise.all([activeOps(), dayOps(), daysOps()]);
  return [...active, ...inDay, ...inDays];
}

export async function upsertSituation(
  node: NodeClient,
  cfg: Config,
  input: SituationInput,
  opts: { allowProseOnly?: boolean } = {},
): Promise<{ situation: Situation; action: "created" | "updated" }> {
  // A write that cannot be indexed fails before it writes anything.
  const layout = hasIndexSchema(cfg) ? await requireLayout(node, cfg) : null;
  const existing = await fetchSituationRaw(node, cfg, input.slug);
  const situation = normalizeSituation(input, existing ?? undefined);
  rejectConflictingActionLists(situation);
  // On the MERGED record, not just on the input: `put` patches, so a change that
  // drops blocked_actions while leaving the forbidding prose in place never
  // mentions the prose at all. The record that lands is the one to judge.
  rejectProseOnlyPolicy(situation as unknown as Record<string, unknown>, opts);
  // The Situation record and its index entries are ONE batch: all commit or none
  // do. `update` is an upsert, so create and update are the same write.
  const ops: BatchMutationOp[] = [
    {
      mutationType: "update",
      schemaHash: schemaHashFor("situation", cfg),
      keyHash: situation.slug,
      fields: situationToFields(situation),
    },
    ...(layout ? await situationIndexOps(node, cfg, layout, situation) : []),
  ];
  await commitOps(node, ops);
  return { situation, action: existing ? "updated" : "created" };
}

export function activeSituations(situations: Situation[], at: Date = new Date()): Situation[] {
  return situations.filter((situation) => {
    const status = effectiveStatus(situation, at);
    return status === "active" || status === "monitoring";
  });
}

/**
 * Prose-policy vocabulary.
 *
 * `preflight_message` is written for a human, and for a while it was the ONLY
 * place some holds were expressed (2026-09-25: an active p0 hold said "No
 * primary LastDB upgrade, restart, configuration change, copy or schema
 * workaround is authorized" and `preflight --action lastdb-safe-upgrade`
 * answered OK all day, because the action and the lastdbd system were outside
 * its declared scope — papercut-situations-preflight-ok-while-situation-text-
 * forbids-primary-upgrade-20260925).
 *
 * Reading the prose is worth doing, but only if the read is PRECISE: a match is
 * used to refuse a `put` and to advise a caller, so a false positive costs an
 * author a refusal they cannot understand. Two rules keep it precise:
 *
 *   1. The prohibition and the subject must be in the SAME sentence. A message
 *      that says "Do not ... self-upgrade gbrain" in one sentence and "primary"
 *      in another does not forbid a primary upgrade.
 *   2. A high-cost action names both a TARGET and a VERB, and both must appear.
 *      "Do not restart the primary" forbids a restart, not an upgrade.
 *
 * Measured against the 18 Situation records on this host on 2026-09-25: the
 * keyword-anywhere form matched `lastdb-safe-upgrade` on 3 records (1 true, 2
 * false — "Do not ... self-upgrade gbrain" and "Do not restart the primary for
 * slowness"); this form matches 1 (the true one).
 */
type ActionVocabulary = {
  /** What the action acts ON. At least one must appear in the sentence. */
  targets: RegExp[];
  /** What the action DOES. At least one must appear in the same sentence. */
  verbs: RegExp[];
  /**
   * Systems a caller passes as `--system` for this action. A Situation that
   * forbids the action in prose has to reach one of them through
   * `scope_systems`, or its `blocked_actions` can never fire.
   */
  scopeSystems: string[];
};

const PRIMARY_TARGETS = [/\bprimary\b/, /\blastdbd\b/, /\blastdb mini\b/];

const ACTION_VOCABULARY: Record<string, ActionVocabulary> = {
  "lastdb-safe-upgrade": {
    targets: PRIMARY_TARGETS,
    verbs: [/\bupgrade[sd]?\b/, /\bcut ?over\b/, /\bsafe-upgrade\b/],
    scopeSystems: ["lastdbd", "lastdb", "primary-brain"],
  },
  "lastdb-restart": {
    targets: PRIMARY_TARGETS,
    verbs: [/\brestart(s|ed|ing)?\b/, /\brelaunch(es|ed)?\b/, /\bbounce[sd]?\b/, /\bkill(s|ed)?\b/],
    scopeSystems: ["lastdbd", "lastdb", "primary-brain"],
  },
};

/** Actions `put` checks the prose for. High cost, hard to undo, unattended callers. */
export const PROSE_POLICY_ACTIONS = Object.keys(ACTION_VOCABULARY);

const PROHIBITION_PATTERNS = [
  /\bdo not\b/,
  /\bdon'?t\b/,
  /\bmust not\b/,
  /\bmay not\b/,
  /\bcan ?not\b/,
  /\bnever\b/,
  /\bforbid(s|den)?\b/,
  /\bprohibit(s|ed)?\b/,
  /\bunauthori[sz]ed\b/,
  /\bnot authori[sz]ed\b/,
  /\bno\b/,
];

function sentences(message: string): string[] {
  return message
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function literalActionPatterns(action: string): RegExp[] {
  const words = action.split("-").filter(Boolean);
  if (words.length === 0) return [];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // "merge-pr", "merge pr", "merge_pr" all name the same action in prose.
  return [new RegExp(`\\b${escaped.join("[-_ ]")}\\b`)];
}

/**
 * Does this `preflight_message` forbid `action` in its own words?
 *
 * Sentence-scoped: a prohibition and the action's subject must co-occur. An
 * action with no vocabulary entry needs its literal name in the sentence, which
 * is the only claim prose can make about it without guessing.
 */
export function preflightMessageForbidsAction(message: string, action: string): boolean {
  if (!message || !action) return false;
  const actionNorm = normalizeAction(action);
  const vocab = ACTION_VOCABULARY[actionNorm];
  const subject = vocab ? null : literalActionPatterns(actionNorm);

  for (const sentence of sentences(message)) {
    if (!PROHIBITION_PATTERNS.some((re) => re.test(sentence))) continue;
    if (vocab) {
      if (!vocab.targets.some((re) => re.test(sentence))) continue;
      if (!vocab.verbs.some((re) => re.test(sentence))) continue;
      return true;
    }
    if (subject && subject.some((re) => re.test(sentence))) return true;
  }
  return false;
}

/** Every PROSE_POLICY_ACTION this message forbids in its own words. */
export function proseForbiddenActions(message: string): string[] {
  return PROSE_POLICY_ACTIONS.filter((action) => preflightMessageForbidsAction(message, action));
}

export function preflight(
  situations: Situation[],
  request: PreflightRequest,
  at: Date = new Date(),
) {
  const action = normalizeAction(request.action);
  const blocks: PreflightBlock[] = [];
  const advisories: PreflightAdvisory[] = [];
  for (const situation of activeSituations(situations, at)) {
    if (!scopeMatches(situation, request)) {
      // Out of scope: blocked_actions do not apply, and neither does the prose.
      // Dropping it silently is how a hold written only in prose answered OK all
      // day. Report it; never let it change the verdict, because a forbidding
      // sentence and its own later exception ("the canary is CLEARED to cut over
      // the primary") read the same to a matcher.
      if (preflightMessageForbidsAction(situation.preflight_message, action)) {
        advisories.push({
          situation,
          action,
          message: situation.preflight_message,
          reason: "out_of_scope_prose_forbids",
        });
      }
      continue;
    }
    const phase = situation.phases.find((p) => p.slug === situation.current_phase);
    const blockedActions = [
      ...situation.blocked_actions,
      ...(phase?.blocked_actions ?? []),
    ].map(normalizeAction);
    const clearanceActions = [
      ...situation.requires_human_clearance,
      ...(phase?.requires_human_clearance ?? []),
    ].map(normalizeAction);

    if (matchesAction(blockedActions, action)) {
      blocks.push({
        situation,
        reason: "blocked",
        action,
        message: situation.preflight_message || `${situation.title} blocks ${action}.`,
      });
      continue;
    }
    if (preflightMessageForbidsAction(situation.preflight_message, action)) {
      blocks.push({
        situation,
        reason: "blocked",
        action,
        message: situation.preflight_message || `${situation.title} blocks ${action}.`,
      });
      continue;
    }
    if (matchesAction(clearanceActions, action)) {
      blocks.push({
        situation,
        reason: "requires_human_clearance",
        action,
        message:
          situation.preflight_message ||
          `${situation.title} requires human clearance before ${action}.`,
      });
    }
  }
  return { ok: blocks.length === 0, checked: { ...request, action }, blocks, advisories };
}

function compareSituations(a: Situation, b: Situation): number {
  const sev = SEVERITY_VALUES.indexOf(a.severity) - SEVERITY_VALUES.indexOf(b.severity);
  if (sev !== 0) return sev;
  return b.updated_at.localeCompare(a.updated_at);
}

function normalizeAction(action: string): string {
  return action.trim().toLowerCase().replace(/\s+/g, "-").replace(/_/g, "-");
}

function matchesAction(patterns: string[], action: string): boolean {
  return patterns.some((pattern) => {
    const normalized = normalizeAction(pattern);
    return normalized === "*" || normalized === action;
  });
}

function scopeMatches(situation: Situation, request: PreflightRequest): boolean {
  const scoped =
    situation.scope_repos.length > 0 ||
    situation.scope_systems.length > 0 ||
    situation.scope_routines.length > 0 ||
    situation.scope_automations.length > 0;
  if (!scoped) return true;

  return (
    matchesScopeValue(situation.scope_repos, request.repo) ||
    matchesScopeValue(situation.scope_systems, request.system) ||
    matchesScopeValue(situation.scope_routines, request.routine) ||
    matchesScopeValue(situation.scope_automations, request.automation)
  );
}

function matchesScopeValue(values: string[], requested?: string): boolean {
  if (values.length === 0 || !requested) return false;
  const needle = requested.toLowerCase();
  return values.some((value) => value === "*" || value.toLowerCase() === needle);
}
