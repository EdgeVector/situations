import { FsituationsError, type NodeClient, type QueryRow } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";
import {
  fieldsFor,
  NOTICE_KIND_VALUES,
  NOTICE_SEVERITY_HINT_VALUES,
  type NoticeKind,
  type NoticeSeverityHint,
} from "./schemas.ts";
import { nowIso, validateSlug } from "./record.ts";
import { hasIndexSchema, readIndexPayload, writeIndexPayload } from "./index-cache.ts";

const RECENT_NOTICES_INDEX_KEY = "recent_notices";
const NOTICE_HISTORY_DAYS_INDEX_KEY = "notice_history_days";
const NOTICE_HISTORY_DAY_PREFIX = "notice_history_day:";
// Covers the "situations notices --since 1h/2h/24h" hot path agents actually
// use; anything asking further back than this uses the keyed history index.
const RECENT_NOTICES_INDEX_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const RECENT_NOTICES_INDEX_MAX_ENTRIES = 500;
// The index row is one atom. 500 entries of real notices serialize to ~340 KB,
// far past the 64 KiB default atom-content limit, so the entry cap alone cannot
// keep this row writable — see `capIndexBytes`.
const RECENT_NOTICES_INDEX_MAX_BYTES = 48 * 1024;

export type Notice = {
  slug: string;
  kind: NoticeKind;
  title: string;
  summary: string;
  at: string;
  scope_systems: string[];
  scope_apps: string[];
  actor: string;
  related_situation: string;
  severity_hint: NoticeSeverityHint;
  expires_at: string;
  created_at: string;
  links_kanban: string[];
  links_brain: string[];
};

type NoticeListField = "scope_systems" | "scope_apps" | "links_kanban" | "links_brain";

export type NoticeInput = Omit<Partial<Notice>, NoticeListField> & {
  slug?: string;
  title?: string;
  scope_systems?: unknown;
  scope_apps?: unknown;
  links_kanban?: unknown;
  links_brain?: unknown;
};

