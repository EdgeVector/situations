import { expect, test } from "bun:test";

import type { NodeClient, QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import type { Notice } from "../src/notice.ts";
import type { Situation } from "../src/record.ts";
import {
  buildDeliveryStageRequest,
  buildPosturePublication,
  deliverPostureStatus,
  noticeFields,
  postureFields,
  publishPostureStatus,
  SNAPSHOT_SLUG,
  type LastDbDeliveryClient,
} from "../src/publish-status.ts";

const NOW = new Date("2026-07-15T12:00:00.000Z");

function situation(overrides: Partial<Situation> = {}): Situation {
  return {
    slug: "forge-ci-containment",
    title: "Forge CI containment",
    summary: "CI re-enable blocked while investigating.",
    status: "active",
    severity: "p1",
    scope_systems: ["forge-ci"],
    scope_repos: ["EdgeVector/fold"],
    scope_routines: [],
    scope_automations: [],
    current_phase: "contain",
    phases: [],
    blocked_actions: ["enable-ci", "merge-without-gate"],
    allowed_actions: ["open-pr"],
    requires_human_clearance: [],
    preflight_message: "Do not re-enable CI without Tom.",
    links_kanban: [],
    links_brain: [],
    owner: "tom",
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    expires_at: "",
    ...overrides,
  };
}

function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    slug: "notice-upgrade-lastdb-20260715t110000z",
    kind: "upgrade",
    title: "LastDB upgraded to 0.22.9",
    summary: "Brief socket blips expected ~10m.",
    at: "2026-07-15T11:00:00.000Z",
    scope_systems: ["lastdbd", "primary-brain"],
    scope_apps: ["situations", "brain"],
    actor: "skill:lastdb-safe-upgrade",
    related_situation: "",
    severity_hint: "info",
    expires_at: "2026-07-16T11:00:00.000Z",
    created_at: "2026-07-15T11:00:00.000Z",
    links_kanban: [],
    links_brain: [],
    ...overrides,
  };
}

test("buildPosturePublication emits slim active posture + recent notices only", () => {
  const pub = buildPosturePublication({
    now: NOW,
    noticeSince: "24h",
    situations: [
      situation(),
      situation({
        slug: "old-resolved",
        status: "resolved",
        summary: "should not publish",
        blocked_actions: ["anything"],
      }),
    ],
    notices: [
      notice(),
      notice({
        slug: "stale-notice",
        at: "2026-07-10T00:00:00.000Z",
        title: "too old",
        expires_at: "2026-07-11T00:00:00.000Z",
      }),
    ],
  });

  expect(pub.snapshot.slug).toBe(SNAPSHOT_SLUG);
  expect(pub.snapshot.captured_at).toBe(NOW.toISOString());
  expect(pub.posture).toHaveLength(1);
  expect(pub.posture[0]).toEqual(
    postureFields(situation(), NOW.toISOString()),
  );
  expect(pub.posture[0]!.blocked_actions).toBe(
    JSON.stringify(["enable-ci", "merge-without-gate"]),
  );
  expect(pub.snapshot.posture_json).not.toContain("preflight_message");
  expect(pub.snapshot.posture_json).not.toContain("phases");
  expect(pub.snapshot.posture_json).not.toContain("should not publish");

  expect(pub.notices).toHaveLength(1);
  expect(pub.notices[0]).toEqual(noticeFields(notice(), NOW.toISOString()));
  expect(pub.notices[0]!.systems).toBe("lastdbd,primary-brain");
  expect(pub.snapshot.notices_json).not.toContain("too old");
});

test("publishPostureStatus declares schemas and upserts snapshot + rows", async () => {
  const node = new FakeNode();
  const result = await publishPostureStatus({
    node,
    cfg: fakeCfg(),
    now: NOW,
    situations: [situation()],
    notices: [notice()],
  });

  expect(result.schemaHashes.snapshot).toBe("hash-SituationAdminSnapshot");
  expect(result.schemaHashes.posture).toBe("hash-SituationAdminPosture");
  expect(result.schemaHashes.notice).toBe("hash-SituationAdminNotice");
  expect(result.written).toEqual({ snapshots: 1, posture: 1, notices: 1 });
  expect(node.declared).toEqual([
    "SituationAdminSnapshot",
    "SituationAdminPosture",
    "SituationAdminNotice",
  ]);
  expect(node.writes.map((w) => [w.mutationType, w.keyHash])).toEqual([
    ["create", SNAPSHOT_SLUG],
    ["create", "forge-ci-containment"],
    ["create", "notice-upgrade-lastdb-20260715t110000z"],
  ]);
  expect(result.snapshot.schema_hashes_json).toContain("SituationAdminSnapshot");
});

test("publishPostureStatus dry-run skips writes", async () => {
  const node = new FakeNode();
  const result = await publishPostureStatus({
    node,
    cfg: fakeCfg(),
    dryRun: true,
    situations: [situation()],
    notices: [notice()],
    now: NOW,
  });
  expect(result.dryRun).toBe(true);
  expect(result.written).toEqual({ snapshots: 0, posture: 0, notices: 0 });
  expect(node.writes).toHaveLength(0);
  expect(node.declared).toHaveLength(0);
});

