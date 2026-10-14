import { FsituationsError, type BatchMutationOp, type NodeClient, type QueryRow } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";
import {
  fieldsFor,
  INDEX_ENTRY_MAX_BYTES,
  NOTICE_KIND_VALUES,
  NOTICE_SEVERITY_HINT_VALUES,
  type NoticeKind,
  type NoticeSeverityHint,
} from "./schemas.ts";
import { nowIso, validateSlug } from "./record.ts";
import { atomBytes } from "./atom-size.ts";
import {
  commitOps,
  dayOf,
  daysPartition,
  deleteOp,
  entryExists,
  FAR_FUTURE_SECONDS,
  hydrateBySlug,
  legacyList,
  mapLimit,
  migrationOpsForWrite,
  normalizeHistoryDays,
  noticeRange,
  padSeconds,
  putOp,
  readPartitions,
  requireAll,
  requireLayout,
  resolveLayout,
  unreadable,
  type Entry,
  type Layout,
  type PartitionSpec,
} from "./index-entry.ts";
import { hasIndexSchema, readIndexPayload, requireIndexSchema } from "./index-cache.ts";

const NOTICE_HISTORY_DAYS_KEY = "notice_history_days";
// Notices the default list would miss by day (see `isLongLived`): one small entry
// each, keyed by when they expire. IndexEntry, no TTL.
const NOTICE_LONG_KEY = "notice_long_expiry";
// A notice whose expiry is more than this after its `at` is long-lived (the default is 24 h).
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SLACK_MS = 60_000;
const NOTICE_HISTORY_DAY_PREFIX = "notice_history_day:";
// LEGACY keys, read only (a node that has not loaded the entry schemas yet).
const RECENT_NOTICES_LEGACY_KEY = "recent_notices";
const LEGACY_RECENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
// The default list covers today and yesterday (UTC): the default expiry is 24 h
// from `at`, so a notice that is still live has an `at` in one of those days.
const DEFAULT_LIST_DAYS = 2;
// A `--since` window this short (7 days) reads its days by arithmetic, not from the days list.
const SHORT_WINDOW_MS = 7 * 86_400_000;

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

function normalizeKind(value: unknown): NoticeKind {
  const s = String(value ?? "other").trim().toLowerCase();
  return (NOTICE_KIND_VALUES as readonly string[]).includes(s) ? (s as NoticeKind) : "other";
}

