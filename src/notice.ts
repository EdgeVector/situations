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

export type NoticeInput = Partial<Notice> & {
  slug?: string;
  title?: string;
};

export type ListNoticesOptions = {
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
    scope_systems: input.scope_systems ?? existing?.scope_systems ?? [],
    scope_apps: input.scope_apps ?? existing?.scope_apps ?? [],
    actor: (input.actor ?? existing?.actor ?? "").trim(),
    related_situation: (input.related_situation ?? existing?.related_situation ?? "").trim(),
    severity_hint: normalizeSeverityHint(input.severity_hint ?? existing?.severity_hint),
    expires_at: input.expires_at ?? existing?.expires_at ?? defaultExpiresAt(at),
    created_at: existing?.created_at ?? input.created_at ?? now,
    links_kanban: input.links_kanban ?? existing?.links_kanban ?? [],
    links_brain: input.links_brain ?? existing?.links_brain ?? [],
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

export async function listNotices(node: NodeClient, cfg: Config): Promise<Notice[]> {
  const res = await node.queryAll({
    schemaHash: schemaHashFor("notice", cfg),
    fields: fieldsFor("notice"),
  });
  return res.results.map(rowToNotice).sort(compareNotices);
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
    return { notice, action: "updated" };
  }
  await node.createRecord({ schemaHash: hash, fields, keyHash: notice.slug });
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