test("buildDeliveryStageRequest targets snapshot + posture + notice legs", () => {
  const req = buildDeliveryStageRequest({
    schemaHashes: {
      snapshot: "hash-SituationAdminSnapshot",
      posture: "hash-SituationAdminPosture",
      notice: "hash-SituationAdminNotice",
    },
    recipient: {
      recipientPubkey: "recipient-ed25519",
      messagingPublicKey: "messaging-x25519",
      messagingPseudonym: "00000000-0000-0000-0000-000000000001",
      recipientDisplayName: "admin",
    },
    maxRecords: 12,
  });

  expect(req).toMatchObject({
    recipient_pubkey: "recipient-ed25519",
    recipient_display_name: "admin",
    messaging_public_key: "messaging-x25519",
    messaging_pseudonym: "00000000-0000-0000-0000-000000000001",
    mode: "snapshot",
    max_records: 12,
  });
  expect(req.legs).toHaveLength(3);
  expect(req.legs[0]).toMatchObject({
    schema_name: "hash-SituationAdminSnapshot",
    hash_keys: [SNAPSHOT_SLUG],
  });
  expect(req.legs[0]!.fields).toContain("posture_json");
  expect(req.legs[1]).toMatchObject({ schema_name: "hash-SituationAdminPosture" });
  expect(req.legs[1]!.fields).toEqual([
    "slug",
    "severity",
    "status",
    "summary",
    "blocked_actions",
    "updated_at",
  ]);
  expect(req.legs[2]).toMatchObject({ schema_name: "hash-SituationAdminNotice" });
  expect(req.legs[2]!.fields).toContain("systems");
});

test("deliverPostureStatus publishes, stages, and optionally approves", async () => {
  const node = new FakeNode();
  const delivery = new FakeDeliveryClient();
  const result = await deliverPostureStatus({
    node,
    cfg: fakeCfg(),
    deliveryClient: delivery,
    now: NOW,
    maxRecords: 7,
    approve: true,
    situations: [situation()],
    notices: [notice()],
    recipient: {
      recipientPubkey: "recipient-ed25519",
      messagingPublicKey: "messaging-x25519",
      messagingPseudonym: "00000000-0000-0000-0000-000000000001",
    },
  });

  expect(node.writes.map((w) => w.keyHash)).toContain(SNAPSHOT_SLUG);
  expect(delivery.stagedRequests).toHaveLength(1);
  expect(delivery.stagedRequests[0]!.max_records).toBe(7);
  expect(delivery.stagedRequests[0]!.legs).toHaveLength(3);
  expect(delivery.approvedIds).toEqual(["delivery-1"]);
  expect(result.staged?.deliveryId).toBe("delivery-1");
  expect(result.approved?.shared).toBe(3);
  expect(result.approved?.messageType).toBe("delivery_slice");
});

function fakeCfg(): Config {
  return {
    configVersion: 1,
    nodeUrl: "http://127.0.0.1",
    schemaServiceUrl: "",
    userHash: "user-hash",
    schemaHashes: {
      situation: "hash-Situation",
      notice: "hash-Notice",
    },
  };
}

class FakeNode implements NodeClient {
  baseUrl = "http://127.0.0.1";
  userHash = "user-hash";
  declared: string[] = [];
  writes: Array<{
    mutationType: "create" | "update";
    schemaHash: string;
    keyHash: string;
    fields: Record<string, unknown>;
  }> = [];

  async autoIdentity() {
    return { provisioned: true as const, userHash: this.userHash };
  }
  async listSchemas() {
    return [];
  }
  async declareAppSchema(_appId: string, schema: Record<string, unknown>) {
    const name = typeof schema.name === "string" ? schema.name : "unknown";
    this.declared.push(name);
    return {
      app_id: "fsituations",
      schema: `fsituations/${name}`,
      canonical: `hash-${name}`,
      resolution: "declared",
    };
  }
  async createRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void> {
    this.writes.push({ mutationType: "create", ...opts });
  }
  async updateRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void> {
    this.writes.push({ mutationType: "update", ...opts });
  }
  async queryAll(): Promise<QueryResponse> {
    return { ok: true, results: [] };
  }
}

class FakeDeliveryClient implements LastDbDeliveryClient {
  stagedRequests: Array<Parameters<LastDbDeliveryClient["stageDelivery"]>[0]> = [];
  approvedIds: string[] = [];

  async stageDelivery(request: Parameters<LastDbDeliveryClient["stageDelivery"]>[0]) {
    this.stagedRequests.push(request);
    return {
      deliveryId: "delivery-1",
      recordCount: 3,
      fields: ["slug", "summary"],
      note: "staged only",
    };
  }

  async approveDelivery(deliveryId: string) {
    this.approvedIds.push(deliveryId);
    return {
      deliveryId,
      shared: 3,
      messageType: "delivery_slice",
    };
  }
}