function normalizeSeverityHint(value: unknown): NoticeSeverityHint {
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

async function findNotice(
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

function noticeHistoryDay(atIso: string): string | null {
  return dayOf(atIso);
}

function noticeHistoryDayKey(day: string): string {
  return `${NOTICE_HISTORY_DAY_PREFIX}${day}`;
}

function dayCouldContainSince(day: string, floorMs: number): boolean {
  const dayEnd = Date.parse(`${day}T23:59:59.999Z`);
  return Number.isFinite(dayEnd) && dayEnd >= floorMs;
}

/** The time a notice was recorded: the first 20 digits of its NoticeHistory range key. */
function noticeCreatedMs(notice: { created_at: string; at: string }): number {
  const created = Date.parse(notice.created_at);
  if (Number.isFinite(created)) return created;
  const at = Date.parse(notice.at);
  return Number.isFinite(at) ? at : Date.now();
}

/** `<20-digit unix seconds of created_at>#<slug>`. `created_at` never changes, so an update rewrites one key. */
function noticeEntryRange(notice: { created_at: string; at: string; slug: string }): string {
  return noticeRange(noticeCreatedMs(notice), notice.slug);
}

/**
 * What a history entry holds of one notice: the fields a reader filters and
 * sorts on, plus the whole notice when it fits.
 *
 * A reader that needs the notice itself would otherwise hydrate it from the
 * Notice record, and one notice is 14 fields = 14 atoms the node must load (and
 * keep in its warm set) against ONE for the entry. So the entry carries the
 * notice (`notice`) whenever the whole entry stays inside the 4 KiB entry
 * budget, which every real notice does (about 0.9 KiB). A notice that does not
 * fit keeps only the filter fields and is hydrated from its record by slug; a
 * notice with an absurd scope list is also cut to fit and flagged `partial`,
 * and a partial entry is never ruled out by a scope filter.
 *
 * The record write and the entry write are one batch, so the copy cannot lag the
 * record.
 */
type NoticeEntryPayload = {
  at: string;
  created_at: string;
  expires_at: string;
  kind: NoticeKind;
  scope_systems: string[];
  scope_apps: string[];
  partial?: true;
  notice?: Notice;
};

function noticeEntryPayload(notice: Notice): NoticeEntryPayload {
  const entry: NoticeEntryPayload = {
    at: notice.at,
    created_at: notice.created_at,
    expires_at: notice.expires_at,
    kind: notice.kind,
    scope_systems: [...notice.scope_systems],
    scope_apps: [...notice.scope_apps],
  };
  while (atomBytes(JSON.stringify(entry)) > INDEX_ENTRY_MAX_BYTES) {
    const longer =
      entry.scope_systems.length >= entry.scope_apps.length ? entry.scope_systems : entry.scope_apps;
    if (longer.length === 0) break;
    longer.pop();
    entry.partial = true;
  }
  if (!entry.partial) {
    const withNotice = { ...entry, notice };
    if (atomBytes(JSON.stringify(withNotice)) <= INDEX_ENTRY_MAX_BYTES) return withNotice;
  }
  return entry;
}

/** A stored entry as a typed payload. An entry with no readable `at` THROWS: it cannot be accounted for. */
function coerceNoticeEntry(stored: unknown, id: string): NoticeEntryPayload {
  const o = stored !== null && typeof stored === "object" ? (stored as Record<string, unknown>) : null;
  if (!o || typeof o.at !== "string") throw unreadable(`notice history/${id}`, "it has no `at`");
  let notice: Notice | undefined;
  if (o.notice !== null && typeof o.notice === "object") {
    try {
      notice = normalizeNotice(o.notice as NoticeInput);
    } catch {
      // An unreadable COPY is not used; the record is read instead.
    }
  }
  return {
    at: o.at,
    created_at: String(o.created_at ?? ""),
    expires_at: String(o.expires_at ?? ""),
    kind: normalizeKind(o.kind),
    scope_systems: normalizeList(o.scope_systems),
    scope_apps: normalizeList(o.scope_apps),
    ...(o.partial === true ? { partial: true as const } : {}),
    ...(notice ? { notice } : {}),
  };
}

/**
 * One notice day. `legacyKnown` is false for a day the days marker says never
 * had a legacy bucket: it then has nothing to re-check.
 */
function noticeDaySpec(day: string, legacyKnown = true): PartitionSpec<NoticeEntryPayload> {
  const key = noticeHistoryDayKey(day);
  return {
    store: "notice",
    hash: key,
    legacyKey: legacyKnown ? key : null,
    checkDrift: false,
    // A log a TTL may empty: a listed id with no entry is an expired one, and
    // reading the blob again would bring it back. Notices never gate anything.
    fillMissing: false,
    fromLegacy(legacy) {
      return legacyList(legacy, key).map((raw) => {
        if (raw === null || typeof raw !== "object") {
          throw unreadable(`legacy Index row "${key}"`, "an item is not a notice");
        }
        const notice = normalizeNotice(raw as NoticeInput);
        return { id: notice.slug, range: noticeEntryRange(notice), payload: noticeEntryPayload(notice) };
      });
    },
    coerce: coerceNoticeEntry,
  };
}

/**
 * A notice the default list would miss by day: its expiry is more than 24 h after
 * its `at` (a custom `--expires-hours`; only revenant-watch uses 168 h), its `at`
 * lies in the future when it is written, or it never expires. The default read
 * covers the days of today and yesterday, so these also go to a small partition
 * keyed by when they expire, which the default read includes.
 */
function isLongLived(notice: Notice, refMs: number): boolean {
  const at = Date.parse(notice.at);
  if (!Number.isFinite(at)) return false;
  if (!notice.expires_at) return true;
  const expires = Date.parse(notice.expires_at);
  if (Number.isFinite(expires) && expires - at > DEFAULT_EXPIRY_MS + CLOCK_SLACK_MS) return true;
  return at > refMs + CLOCK_SLACK_MS;
}

/** `<20-digit unix seconds of expires_at>#<slug>`; a notice with no expiry sorts last. */
function longRange(notice: Notice): string {
  const expires = notice.expires_at ? Date.parse(notice.expires_at) : Number.NaN;
  return noticeRange(Number.isFinite(expires) ? expires : FAR_FUTURE_SECONDS * 1000, notice.slug);
}

/** The live long-lived notices: an ordered range read of the entries that have not expired yet. */
function longLivedSpec(nowMs: number): PartitionSpec<NoticeEntryPayload> {
  return {
    store: "long",
    hash: NOTICE_LONG_KEY,
    legacyKey: null,
    checkDrift: false,
    fillMissing: false,
    range: { start: padSeconds(nowMs / 1000), end: "99999999999999999999~" },
    fromLegacy: () => [],
    coerce: coerceNoticeEntry,
  };
}

export const NOTICE_DAYS_SPEC = daysPartition(NOTICE_HISTORY_DAYS_KEY);

type HistoryOptions = {
  all?: boolean;
  since?: string;
  system?: string;
  app?: string;
  kind?: string;
};

/**
 * Could a notice with this entry survive `filterNotices(options)`? It runs the
 * same filter on a notice rebuilt from the entry's fields, so there is one
 * filter and the two cannot drift. A scope filter does not apply to a partial
 * entry, whose scope lists were cut.
 */
function entryMayMatch(slug: string, entry: NoticeEntryPayload, options: HistoryOptions): boolean {
  const probe = {
    slug,
    kind: entry.kind,
    at: entry.at,
    created_at: entry.created_at,
    expires_at: entry.expires_at,
    scope_systems: entry.scope_systems,
    scope_apps: entry.scope_apps,
  } as unknown as Notice;
  const scoped = entry.partial ? { ...options, system: undefined, app: undefined } : options;
  return filterNotices([probe], scoped).length > 0;
}

/** The pre-entry read of the same history, for a node that has not loaded the entry schemas yet. */
async function listNoticesHistoryLegacy(
  node: NodeClient,
  cfg: Config,
  options: HistoryOptions,
): Promise<Notice[]> {
  const days = normalizeHistoryDays(
    legacyList(await readIndexPayload<unknown>(node, cfg, NOTICE_HISTORY_DAYS_KEY), NOTICE_HISTORY_DAYS_KEY),
  );
  const floorMs = options.since ? Date.now() - parseSinceDuration(options.since) : null;
  const wanted = floorMs === null ? days : days.filter((day) => dayCouldContainSince(day, floorMs));
  const buckets = await mapLimit(wanted, 4, (day) =>
    readIndexPayload<Notice[]>(node, cfg, noticeHistoryDayKey(day)),
  );
  const bySlug = new Map<string, Notice>();
  for (const bucket of buckets) {
    for (const raw of bucket ?? []) {
      const notice = normalizeNotice(raw);
      bySlug.set(notice.slug, notice);
    }
  }
  return filterNotices([...bySlug.values()], options).sort(compareNotices);
}

/** Every UTC day from `fromMs` to `toMs`, newest first. */
function daysBetween(fromMs: number, toMs: number): string[] {
  const days: string[] = [];
  for (let t = toMs; t >= fromMs - 86_400_000 + 1; t -= 86_400_000) {
    const day = dayOf(new Date(Math.max(t, fromMs)).toISOString());
    if (day && !days.includes(day)) days.push(day);
  }
  return days;
}

/** Today and yesterday (UTC): the days a notice with the default 24 h expiry can still be live in. */
function defaultListDays(nowMs: number): string[] {
  return Array.from({ length: DEFAULT_LIST_DAYS }, (_, back) => {
    const day = dayOf(new Date(nowMs - back * 86_400_000).toISOString());
    return day as string;
  });
}

/**
 * The notices of `days`, filtered by `options`. A notice carried in its entry is
 * served from the entry; one listed twice, or without its notice, is read from
 * its record (the truth). An entry that points at no record THROWS.
 */
async function listNoticeDays(
  node: NodeClient,
  cfg: Config,
  layout: Layout,
  days: readonly string[],
  legacyDays: Set<string> | null,
  options: HistoryOptions,
  withLongLived = false,
): Promise<Notice[]> {
  const specs = days.map((day) => noticeDaySpec(day, legacyDays === null || legacyDays.has(day)));
  const states = await readPartitions<NoticeEntryPayload>(node, cfg, layout, [
    ...specs,
    ...(withLongLived ? [longLivedSpec(Date.now())] : []),
  ]);
  const longState = withLongLived ? states[states.length - 1]! : null;
  const dayStates = withLongLived ? states.slice(0, -1) : states;
  // One slug can sit in two days (its `at` moved); keep it when any copy could match.
  const copies = new Map<string, number>();
  const wanted = new Map<string, Notice | undefined>();
  for (const state of dayStates) {
    for (const entry of state.entries) {
      copies.set(entry.id, (copies.get(entry.id) ?? 0) + 1);
      if (entryMayMatch(entry.id, entry.payload, options)) {
        wanted.set(entry.id, entry.fromLegacy ? undefined : entry.payload.notice);
      }
    }
  }
  // A long-lived notice that no day above already carries.
  for (const entry of longState?.entries ?? []) {
    if (!wanted.has(entry.id) && entryMayMatch(entry.id, entry.payload, options)) {
      wanted.set(entry.id, entry.payload.notice);
      copies.set(entry.id, 1);
    }
  }
  const found = new Map<string, Notice>();
  const toHydrate: string[] = [];
  for (const [slug, inline] of wanted) {
    if (inline && copies.get(slug) === 1) found.set(slug, inline);
    else toHydrate.push(slug);
  }
  const hydrated = await hydrateBySlug(node, {
    schemaHash: schemaHashFor("notice", cfg),
    fields: fieldsFor("notice"),
    slugs: toHydrate,
    toItem: rowToNotice,
  });
  requireAll(
    hydrated,
    toHydrate,
    "notice history",
    (slug) => `re-post it with \`situations notice --slug ${slug} --title "<title>"\`.`,
  );
  for (const [slug, notice] of hydrated) found.set(slug, notice);
  return filterNotices([...found.values()], options).sort(compareNotices);
}

async function listNoticesHistoryIndexed(
  node: NodeClient,
  cfg: Config,
  layout: Layout,
  options: HistoryOptions,
): Promise<Notice[]> {
  const nowMs = Date.now();
  const floorMs = options.since ? nowMs - parseSinceDuration(options.since) : null;
  // A short window names its days by arithmetic: the days list grows by one
  // entry a day for ever and is not worth a read for "the last 2 hours".
  if (floorMs !== null && nowMs - floorMs <= SHORT_WINDOW_MS) {
    return listNoticeDays(node, cfg, layout, daysBetween(floorMs, nowMs), null, options);
  }
  const [daysState] = await readPartitions(node, cfg, layout, [NOTICE_DAYS_SPEC]);
  const days = normalizeHistoryDays(daysState!.entries.map((entry) => entry.id));
  const wantedDays =
    floorMs === null ? days : days.filter((day) => dayCouldContainSince(day, floorMs));
  return listNoticeDays(node, cfg, layout, wantedDays, daysState!.info.markerIds, options);
}

/**
 * Full notice history through the keyed day partitions. Pre-index configs fail
 * closed with a re-init hint rather than scanning Notice. With no options it is
 * every notice, expired ones included; `since` reads only the days that can
 * hold a notice in the window.
 */
export async function listNotices(
  node: NodeClient,
  cfg: Config,
  options: HistoryOptions = { all: true },
): Promise<Notice[]> {
  requireIndexSchema(cfg);
  const layout = await resolveLayout(node, cfg);
  if (!layout) return listNoticesHistoryLegacy(node, cfg, options);
  return listNoticesHistoryIndexed(node, cfg, layout, options);
}

/**
 * Default read for `situations notices` and the recent-notices banner.
 *
 *   --all             every day partition
 *   --since <window>  the days that can hold a notice in the window
 *   (neither)         today and yesterday (UTC), plus the long-lived notices that
 *                     have not expired (custom expiry over 24 h, or an `at` in
 *                     the future: see `isLongLived`). The default expiry is 24 h
 *                     from `at`, so every other live notice has an `at` in those
 *                     two days.
 *
 * There is no cached "recent" row any more: such a row was one atom rewritten by
 * every writer, two writers lost a notice from it for good, and it had to be
 * capped. A day partition already carries the notice.
 *
 * A node that has not loaded the entry schemas yet (before `situations init`)
 * answers from the old blobs, read only.
 */
export async function listNoticesIndexed(
  node: NodeClient,
  cfg: Config,
  opts: HistoryOptions = {},
): Promise<Notice[]> {
  const layout = await resolveLayout(node, cfg);
  if (!layout) return listNoticesIndexedLegacy(node, cfg, opts);
  requireIndexSchema(cfg);
  if (opts.all || opts.since) return listNoticesHistoryIndexed(node, cfg, layout, opts);
  return listNoticeDays(node, cfg, layout, defaultListDays(Date.now()), null, opts, true);
}

/** The old default read, for a node without the entry schemas: the `recent_notices` blob, read only. */
async function listNoticesIndexedLegacy(
  node: NodeClient,
  cfg: Config,
  opts: HistoryOptions,
): Promise<Notice[]> {
  if (opts.all) return listNoticesHistoryLegacy(node, cfg, opts);
  if (opts.since && parseSinceDuration(opts.since) > LEGACY_RECENT_RETENTION_MS) {
    requireIndexSchema(cfg);
    return listNoticesHistoryLegacy(node, cfg, opts);
  }
  const cached = await readIndexPayload<Notice[]>(node, cfg, RECENT_NOTICES_LEGACY_KEY);
  if (cached !== null) return legacyList(cached, RECENT_NOTICES_LEGACY_KEY).map((n) => normalizeNotice(n as NoticeInput)).sort(compareNotices);
  requireIndexSchema(cfg);
  return [];
}

/**
 * One-time step of `situations init`: the long-lived notices still live in the
 * legacy `recent_notices` blob (it held every non-expired notice of 14 days) get
 * their entries. Idempotent; writes only entries of those notices.
 */
export async function seedLongLivedNotices(
  node: NodeClient,
  cfg: Config,
  layout: Layout,
): Promise<number> {
  const blob = await readIndexPayload<unknown>(node, cfg, RECENT_NOTICES_LEGACY_KEY);
  const now = new Date();
  const ops: BatchMutationOp[] = [];
  for (const raw of legacyList(blob, RECENT_NOTICES_LEGACY_KEY)) {
    if (raw === null || typeof raw !== "object") continue;
    const notice = normalizeNotice(raw as NoticeInput);
    if (isNoticeExpired(notice, now) || !isLongLived(notice, noticeCreatedMs(notice))) continue;
    ops.push(putOp(layout, "long", NOTICE_LONG_KEY, longRange(notice), noticeEntryPayload(notice)));
  }
  await commitOps(node, ops);
  return ops.length;
}

/**
 * Every write one notice upsert makes to an index, as ops for the SAME batch as
 * the Notice record write, so the record and its index entry commit together (a
 * record that lands while its entry fails is invisible to every history read).
 * It writes only the entry of THIS notice (and, once per day, that day's entry):
 * no other entry is read, rewritten or deleted. Reads first; nothing is written
 * here.
 */
async function noticeIndexOps(
  node: NodeClient,
  cfg: Config,
  layout: Layout,
  notice: Notice,
  existing: Notice | null,
): Promise<BatchMutationOp[]> {
  const day = noticeHistoryDay(notice.at);
  const dayOps = async (): Promise<BatchMutationOp[]> => {
    if (!day) return [];
    return [
      ...(await migrationOpsForWrite(node, cfg, layout, noticeDaySpec(day))),
      putOp(layout, "notice", noticeHistoryDayKey(day), noticeEntryRange(notice), noticeEntryPayload(notice)),
    ];
  };
  const daysOps = async (): Promise<BatchMutationOp[]> => {
    if (!day) return [];
    // A day already listed needs nothing; a new day is listed once.
    if (await entryExists(node, layout, "entry", NOTICE_HISTORY_DAYS_KEY, day)) return [];
    return [
      ...(await migrationOpsForWrite(node, cfg, layout, NOTICE_DAYS_SPEC)),
      putOp(layout, "entry", NOTICE_HISTORY_DAYS_KEY, day, ""),
    ];
  };
  const [inDay, inDays] = await Promise.all([dayOps(), daysOps()]);

  const ops = [...inDay, ...inDays];
  // A long-lived notice (see `isLongLived`) also gets its own small entry, keyed
  // by when it expires. Only this notice's own entries are written or deleted.
  const newLong = isLongLived(notice, noticeCreatedMs(notice)) ? longRange(notice) : null;
  const oldLong =
    existing && isLongLived(existing, noticeCreatedMs(existing)) ? longRange(existing) : null;
  if (newLong) ops.push(putOp(layout, "long", NOTICE_LONG_KEY, newLong, noticeEntryPayload(notice)));
  if (oldLong && oldLong !== newLong) ops.push(deleteOp(layout, "long", NOTICE_LONG_KEY, oldLong));
  // An `at` that moved to another day leaves this notice's old entry behind. Only
  // this notice's own entry is deleted.
  const oldDay = existing ? noticeHistoryDay(existing.at) : null;
  if (existing && oldDay && oldDay !== day) {
    ops.push(deleteOp(layout, "notice", noticeHistoryDayKey(oldDay), noticeEntryRange(existing)));
  }
  return ops;
}

export async function upsertNotice(
  node: NodeClient,
  cfg: Config,
  input: NoticeInput,
): Promise<{ notice: Notice; action: "created" | "updated" }> {
  const slug =
    input.slug ??
    defaultNoticeSlug({ kind: input.kind, title: input.title, at: input.at });
  // A write that cannot be indexed fails before it writes anything.
  const layout = hasIndexSchema(cfg) ? await requireLayout(node, cfg) : null;
  const existing = await findNotice(node, cfg, slug);
  const notice = normalizeNotice({ ...input, slug }, existing ?? undefined);
  // The Notice record and its index entry are ONE batch: both commit or neither
  // does. `update` is an upsert, so create and update are the same write.
  const ops: BatchMutationOp[] = [
    {
      mutationType: "update",
      schemaHash: schemaHashFor("notice", cfg),
      keyHash: notice.slug,
      fields: noticeToFields(notice),
    },
    ...(layout ? await noticeIndexOps(node, cfg, layout, notice, existing) : []),
  ];
  await commitOps(node, ops);
  return { notice, action: existing ? "updated" : "created" };
}

function isNoticeExpired(notice: Notice, at: Date = new Date()): boolean {
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