type ListNoticesOptions = {
  /** Include expired notices. */
  all?: boolean;
  /** Only notices with `at` >= now - duration (e.g. "30m", "2h", "1d"). */
  since?: string;
  /** Filter: notice.scope_systems matches (case-insensitive; * matches all). */
  system?: string;
  /** Filter: notice.scope_apps matches. */
  app?: string;
  /** Filter by kind. */
  kind?: string;
  at?: Date;
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

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

export function normalizeKind(value: unknown): NoticeKind {
  const s = String(value ?? "other").trim().toLowerCase();
  return (NOTICE_KIND_VALUES as readonly string[]).includes(s) ? (s as NoticeKind) : "other";
}

export function normalizeSeverityHint(value: unknown): NoticeSeverityHint {
  const s = String(value ?? "info").trim().toLowerCase();
  return (NOTICE_SEVERITY_HINT_VALUES as readonly string[]).includes(s)
    ? (s as NoticeSeverityHint)
    : "info";
}

/** Parse durations like 30m, 2h, 1d, 45s into milliseconds. */
export function parseSinceDuration(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(raw.trim());
  if (!m) {
    throw new FsituationsError({
      code: "invalid_since",
      message: `Invalid --since value "${raw}".`,
      hint: 'Use a duration like "30m", "2h", "1d", or "45s".',
    });
  }
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mult =
    unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.floor(n * mult);
}

function slugifyFragment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Build a default slug from kind + clock when the caller omits one. */
export function defaultNoticeSlug(input: {
  kind?: string;
  title?: string;
  at?: string;
}): string {
  const at = input.at ? new Date(input.at) : new Date();
  const stamp = Number.isFinite(at.getTime())
    ? at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase()
    : nowIso().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
  const kind = slugifyFragment(input.kind ?? "other") || "other";
  const titleBit = slugifyFragment(input.title ?? "");
  const base = titleBit ? `notice-${kind}-${titleBit}-${stamp}` : `notice-${kind}-${stamp}`;
  return base.slice(0, 80);
}

export function defaultExpiresAt(atIso: string, ttlMs: number = DEFAULT_TTL_MS): string {
  const at = Date.parse(atIso);
  const base = Number.isFinite(at) ? at : Date.now();
  return new Date(base + ttlMs).toISOString();
}

export function normalizeNotice(input: NoticeInput, existing?: Notice): Notice {
  const now = nowIso();
  const at = input.at ?? existing?.at ?? now;
  const slug = input.slug ?? existing?.slug ?? defaultNoticeSlug({ kind: input.kind, title: input.title, at });
  validateSlug(slug);

  const title = input.title ?? existing?.title ?? slug;
  if (!title.trim()) {
    throw new FsituationsError({
      code: "missing_title",
      message: "Notice title is required.",
      hint: "Pass --title or a title field in the JSON body.",
    });
  }

  return {
    slug,
    kind: normalizeKind(input.kind ?? existing?.kind),
    title: title.trim(),
    summary: (input.summary ?? existing?.summary ?? "").trim(),
    at,
    scope_systems: normalizeList(input.scope_systems ?? existing?.scope_systems),
    scope_apps: normalizeList(input.scope_apps ?? existing?.scope_apps),
    actor: (input.actor ?? existing?.actor ?? "").trim(),
    related_situation: (input.related_situation ?? existing?.related_situation ?? "").trim(),
    severity_hint: normalizeSeverityHint(input.severity_hint ?? existing?.severity_hint),
    expires_at: input.expires_at ?? existing?.expires_at ?? defaultExpiresAt(at),
    created_at: existing?.created_at ?? input.created_at ?? now,
    links_kanban: normalizeList(input.links_kanban ?? existing?.links_kanban),
    links_brain: normalizeList(input.links_brain ?? existing?.links_brain),
  };
}

export function noticeToFields(notice: Notice): Record<string, unknown> {
  return {
    slug: notice.slug,
    kind: notice.kind,
    title: notice.title,
    summary: notice.summary,
    at: notice.at,
    scope_systems: normalizeList(notice.scope_systems),
    scope_apps: normalizeList(notice.scope_apps),
    actor: notice.actor,
    related_situation: notice.related_situation,
    severity_hint: notice.severity_hint,
    expires_at: notice.expires_at,
    created_at: notice.created_at,
    links_kanban: normalizeList(notice.links_kanban),
    links_brain: normalizeList(notice.links_brain),
  };
}

export function rowToNotice(row: QueryRow): Notice {
  const f = row.fields;
  return normalizeNotice({
    slug: String(f.slug ?? ""),
    kind: String(f.kind ?? "other") as NoticeKind,
    title: String(f.title ?? ""),
    summary: String(f.summary ?? ""),
    at: String(f.at ?? ""),
    scope_systems: normalizeList(f.scope_systems),
    scope_apps: normalizeList(f.scope_apps),
    actor: String(f.actor ?? ""),
    related_situation: String(f.related_situation ?? ""),
    severity_hint: String(f.severity_hint ?? "info") as NoticeSeverityHint,
    expires_at: String(f.expires_at ?? ""),
    created_at: String(f.created_at ?? ""),
    links_kanban: normalizeList(f.links_kanban),
    links_brain: normalizeList(f.links_brain),
  });
}

export function hasNoticeSchema(cfg: { schemaHashes: Record<string, string> }): boolean {
  return Boolean(cfg.schemaHashes.notice && cfg.schemaHashes.notice.length > 0);
}

export async function findNotice(
  node: NodeClient,
  cfg: Config,
  slug: string,
): Promise<Notice | null> {
  validateSlug(slug);
  const res = await node.queryAll({
    schemaHash: schemaHashFor("notice", cfg),
    fields: fieldsFor("notice"),
    filter: { HashKey: slug },
  });
  const row = res.results[0];
  return row ? rowToNotice(row) : null;
}

export async function requireNotice(node: NodeClient, cfg: Config, slug: string): Promise<Notice> {
  const notice = await findNotice(node, cfg, slug);
  if (!notice) {
    throw new FsituationsError({
      code: "not_found",
      message: `Notice "${slug}" not found.`,
    });
  }
  return notice;
}

async function scanNotices(node: NodeClient, cfg: Config): Promise<Notice[]> {
  const res = await node.queryAll({
    schemaHash: schemaHashFor("notice", cfg),
    fields: fieldsFor("notice"),
  });
  return res.results.map(rowToNotice).sort(compareNotices);
}

function noticeHistoryDay(atIso: string): string | null {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toISOString().slice(0, 10);
}

function noticeHistoryDayKey(day: string): string {
  return `${NOTICE_HISTORY_DAY_PREFIX}${day}`;
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

function dayCouldContainSince(day: string, floorMs: number): boolean {
  const dayEnd = Date.parse(`${day}T23:59:59.999Z`);
  return Number.isFinite(dayEnd) && dayEnd >= floorMs;
}

async function listNoticesHistoryIndexed(
  node: NodeClient,
  cfg: Config,
  opts: { since?: string } = {},
): Promise<Notice[]> {
  const days = normalizeHistoryDays(
    await readIndexPayload<unknown>(node, cfg, NOTICE_HISTORY_DAYS_INDEX_KEY),
  );
  const floorMs = opts.since ? Date.now() - parseSinceDuration(opts.since) : null;
  const wantedDays =
    floorMs === null ? days : days.filter((day) => dayCouldContainSince(day, floorMs));
  const notices: Notice[] = [];
  for (const day of wantedDays) {
    const bucket = await readIndexPayload<Notice[]>(node, cfg, noticeHistoryDayKey(day));
    if (!bucket) continue;
    notices.push(...bucket.map((n) => normalizeNotice(n)));
  }
  return notices.sort(compareNotices);
}

/**
 * Full notice history. Current configs read the keyed day-bucket history index;
 * pre-index configs keep the legacy scan fallback so old local dev nodes still
 * work until they are re-initialized.
 */
export async function listNotices(node: NodeClient, cfg: Config): Promise<Notice[]> {
  if (hasIndexSchema(cfg)) return listNoticesHistoryIndexed(node, cfg);
  return scanNotices(node, cfg);
}

export function pruneNoticesForIndex(notices: Notice[], at: Date = new Date()): Notice[] {
  const floor = at.getTime() - RECENT_NOTICES_INDEX_RETENTION_MS;
  const kept = notices
    .filter((n) => {
      const t = Date.parse(n.at);
      return Number.isFinite(t) && t >= floor;
    })
    // Expired notices are never served *from this index*: `--all` and windows
    // past the retention both fall back to the full scan, and every other read
    // path filters them out. Retention is 14 days but the default TTL is 24h,
    // so without this the row accumulates ~14x more entries than any reader can
    // ever see. Measured 2026-07-27: 142 of 146 entries were expired.
    .filter((n) => !isNoticeExpired(n, at))
    .sort(compareNotices)
    .slice(0, RECENT_NOTICES_INDEX_MAX_ENTRIES);
  return capIndexBytes(kept);
}

/**
 * Keep the serialized index row inside one atom.
 *
 * The whole index is a single `payload_json` value, so once it outgrows the
 * node's atom-content limit **every write is rejected** — and because the
 * record write and the index patch are separate mutations, notices keep landing
 * while the index silently stops updating. That failure is invisible: reads of
 * the existing row still work, so the only symptom is `situations notices`
 * quietly going stale.
 *
 * The budget is deliberately below the 64 KiB default rather than the node's
 * configured limit: this row has to fit a default-configured node, not just the
 * one that happens to be running.
 */
function capIndexBytes(notices: Notice[]): Notice[] {
  let out = notices;
  // Sorted newest-first, so dropping from the tail sheds the oldest entries.
  while (out.length > 1 && JSON.stringify(out).length > RECENT_NOTICES_INDEX_MAX_BYTES) {
    out = out.slice(0, out.length - 1);
  }
  return out;
}

/**
 * Cheap default read for `situations notices` / the recent-notices banner:
 * point-reads the bounded `recent_notices` index row instead of scanning
 * every notice ever recorded. A declared-but-empty index is a valid fresh-node
 * state and returns an empty list; `--all` and windows past the retention read
 * the keyed day-bucket history index instead of scanning Notice rows.
 */
export async function listNoticesIndexed(
  node: NodeClient,
  cfg: Config,
  opts: { all?: boolean; since?: string } = {},
): Promise<Notice[]> {
  if (opts.all) return listNotices(node, cfg);
  if (opts.since && parseSinceDuration(opts.since) > RECENT_NOTICES_INDEX_RETENTION_MS) {
    return hasIndexSchema(cfg) ? listNoticesHistoryIndexed(node, cfg, opts) : scanNotices(node, cfg);
  }
  const cached = await readIndexPayload<Notice[]>(node, cfg, RECENT_NOTICES_INDEX_KEY);
  if (cached !== null) {
    return cached.map((n) => normalizeNotice(n)).sort(compareNotices);
  }
  if (hasIndexSchema(cfg)) return [];
  const all = await scanNotices(node, cfg);
  await rebuildNoticesIndex(node, cfg, all);
  return all;
}

export async function rebuildNoticesIndex(
  node: NodeClient,
  cfg: Config,
  notices?: Notice[],
): Promise<Notice[]> {
  const all = notices ?? (await listNotices(node, cfg));
  const bounded = pruneNoticesForIndex(all);
  await writeIndexPayload(node, cfg, RECENT_NOTICES_INDEX_KEY, bounded);
  return bounded;
}

async function patchNoticesIndex(node: NodeClient, cfg: Config, notice: Notice): Promise<void> {
  const cached = (await readIndexPayload<Notice[]>(node, cfg, RECENT_NOTICES_INDEX_KEY)) ?? [];
  const withoutSlug = cached.filter((n) => n.slug !== notice.slug);
  await writeIndexPayload(node, cfg, RECENT_NOTICES_INDEX_KEY, pruneNoticesForIndex([...withoutSlug, notice]));

  const day = noticeHistoryDay(notice.at);
  if (!day) return;
  const days = normalizeHistoryDays(
    (await readIndexPayload<unknown>(node, cfg, NOTICE_HISTORY_DAYS_INDEX_KEY)) ?? [],
  );
  if (!days.includes(day)) {
    await writeIndexPayload(node, cfg, NOTICE_HISTORY_DAYS_INDEX_KEY, [day, ...days].sort((a, b) => b.localeCompare(a)));
  }
  const bucketKey = noticeHistoryDayKey(day);
  const bucket = (await readIndexPayload<Notice[]>(node, cfg, bucketKey)) ?? [];
  const withoutNotice = bucket.filter((n) => n.slug !== notice.slug);
  await writeIndexPayload(node, cfg, bucketKey, [...withoutNotice, notice].sort(compareNotices));
}

export async function upsertNotice(
  node: NodeClient,
  cfg: Config,
  input: NoticeInput,
): Promise<{ notice: Notice; action: "created" | "updated" }> {
  const slug =
    input.slug ??
    defaultNoticeSlug({ kind: input.kind, title: input.title, at: input.at });
  const existing = await findNotice(node, cfg, slug);
  const notice = normalizeNotice({ ...input, slug }, existing ?? undefined);
  const fields = noticeToFields(notice);
  const hash = schemaHashFor("notice", cfg);
  if (existing) {
    await node.updateRecord({ schemaHash: hash, fields, keyHash: notice.slug });
    await patchNoticesIndex(node, cfg, notice);
    return { notice, action: "updated" };
  }
  await node.createRecord({ schemaHash: hash, fields, keyHash: notice.slug });
  await patchNoticesIndex(node, cfg, notice);
  return { notice, action: "created" };
}

export function isNoticeExpired(notice: Notice, at: Date = new Date()): boolean {
  if (!notice.expires_at) return false;
  const expires = Date.parse(notice.expires_at);
  return Number.isFinite(expires) && expires <= at.getTime();
}

export function filterNotices(notices: Notice[], options: ListNoticesOptions = {}): Notice[] {
  const at = options.at ?? new Date();
  const sinceMs = options.since ? parseSinceDuration(options.since) : null;
  const sinceFloor = sinceMs !== null ? at.getTime() - sinceMs : null;
  const system = options.system?.trim().toLowerCase();
  const app = options.app?.trim().toLowerCase();
  const kind = options.kind?.trim().toLowerCase();

  return notices.filter((notice) => {
    if (!options.all && isNoticeExpired(notice, at)) return false;
    if (sinceFloor !== null) {
      const eventAt = Date.parse(notice.at);
      if (!Number.isFinite(eventAt) || eventAt < sinceFloor) return false;
    }
    if (kind && notice.kind !== kind) return false;
    if (system && !scopeMatches(notice.scope_systems, system)) return false;
    if (app && !scopeMatches(notice.scope_apps, app)) return false;
    return true;
  });
}

export function compareNotices(a: Notice, b: Notice): number {
  // Newest event first.
  const byAt = b.at.localeCompare(a.at);
  if (byAt !== 0) return byAt;
  return b.created_at.localeCompare(a.created_at);
}

function scopeMatches(values: string[], needle: string): boolean {
  if (values.length === 0) return false;
  return values.some((value) => value === "*" || value.toLowerCase() === needle);
}

export function renderNoticesList(notices: Notice[]): string {
  if (notices.length === 0) return "No recent notices.";
  return notices
    .map((n) => {
      const systems = n.scope_systems.length ? ` systems=${n.scope_systems.join(",")}` : "";
      const apps = n.scope_apps.length ? ` apps=${n.scope_apps.join(",")}` : "";
      const actor = n.actor ? ` actor=${n.actor}` : "";
      return `${n.severity_hint.toUpperCase().padEnd(4)} ${n.kind.padEnd(8)} ${n.at}  ${n.slug}${systems}${apps}${actor}\n  ${n.title}${n.summary ? `\n  ${n.summary}` : ""}`;
    })
    .join("\n");
}

export function renderNotice(n: Notice): string {
  const scopes = [
    n.scope_systems.length ? `systems=${n.scope_systems.join(",")}` : "",
    n.scope_apps.length ? `apps=${n.scope_apps.join(",")}` : "",
  ].filter(Boolean);
  return [
    n.title,
    `${n.severity_hint.toUpperCase()} ${n.kind} ${n.slug}`,
    n.summary,
    `At: ${n.at}`,
    n.expires_at ? `Expires: ${n.expires_at}` : "",
    scopes.length ? `Scope: ${scopes.join(" ")}` : "Scope: (none)",
    n.actor ? `Actor: ${n.actor}` : "",
    n.related_situation ? `Related situation: ${n.related_situation}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
