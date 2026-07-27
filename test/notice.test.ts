import { describe, expect, test } from "bun:test";

import {
  compareNotices,
  defaultExpiresAt,
  defaultNoticeSlug,
  filterNotices,
  normalizeNotice,
  noticeToFields,
  parseSinceDuration,
  pruneNoticesForIndex,
  rowToNotice,
  type Notice,
} from "../src/notice.ts";
import type { QueryRow } from "../src/client.ts";

function baseNotice(overrides: Partial<Notice> = {}): Notice {
  return normalizeNotice({
    slug: "notice-upgrade-lastdb-20260714t191203z",
    kind: "upgrade",
    title: "LastDB upgraded to 0.22.8",
    summary: "Brief socket blips expected.",
    at: "2026-07-14T19:12:03.000Z",
    scope_systems: ["lastdbd", "primary-brain"],
    scope_apps: ["brain", "kanban"],
    actor: "skill:lastdb-safe-upgrade",
    severity_hint: "info",
    expires_at: "2026-07-15T19:12:03.000Z",
    created_at: "2026-07-14T19:12:05.000Z",
    ...overrides,
  });
}

describe("normalizeNotice", () => {
  test("defaults kind, severity_hint, and expires_at", () => {
    const notice = normalizeNotice({
      slug: "notice-test-1",
      title: "Something happened",
      at: "2026-07-14T12:00:00.000Z",
    });
    expect(notice.kind).toBe("other");
    expect(notice.severity_hint).toBe("info");
    expect(notice.expires_at).toBe(defaultExpiresAt("2026-07-14T12:00:00.000Z"));
  });

  test("auto-generates a valid slug when omitted", () => {
    const notice = normalizeNotice({
      title: "LastDB upgraded",
      kind: "upgrade",
      at: "2026-07-14T19:12:03.000Z",
    });
    expect(notice.slug).toMatch(/^notice-upgrade-lastdb-upgraded-/);
    expect(notice.slug.length).toBeLessThanOrEqual(80);
  });

  test("coerces unknown kind to other", () => {
    expect(normalizeNotice({ slug: "n1", title: "t", kind: "weird" as "other" }).kind).toBe(
      "other",
    );
  });

  test("normalizes list fields in the returned notice", () => {
    const notice = normalizeNotice({
      slug: "notice-test-lists",
      title: "List cleanup",
      scope_systems: [" lastdbd ", "lastdbd", "", "forgejo"],
      scope_apps: [" brain ", "kanban", "brain"],
      links_kanban: [" card-a ", "card-a", "card-b"],
      links_brain: [" note-a ", "", "note-a"],
    });
    expect(notice.scope_systems).toEqual(["lastdbd", "forgejo"]);
    expect(notice.scope_apps).toEqual(["brain", "kanban"]);
    expect(notice.links_kanban).toEqual(["card-a", "card-b"]);
    expect(notice.links_brain).toEqual(["note-a"]);
  });

  test("normalizes list fields from comma-separated strings", () => {
    const notice = normalizeNotice({
      slug: "notice-list-input",
      title: "List input",
      scope_systems: "lastdbd, primary-brain, lastdbd",
      scope_apps: "brain, kanban",
      links_kanban: "card-one, card-two, card-one",
      links_brain: "sop-one",
    });

    expect(notice.scope_systems).toEqual(["lastdbd", "primary-brain"]);
    expect(notice.scope_apps).toEqual(["brain", "kanban"]);
    expect(notice.links_kanban).toEqual(["card-one", "card-two"]);
    expect(notice.links_brain).toEqual(["sop-one"]);
  });
});

describe("parseSinceDuration", () => {
  test("parses s/m/h/d", () => {
    expect(parseSinceDuration("45s")).toBe(45_000);
    expect(parseSinceDuration("30m")).toBe(30 * 60_000);
    expect(parseSinceDuration("2h")).toBe(2 * 3_600_000);
    expect(parseSinceDuration("1d")).toBe(86_400_000);
  });

  test("rejects garbage", () => {
    expect(() => parseSinceDuration("soon")).toThrow(/Invalid --since/);
  });
});

describe("filterNotices", () => {
  const now = new Date("2026-07-14T20:00:00.000Z");
  const fresh = baseNotice({
    slug: "notice-fresh",
    at: "2026-07-14T19:50:00.000Z",
    expires_at: "2026-07-15T19:50:00.000Z",
  });
  const old = baseNotice({
    slug: "notice-old",
    at: "2026-07-14T10:00:00.000Z",
    expires_at: "2026-07-15T10:00:00.000Z",
  });
  const expired = baseNotice({
    slug: "notice-expired",
    at: "2026-07-13T19:00:00.000Z",
    expires_at: "2026-07-14T10:00:00.000Z",
  });
  const forge = baseNotice({
    slug: "notice-forge",
    kind: "restart",
    at: "2026-07-14T19:55:00.000Z",
    expires_at: "2026-07-15T19:55:00.000Z",
    scope_systems: ["forgejo"],
    scope_apps: [],
  });

  test("hides expired by default", () => {
    const visible = filterNotices([fresh, expired], { at: now });
    expect(visible.map((n) => n.slug)).toEqual(["notice-fresh"]);
  });

  test("--all includes expired", () => {
    const visible = filterNotices([fresh, expired], { at: now, all: true });
    expect(visible.map((n) => n.slug).sort()).toEqual(["notice-expired", "notice-fresh"]);
  });

  test("--since filters by event time", () => {
    const visible = filterNotices([fresh, old, forge], { at: now, since: "30m" });
    expect(visible.map((n) => n.slug).sort()).toEqual(["notice-forge", "notice-fresh"]);
  });

  test("--system filters scope", () => {
    const visible = filterNotices([fresh, forge], { at: now, system: "forgejo" });
    expect(visible.map((n) => n.slug)).toEqual(["notice-forge"]);
  });

  test("--kind filters", () => {
    const visible = filterNotices([fresh, forge], { at: now, kind: "restart" });
    expect(visible.map((n) => n.slug)).toEqual(["notice-forge"]);
  });
});

