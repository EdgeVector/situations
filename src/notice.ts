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
  hydrateBySlug,
  indexEntryHash,
  mapLimit,
  migrationOpsForWrite,
  normalizeHistoryDays,
  putOp,
  readPartitions,
  requireIndexEntryHash,
  warn,
  type EntryDraft,
  type PartitionSpec,
} from "./index-entry.ts";
import { hasIndexSchema, indexRowOp, readIndexPayload, requireIndexSchema } from "./index-cache.ts";

const RECENT_NOTICES_INDEX_KEY = "recent_notices";
const NOTICE_HISTORY_DAYS_INDEX_KEY = "notice_history_days";
const NOTICE_HISTORY_DAY_PREFIX = "notice_history_day:";
// Covers the "situations notices --since 1h/2h/24h" hot path agents actually
// use; anything asking further back than this uses the keyed history index.
const RECENT_NOTICES_INDEX_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const RECENT_NOTICES_INDEX_MAX_ENTRIES = 500;
// The index row is one atom, and the node refuses an atom above 64 KiB. 500
// entries of real notices serialize to ~340 KB, far past that, so the entry cap
// alone cannot keep this row writable — see `capIndexBytes`. 32 KiB (atom
// bytes) leaves a default-configured node a 2x margin; at ~700 bytes a notice
// that is about 45 notices. History is not cut: every notice is an IndexEntry.
const RECENT_NOTICES_INDEX_MAX_BYTES = 32 * 1024;
// A row within this many bytes of its cap may have shed a notice to fit (a real
// notice is well under this), so a `--since` window older than its oldest
// notice reads history instead of trusting the row.
const RECENT_ROW_CAP_SLACK_BYTES = 4 * 1024;

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

function coerceNoticeEntry(stored: unknown): NoticeEntryPayload {
  const o = stored !== null && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  let notice: Notice | undefined;
  if (o.notice !== null && typeof o.notice === "object") {
    try {
      notice = normalizeNotice(o.notice as NoticeInput);
    } catch {
      // An unreadable copy is not used; the record is read instead.
    }
  }
  return {
    at: String(o.at ?? ""),
    created_at: String(o.created_at ?? ""),
    expires_at: String(o.expires_at ?? ""),
    kind: normalizeKind(o.kind),
    scope_systems: normalizeList(o.scope_systems),
    scope_apps: normalizeList(o.scope_apps),
    ...(o.partial === true ? { partial: true as const } : {}),
    ...(notice ? { notice } : {}),
  };
}

function noticeDaySpec(day: string): PartitionSpec<NoticeEntryPayload> {
  return {
    hash: noticeHistoryDayKey(day),
    legacyKey: noticeHistoryDayKey(day),
    fromLegacy(legacy) {
      if (!Array.isArray(legacy)) return [];
      const out: Array<EntryDraft<NoticeEntryPayload>> = [];
      for (const raw of legacy) {
        try {
          const notice = normalizeNotice(raw as NoticeInput);
          out.push({ range: notice.slug, payload: noticeEntryPayload(notice) });
        } catch {
          // A legacy row with an invalid slug cannot be an entry key.
        }
      }
      return out;
    },
    coerce: coerceNoticeEntry,
  };
}

const NOTICE_DAYS_SPEC = daysPartition(NOTICE_HISTORY_DAYS_INDEX_KEY);

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

