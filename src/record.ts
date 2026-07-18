import { FsituationsError, type NodeClient, type QueryRow } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";
import { fieldsFor, SEVERITY_VALUES, STATUS_VALUES, type Severity, type SituationStatus } from "./schemas.ts";
import { readIndexPayload, writeIndexPayload } from "./index-cache.ts";

const ACTIVE_SITUATIONS_INDEX_KEY = "active_situations";

export type PhaseState = "pending" | "active" | "complete" | "skipped";

export type SituationPhase = {
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

export type PreflightBlock = {
  situation: Situation;
  reason: "blocked" | "requires_human_clearance";
  action: string;
  message: string;
};

export type PreflightResult = {
  ok: boolean;
  checked: PreflightRequest;
  blocks: PreflightBlock[];
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
  const phases =
    input.phases ??
    (input.phases_json !== undefined ? parsePhases(input.phases_json) : existing?.phases) ??
    [];
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
    scope_systems: input.scope_systems ?? existing?.scope_systems ?? [],
    scope_repos: input.scope_repos ?? existing?.scope_repos ?? [],
    scope_routines: input.scope_routines ?? existing?.scope_routines ?? [],
    scope_automations: input.scope_automations ?? existing?.scope_automations ?? [],
    current_phase: currentPhase,
    phases,
    blocked_actions: input.blocked_actions ?? existing?.blocked_actions ?? [],
    allowed_actions: input.allowed_actions ?? existing?.allowed_actions ?? [],
    requires_human_clearance:
      input.requires_human_clearance ?? existing?.requires_human_clearance ?? [],
    preflight_message: input.preflight_message ?? existing?.preflight_message ?? "",
    links_kanban: input.links_kanban ?? existing?.links_kanban ?? [],
    links_brain: input.links_brain ?? existing?.links_brain ?? [],
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

/** Full-history scan of every Situation row (active, resolved, archived). Expensive — reserve for `--all` and index rebuilds. */
export async function listSituations(node: NodeClient, cfg: Config): Promise<Situation[]> {
  const res = await node.queryAll({
    schemaHash: schemaHashFor("situation", cfg),
    fields: fieldsFor("situation"),
  });
  return res.results.map(rowToSituation).sort(compareSituations);
}

/**
 * Cheap default read for preflight and `list`/`notices`: point-reads the
 * `active_situations` index row instead of scanning every Situation ever
 * filed. Falls back to one full scan (and seeds the index from it) when the
 * index hasn't been declared/seeded yet — every call after that is a point
 * read again.
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
  const all = await listSituations(node, cfg);
  await rebuildSituationsIndex(node, cfg, all);
  return activeSituations(all, at);
}

export async function rebuildSituationsIndex(
  node: NodeClient,
  cfg: Config,
  situations?: Situation[],
): Promise<Situation[]> {
  const all = situations ?? (await listSituations(node, cfg));
  const active = activeSituations(all);
  await writeIndexPayload(node, cfg, ACTIVE_SITUATIONS_INDEX_KEY, active);
  return active;
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
}

export async function upsertSituation(
  node: NodeClient,
  cfg: Config,
  input: SituationInput,
): Promise<{ situation: Situation; action: "created" | "updated" }> {
  const existing = await findSituation(node, cfg, input.slug);
  const situation = normalizeSituation(input, existing ?? undefined);
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

export function preflight(
  situations: Situation[],
  request: PreflightRequest,
  at: Date = new Date(),
): PreflightResult {
  const action = normalizeAction(request.action);
  const blocks: PreflightBlock[] = [];
  for (const situation of activeSituations(situations, at)) {
    if (!scopeMatches(situation, request)) continue;
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
  return { ok: blocks.length === 0, checked: { ...request, action }, blocks };
}

export function compareSituations(a: Situation, b: Situation): number {
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
