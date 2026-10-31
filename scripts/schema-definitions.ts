/** Export exact registration payloads, or confirm them against the real schema service. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { APP_SCHEMAS } from "../src/schema-layout.ts";
import { canonicalSchema } from "../src/canonical-vocabulary.ts";
import type { SchemaDefinition } from "../src/schemas.ts";

const { values } = parseArgs({
  options: {
    export: { type: "string" },
    baseline: { type: "string" },
    "lastdb-source": { type: "string" },
    output: { type: "string" },
  },
  allowPositionals: false,
});
const schemas = APP_SCHEMAS.map(({ definition }) =>
  canonicalSchema(definition),
);
if (values.export) {
  if (values.baseline || values["lastdb-source"] || values.output)
    throw Error("Choose export or CI verification.");
  // Registration owns canonical definitions. Value ownership belongs to the node declaration.
  writeFileSync(
    values.export,
    JSON.stringify(
      schemas.map((schema) => ({
        schema: { ...schema, independent_fields: false },
        mutation_mappers: {},
      })),
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
} else {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    !values.baseline ||
    !values["lastdb-source"] ||
    !values.output
  ) {
    throw Error(
      "CI verification requires exact baseline source, LastDB source, and an output path.",
    );
  }
  // The daemons read the same registry: ENVIRONMENT selects the service from the
  // exact LastDB source's folddb_profile/environments.json.
  const environment = process.env.ENVIRONMENT ?? "";
  const registry = JSON.parse(
    readFileSync(
      join(resolve(values["lastdb-source"]), "folddb_profile", "environments.json"),
      "utf8",
    ),
  );
  const service = registry.environments?.[environment]?.schema_service;
  if (typeof service !== "string" || !service.startsWith("https://"))
    throw Error(
      "Set ENVIRONMENT to the Schema Service environment that the comparison daemons use.",
    );
  const root = resolve(values.baseline);
  const before = await import(pathToFileURL(root + "/src/schemas.ts").href);
  const vocabulary = await import(
    pathToFileURL(root + "/src/canonical-vocabulary.ts").href
  );
  const control = [
    before.situationSchema,
    before.noticeSchema,
    before.indexSchema,
    before.indexEntrySchema,
    before.noticeHistorySchema,
  ].map((item) => vocabulary.canonicalSchema(item.schema));
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, stable(item)]),
          )
        : value;
  const same = (left: unknown, right: unknown) =>
    JSON.stringify(stable(left)) === JSON.stringify(stable(right));
  const results = await Promise.all(
    [
      ...control.map((schema: SchemaDefinition) => ({
        label: "baseline",
        schema,
      })),
      ...schemas.map((schema) => ({ label: "candidate", schema })),
    ].map(async ({ label, schema }) => {
      // This public replay carries no publisher authority. An unregistered definition must fail.
      const response = await fetch(
        `${service}/v1/schemas`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schema: { ...schema, independent_fields: false },
            mutation_mappers: {},
          }),
          signal: AbortSignal.timeout(60000),
        },
      );
      const raw = (await response.json()) as Record<string, any>;
      const data = raw.data ?? raw;
      const stored = data.schema ?? data;
      const exact =
        response.status === 200 &&
        stored.owner_app_id === schema.owner_app_id &&
        stored.descriptive_name === schema.descriptive_name &&
        /^[a-f0-9]{64}$/.test(stored.identity_hash ?? "") &&
        stored.schema_type === schema.schema_type &&
        same(
          [stored.key?.hash_field, stored.key?.range_field ?? null],
          [schema.key.hash_field, schema.key.range_field ?? null],
        ) &&
        same([...(stored.fields ?? [])].sort(), [...schema.fields].sort()) &&
        same(stored.field_descriptions, schema.field_descriptions) &&
        schema.fields.every((field) =>
          same(stored.field_types?.[field], schema.field_types[field]),
        );
      return {
        label,
        environment,
        schema: `${schema.owner_app_id}/${schema.descriptive_name}`,
        status: response.status,
        exact_definition: exact,
      };
    }),
  );
  writeFileSync(
    values.output,
    JSON.stringify(
      {
        definitions: results,
        complete:
          results.length === 13 &&
          results.every((item) => item.exact_definition),
      },
      null,
      2,
    ) + "\n",
  );
  for (const result of results) console.log(JSON.stringify(result));
  if (results.length !== 13 || results.some((item) => !item.exact_definition)) {
    throw Error(
      `Publish the exact Situations definitions in the ${environment} Schema Service before the comparison.`,
    );
  }
}