/** The pre-`IndexEntry` read of the same history, for a config that has not pinned IndexEntry yet. */
async function listNoticesHistoryLegacy(
  node: NodeClient,
  cfg: Config,
  options: HistoryOptions,
): Promise<Notice[]> {
  const days = normalizeHistoryDays(
    await readIndexPayload<unknown>(node, cfg, NOTICE_HISTORY_DAYS_INDEX_KEY),
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

async function listNoticesHistoryIndexed(
  node: NodeClient,
  cfg: Config,
  options: HistoryOptions,
): Promise<Notice[]> {
  const entryHash = indexEntryHash(cfg);
  if (!entryHash) return listNoticesHistoryLegacy(node, cfg, options);

  const dayEntries = (await readPartitions(node, cfg, entryHash, [NOTICE_DAYS_SPEC]))[0] ?? [];
  const days = normalizeHistoryDays(dayEntries.map((entry) => entry.range));
  const floorMs = options.since ? Date.now() - parseSinceDuration(options.since) : null;
  const wantedDays =
    floorMs === null ? days : days.filter((day) => dayCouldContainSince(day, floorMs));
  const partitions = await readPartitions(node, cfg, entryHash, wantedDays.map(noticeDaySpec));

  // One slug can sit in two days (its `at` moved); keep it when any copy could match.
  // A slug listed once with its notice inline is served from the entry; a slug
  // listed twice, or without its notice, is read from its record (the truth).
  const copies = new Map<string, number>();
  const wanted = new Map<string, Notice | undefined>();
  for (const entries of partitions) {
    for (const entry of entries) {
      copies.set(entry.range, (copies.get(entry.range) ?? 0) + 1);
      if (entryMayMatch(entry.range, entry.payload, options)) {
        wanted.set(entry.range, entry.payload.notice);
      }
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
  const missing = toHydrate.filter((slug) => !hydrated.has(slug));
  if (missing.length > 0) {
    warn(
      `${missing.length} notice history entr${missing.length === 1 ? "y has" : "ies have"} no Notice record ` +
        `(first: ${missing[0]}); skipped.`,
    );
  }
  for (const [slug, notice] of hydrated) found.set(slug, notice);
  return filterNotices([...found.values()], options).sort(compareNotices);
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
  return listNoticesHistoryIndexed(node, cfg, options);
}

export function pruneNoticesForIndex(notices: Notice[], at: Date = new Date()): Notice[] {
  const floor = at.getTime() - RECENT_NOTICES_INDEX_RETENTION_MS;
  const kept = notices
    .filter((n) => {
      const t = Date.parse(n.at);
      return Number.isFinite(t) && t >= floor;
    })
    // Expired notices are never served *from this index*: `--all` and windows
    // past the retention both use keyed history, and every other read path
    // filters them out. Retention is 14 days but the default TTL is 24h,
    // so without this the row accumulates ~14x more entries than any reader can
    // ever see. Measured 2026-07-27: 142 of 146 entries were expired.
    .filter((n) => !isNoticeExpired(n, at))
    .sort(compareNotices)
    .slice(0, RECENT_NOTICES_INDEX_MAX_ENTRIES);
  return capIndexBytes(kept);
}

/**
 * Keep the serialized index row inside one atom, without ever shedding a
 * notice from history (history is `IndexEntry`; only this cache is cut).
 *
 * The whole row is a single `payload_json` value, so once it outgrows the
 * node's atom-content limit **every write is rejected**. The budget is
 * deliberately well below the 64 KiB default (32 KiB): this row has to fit a
 * default-configured node, not just the one that happens to be running.
 *
 * Measured in atom bytes (`atomBytes`: UTF-8 bytes of the JSON string literal),
 * not in UTF-16 characters. The old character count under-measured a payload
 * full of quotes and non-ASCII text, which is exactly what a notice is.
 * `notices` is newest first, so the oldest are shed from the tail.
 */
function capIndexBytes(notices: Notice[]): Notice[] {
  // JSON.stringify(list) is "[" + items joined by "," + "]", and the string
  // literal escapes each character on its own, so a prefix of the list costs
  // 4 bytes (two quotes, two brackets) + each item's escaped bytes + the commas.
  let bytes = 4;
  let keep = 0;
  for (const notice of notices) {
    const itemBytes = atomBytes(JSON.stringify(notice)) - 2;
    const next = bytes + itemBytes + (keep > 0 ? 1 : 0);
    if (next > RECENT_NOTICES_INDEX_MAX_BYTES) break;
    bytes = next;
    keep += 1;
  }
  return notices.slice(0, keep);
}

/** Could this cached row have shed notices to fit its cap? Then its window is not the whole window. */
function recentRowMayBeCapped(cached: Notice[]): boolean {
  return atomBytes(JSON.stringify(cached)) > RECENT_NOTICES_INDEX_MAX_BYTES - RECENT_ROW_CAP_SLACK_BYTES;
}

/**
 * Cheap default read for `situations notices` / the recent-notices banner:
 * point-reads the bounded `recent_notices` index row instead of scanning
 * every notice ever recorded. A declared-but-empty index is a valid fresh-node
 * state and returns an empty list. `--all` and windows past the retention read
 * the keyed day partitions instead of scanning Notice rows, and so does a
 * `--since` window that reaches past the oldest notice a capped row still holds.
 */
export async function listNoticesIndexed(
  node: NodeClient,
  cfg: Config,
  opts: HistoryOptions = {},
): Promise<Notice[]> {
  if (opts.all) return listNotices(node, cfg, opts);
  const sinceMs = opts.since ? parseSinceDuration(opts.since) : null;
  if (sinceMs !== null && sinceMs > RECENT_NOTICES_INDEX_RETENTION_MS) {
    requireIndexSchema(cfg);
    return listNoticesHistoryIndexed(node, cfg, opts);
  }
  const cached = await readIndexPayload<Notice[]>(node, cfg, RECENT_NOTICES_INDEX_KEY);
  if (cached !== null) {
    const notices = cached.map((n) => normalizeNotice(n)).sort(compareNotices);
    const oldest = notices[notices.length - 1];
    if (
      sinceMs !== null &&
      oldest !== undefined &&
      recentRowMayBeCapped(notices) &&
      Date.parse(oldest.at) > Date.now() - sinceMs
    ) {
      requireIndexSchema(cfg);
      return listNoticesHistoryIndexed(node, cfg, opts);
    }
    return notices;
  }
  requireIndexSchema(cfg);
  return [];
}

/**
 * Every write one notice upsert makes to an index, as ops for the SAME batch as
 * the Notice record write, so the record and its index entries commit together
 * (a record that lands while its index patch fails is invisible to every
 * history read). Reads first, in parallel; nothing is written here.
 */
async function noticeIndexOps(
  node: NodeClient,
  cfg: Config,
  notice: Notice,
  existing: Notice | null,
): Promise<BatchMutationOp[]> {
  if (!hasIndexSchema(cfg)) return [];
  const entryHash = await requireIndexEntryHash(node, cfg);
  const day = noticeHistoryDay(notice.at);

  const recentOp = async (): Promise<BatchMutationOp[]> => {
    const cached = (await readIndexPayload<Notice[]>(node, cfg, RECENT_NOTICES_INDEX_KEY)) ?? [];
    const kept: Notice[] = [];
    for (const raw of cached) {
      try {
        const old = normalizeNotice(raw);
        if (old.slug !== notice.slug) kept.push(old);
      } catch {
        // An invalid row in a cache is dropped, not carried forward.
      }
    }
    const op = indexRowOp(cfg, RECENT_NOTICES_INDEX_KEY, pruneNoticesForIndex([...kept, notice]));
    return op ? [op] : [];
  };
  const dayOps = async (): Promise<BatchMutationOp[]> => {
    if (!day) return [];
    return [
      ...(await migrationOpsForWrite(node, cfg, entryHash, noticeDaySpec(day))),
      putOp(entryHash, noticeHistoryDayKey(day), notice.slug, noticeEntryPayload(notice)),
    ];
  };
  const daysOps = async (): Promise<BatchMutationOp[]> => {
    if (!day) return [];
    // A day already listed needs nothing; a new day is listed once.
    if (await entryExists(node, entryHash, NOTICE_HISTORY_DAYS_INDEX_KEY, day)) return [];
    return [
      ...(await migrationOpsForWrite(node, cfg, entryHash, NOTICE_DAYS_SPEC)),
      putOp(entryHash, NOTICE_HISTORY_DAYS_INDEX_KEY, day, ""),
    ];
  };
  const [recent, inDay, inDays] = await Promise.all([recentOp(), dayOps(), daysOps()]);

  const ops = [...recent, ...inDay, ...inDays];
  // An `at` that moved to another day leaves the old day's entry behind.
  const oldDay = existing ? noticeHistoryDay(existing.at) : null;
  if (oldDay && oldDay !== day) {
    ops.push(deleteOp(entryHash, noticeHistoryDayKey(oldDay), notice.slug));
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
  const existing = await findNotice(node, cfg, slug);
  const notice = normalizeNotice({ ...input, slug }, existing ?? undefined);
  // The Notice record and every index write it needs are ONE batch: all commit
  // or none do. `update` is an upsert, so create and update are the same write.
  const ops: BatchMutationOp[] = [
    {
      mutationType: "update",
      schemaHash: schemaHashFor("notice", cfg),
      keyHash: notice.slug,
      fields: noticeToFields(notice),
    },
    ...(await noticeIndexOps(node, cfg, notice, existing)),
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
