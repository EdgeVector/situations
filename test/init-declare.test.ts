import { describe, expect, test } from "bun:test";

import { FsituationsError, type NodeClient } from "../src/client.ts";
import {
  resolveLoadedSituationHash,
  resolveOrDeclareSchemaHashes,
} from "../src/init-schema.ts";
import { OWNER_APP_ID, indexSchema, noticeSchema, situationSchema } from "../src/schemas.ts";

function mockNode(partial: Partial<NodeClient>): NodeClient {
  return {
    baseUrl: "http://127.0.0.1:9001",
    userHash: "test-user",
    autoIdentity: async () => ({ provisioned: true as const, userHash: "test-user" }),
    listSchemas: async () => [],
    declareAppSchema: async () => {
      throw new Error("declareAppSchema not mocked");
    },
    createRecord: async () => {},
    updateRecord: async () => {},
    queryAll: async () => ({ ok: true, results: [] }),
    ...partial,
  };
}

describe("resolveLoadedSituationHash", () => {
  test("returns null when no fsituations Situation is loaded", async () => {
    const node = mockNode({ listSchemas: async () => [] });
    expect(await resolveLoadedSituationHash(node)).toBeNull();
  });

  test("prefers a full field-set match", async () => {
    const hash = "abc123canonical";
    const node = mockNode({
      listSchemas: async () => [
        {
          name: "partial",
          descriptive_name: situationSchema.schema.descriptive_name,
          owner_app_id: OWNER_APP_ID,
          fields: ["slug", "title"],
        },
        {
          name: hash,
          descriptive_name: situationSchema.schema.descriptive_name,
          owner_app_id: OWNER_APP_ID,
          fields: [...situationSchema.schema.fields],
        },
      ],
    });
    expect(await resolveLoadedSituationHash(node)).toBe(hash);
  });
});

describe("resolveOrDeclareSchemaHashes", () => {
  test("returns both hashes when both already loaded", async () => {
    const node = mockNode({
      listSchemas: async () => [
        {
          name: "sit-hash",
          descriptive_name: situationSchema.schema.descriptive_name,
          owner_app_id: OWNER_APP_ID,
          fields: [...situationSchema.schema.fields],
        },
        {
          name: "notice-hash",
          descriptive_name: noticeSchema.schema.descriptive_name,
          owner_app_id: OWNER_APP_ID,
          fields: [...noticeSchema.schema.fields],
        },
        {
          name: "index-hash",
          descriptive_name: indexSchema.schema.descriptive_name,
          owner_app_id: OWNER_APP_ID,
          fields: [...indexSchema.schema.fields],
        },
      ],
    });
    const hashes = await resolveOrDeclareSchemaHashes(node, { quiet: true });
    expect(hashes).toEqual({ situation: "sit-hash", notice: "notice-hash", index: "index-hash" });
  });

  test("leaves hashes unset when declare-schema is unsupported (404)", async () => {
    const node = mockNode({
      listSchemas: async () => [],
      declareAppSchema: async () => {
        throw new FsituationsError({ code: "http_404", message: "not found" });
      },
    });
    expect(await resolveOrDeclareSchemaHashes(node, { quiet: true })).toEqual({});
  });

  test("rethrows non-missing-route declare failures", async () => {
    const node = mockNode({
      listSchemas: async () => [],
      declareAppSchema: async () => {
        throw new FsituationsError({ code: "http_500", message: "boom" });
      },
    });
    await expect(resolveOrDeclareSchemaHashes(node, { quiet: true })).rejects.toMatchObject({
      code: "http_500",
    });
  });
});
