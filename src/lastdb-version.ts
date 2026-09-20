// The LastDB node request-grammar version situations needs, from
// `lastdb.minApiVersion` in package.json (see the app-sdk README, "Version
// handshake"). `0` = no requirement: the node is never asked. Raise it in the
// same change that makes situations send a key an older node would refuse;
// enforcement then fails on ONE line that names the fix instead of a bare 400
// on the first write (the 2026-09-03 brain `durability` incident). Malformed
// → 0 so a packaging mistake never bricks every command.
import pkg from "../package.json" with { type: "json" };

export const MIN_LASTDB_API_VERSION: number = parseMinApiVersion(
  (pkg as { lastdb?: { minApiVersion?: unknown } }).lastdb?.minApiVersion,
);

function parseMinApiVersion(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

// Who is asking, for the NodeTooOldError message (`situations 0.1.0 needs …`).
export const SITUATIONS_APP_LABEL = `situations ${pkg.version}`;
