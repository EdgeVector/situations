import { describe, expect, test } from "bun:test";

import { FsituationsError, type NodeClient } from "../src/client.ts";
import {
  resolveLoadedSituationHash,
  resolveOrDeclareSituationHash,
} from "../src/init-schema.ts";
import { OWNER_APP_ID, situationSchema } from "../src/schemas.ts";

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

describe("resolveOrDeclareSituationHash", () => {
  test("reuses a loaded schema without declaring", async () => {
    let declared = 0;
    const node = mockNode({
      listSchemas: async () => [
        {
          name: "already-loaded",
          descriptive_name: situationSchema.schema.descriptive_name,
          owner_app_id: OWNER_APP_ID,
          fields: [...situationSchema.schema.fields],
        },
      ],
      declareAppSchema: async () => {
        declared += 1;
        return {
          app_id: OWNER_APP_ID,
          schema: "fsituations/Situation",
          canonical: "should-not-use",
          resolution: "mint",
        };
      },
    });
    expect(await resolveOrDeclareSituationHash(node, { quiet: true })).toBe("already-loaded");
    expect(declared).toBe(0);
  });

  test("declares locally when nothing is loaded", async () => {
    const node = mockNode({
      listSchemas: async () => [],
      declareAppSchema: async (appId, schema) => {
        expect(appId).toBe(OWNER_APP_ID);
        expect(schema.name).toBe(situationSchema.schema.name);
        return {
          app_id: OWNER_APP_ID,
          schema: "fsituations/Situation",
          canonical: "minted-canonical-hash",
          resolution: "mint",
        };
      },
    });
    expect(await resolveOrDeclareSituationHash(node, { quiet: true })).toBe(
      "minted-canonical-hash",
    );
  });

  test("returns null when declare-schema is unsupported (404)", async () => {
    const node = mockNode({
      listSchemas: async () => [],
      declareAppSchema: async () => {
        throw new FsituationsError({ code: "http_404", message: "not found" });
      },
    });
    expect(await resolveOrDeclareSituationHash(node, { quiet: true })).toBeNull();
  });

  test("rethrows non-missing-route declare failures", async () => {
    const node = mockNode({
      listSchemas: async () => [],
      declareAppSchema: async () => {
        throw new FsituationsError({ code: "http_500", message: "boom" });
      },
    });
    await expect(resolveOrDeclareSituationHash(node, { quiet: true })).rejects.toMatchObject({
      code: "http_500",
    });
  });
});
