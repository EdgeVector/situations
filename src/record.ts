import { FsituationsError, type NodeClient, type QueryRow } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";
import { fieldsFor, SEVERITY_VALUES, STATUS_VALUES, type Severity, type SituationStatus } from "./schemas.ts";
import { hasIndexSchema, readIndexPayload, requireIndexSchema, writeIndexPayload } from "./index-cache.ts";

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
  status: SituationStatus;
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

export async function findSituation(
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
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return null;
  return new Date(created).toISOString().slice(0, 10);
}

function situationHistoryDayKey(day: string): string {
  return `${SITUATION_HISTORY_DAY_PREFIX}${day}`;
}

function normalizeHistoryDays(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const day = String(item ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || seen.has(day)) continue;
    seen.add(day);
    out.push(day);
  }
  return out.sort((a, b) => b.localeCompare(a));
}

/** Full history through bounded, keyed day buckets — never a Situation scan. */
export async function listSituations(node: NodeClient, cfg: Config): Promise<Situation[]> {
  requireIndexSchema(cfg);
  const days = normalizeHistoryDays(
    await readIndexPayload<unknown>(node, cfg, SITUATION_HISTORY_DAYS_INDEX_KEY),
  );
  const bySlug = new Map<string, Situation>();
  const active = await readIndexPayload<Situation[]>(node, cfg, ACTIVE_SITUATIONS_INDEX_KEY);
  for (const raw of active ?? []) {
    const situation = normalizeSituation(raw, undefined, { touchUpdatedAt: false });
    bySlug.set(situation.slug, situation);
  }
  for (const day of days) {
    const bucket = await readIndexPayload<Situation[]>(node, cfg, situationHistoryDayKey(day));
    if (!bucket) continue;
    for (const raw of bucket) {
      const situation = normalizeSituation(raw, undefined, { touchUpdatedAt: false });
      const existing = bySlug.get(situation.slug);
      if (!existing || situation.updated_at.localeCompare(existing.updated_at) >= 0) {
        bySlug.set(situation.slug, situation);
      }
    }
  }
  return [...bySlug.values()].sort(compareSituations);
}

/**
 * Cheap default read for preflight and `list`/`notices`: point-reads the
 * `active_situations` index row instead of scanning every Situation ever
 * filed. A declared-but-empty index is a valid fresh-node state and returns an
 * empty list; `--all` reads the keyed day-bucket history index.
 */
export async function listActiveSituationsIndexed(
  node: NodeClient,
  cfg: Config,
  at: Date = new Date(),
): Promise<Situation[]> {
  const cached = await readIndexPayload<Situation[]>(node, cfg, ACTIVE_SITUATIONS_INDEX_KEY);
  if (cached !== null) {
    const restored = cached.map((s) => normalizeSituation(s, undefined, { touchUpdatedAt: false }));
    return activeSituations(restored, at).sort(compareSituations);
  }
  requireIndexSchema(cfg);
  return [];
}

async function patchSituationsHistoryIndex(
  node: NodeClient,
  cfg: Config,
  situation: Situation,
): Promise<void> {
  if (!hasIndexSchema(cfg)) return;
  const day = situationHistoryDay(situation.created_at);
  if (!day) return;
  const days = normalizeHistoryDays(
    (await readIndexPayload<unknown>(node, cfg, SITUATION_HISTORY_DAYS_INDEX_KEY)) ?? [],
  );
  if (!days.includes(day)) {
    await writeIndexPayload(
      node,
      cfg,
      SITUATION_HISTORY_DAYS_INDEX_KEY,
      [day, ...days].sort((a, b) => b.localeCompare(a)),
    );
  }
  const bucketKey = situationHistoryDayKey(day);
  const bucket = (await readIndexPayload<Situation[]>(node, cfg, bucketKey)) ?? [];
  const withoutSlug = bucket.filter((item) => item.slug !== situation.slug);
  await writeIndexPayload(node, cfg, bucketKey, [...withoutSlug, situation].sort(compareSituations));
}

async function patchSituationsIndex(
  node: NodeClient,
  cfg: Config,
  situation: Situation,
): Promise<void> {
  const cached = (await readIndexPayload<Situation[]>(node, cfg, ACTIVE_SITUATIONS_INDEX_KEY)) ?? [];
  const withoutSlug = cached.filter((s) => s.slug !== situation.slug);
  const isNowActive = activeSituations([situation]).length > 0;
  const next = isNowActive ? [...withoutSlug, situation] : withoutSlug;
  // Opportunistically drop any other entries that have since expired by clock
  // alone (no explicit upsert needed to notice that).
  await writeIndexPayload(node, cfg, ACTIVE_SITUATIONS_INDEX_KEY, activeSituations(next));
  await patchSituationsHistoryIndex(node, cfg, situation);
}

export async function upsertSituation(
  node: NodeClient,
  cfg: Config,
  input: SituationInput,
  opts: { allowProseOnly?: boolean } = {},
): Promise<{ situation: Situation; action: "created" | "updated" }> {
  const existing = await findSituation(node, cfg, input.slug);
  const situation = normalizeSituation(input, existing ?? undefined);
  rejectConflictingActionLists(situation);
  // On the MERGED record, not just on the input: `put` patches, so a change that
  // drops blocked_actions while leaving the forbidding prose in place never
  // mentions the prose at all. The record that lands is the one to judge.
  rejectProseOnlyPolicy(situation as unknown as Record<string, unknown>, opts);
  const fields = situationToFields(situation);
  const hash = schemaHashFor("situation", cfg);
  if (existing) {
    await node.updateRecord({ schemaHash: hash, fields, keyHash: situation.slug });
    await patchSituationsIndex(node, cfg, situation);
    return { situation, action: "updated" };
  }
  await node.createRecord({ schemaHash: hash, fields, keyHash: situation.slug });
  await patchSituationsIndex(node, cfg, situation);
  return { situation, action: "created" };
}

export function activeSituations(situations: Situation[], at: Date = new Date()): Situation[] {
  return situations.filter((situation) => {
    if (situation.status !== "active" && situation.status !== "monitoring") return false;
    if (!situation.expires_at) return true;
    const expires = Date.parse(situation.expires_at);
    return !Number.isFinite(expires) || expires > at.getTime();
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