describe("record mapping", () => {
  test("round-trips through fields", () => {
    const notice = baseNotice();
    const fields = noticeToFields(notice);
    const row: QueryRow = { fields, key: { hash: notice.slug, range: null } };
    const restored = rowToNotice(row);
    expect(restored.slug).toBe(notice.slug);
    expect(restored.kind).toBe("upgrade");
    expect(restored.scope_systems).toEqual(["lastdbd", "primary-brain"]);
    expect(restored.scope_apps).toEqual(["brain", "kanban"]);
    expect(restored.actor).toBe("skill:lastdb-safe-upgrade");
    expect(restored.at).toBe(notice.at);
  });

  test("row mapping canonicalizes duplicate list values", () => {
    const notice = baseNotice();
    const fields = {
      ...noticeToFields(notice),
      scope_systems: [" lastdbd ", "lastdbd", "forgejo"],
      links_brain: [" note-a ", "note-a"],
    };
    const row: QueryRow = { fields, key: { hash: notice.slug, range: null } };
    const restored = rowToNotice(row);
    expect(restored.scope_systems).toEqual(["lastdbd", "forgejo"]);
    expect(restored.links_brain).toEqual(["note-a"]);
  });
});

describe("compareNotices", () => {
  test("orders newest at first", () => {
    const a = baseNotice({ slug: "a", at: "2026-07-14T10:00:00.000Z" });
    const b = baseNotice({ slug: "b", at: "2026-07-14T12:00:00.000Z" });
    expect([a, b].sort(compareNotices).map((n) => n.slug)).toEqual(["b", "a"]);
  });
});

describe("defaultNoticeSlug", () => {
  test("includes kind and stamp", () => {
    const slug = defaultNoticeSlug({
      kind: "upgrade",
      title: "LastDB 0.22.8",
      at: "2026-07-14T19:12:03.000Z",
    });
    expect(slug.startsWith("notice-upgrade-")).toBe(true);
  });
});

describe("pruneNoticesForIndex", () => {
  const at = new Date("2026-07-20T00:00:00.000Z");

  test("drops expired notices no reader can serve from the index", () => {
    // Retention is 14 days but the default TTL is 24h, so an entry can sit well
    // inside the window and still be invisible to every reader. Real shape
    // measured on the primary 2026-07-27: 142 of 146 entries expired.
    const live = baseNotice({
      slug: "notice-live",
      at: "2026-07-19T23:00:00.000Z",
      expires_at: "2026-07-20T23:00:00.000Z",
    });
    const expired = baseNotice({
      slug: "notice-expired",
      at: "2026-07-18T00:00:00.000Z",
      expires_at: "2026-07-19T00:00:00.000Z",
    });

    expect(pruneNoticesForIndex([live, expired], at).map((n) => n.slug)).toEqual(["notice-live"]);
  });

  test("still drops entries older than the retention window", () => {
    const stale = baseNotice({
      slug: "notice-stale",
      at: "2026-06-01T00:00:00.000Z",
      expires_at: "2027-01-01T00:00:00.000Z",
    });
    expect(pruneNoticesForIndex([stale], at)).toEqual([]);
  });

  test("keeps the serialized row inside one default-sized atom", () => {
    // The regression this guards: the row is a single atom, so once it outgrows
    // the node's atom-content limit EVERY index write is rejected as a bare 500
    // while notice records keep landing — the index silently goes stale.
    const many = Array.from({ length: 500 }, (_, i) =>
      baseNotice({
        slug: `notice-bulk-${String(i).padStart(3, "0")}`,
        at: `2026-07-19T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
        expires_at: "2026-07-21T00:00:00.000Z",
        summary: "x".repeat(600),
      }),
    );

    const kept = pruneNoticesForIndex(many, at);

    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(48 * 1024);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(500);
  });

  test("sheds oldest first when capping for size", () => {
    const notices = Array.from({ length: 200 }, (_, i) =>
      baseNotice({
        slug: `notice-${String(i).padStart(3, "0")}`,
        at: `2026-07-${String(6 + Math.floor(i / 24)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
        expires_at: "2026-07-21T00:00:00.000Z",
        summary: "y".repeat(600),
      }),
    );

    const kept = pruneNoticesForIndex(notices, at);
    const newest = [...notices].sort(compareNotices)[0];

    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0]?.slug).toBe(newest?.slug);
  });
});
