/// <reference types="bun" />
// `src/lib/*` runs under plain `bun test` (no DOM, no Vite): packName.ts imports nothing, which
// is what keeps that true. The expectation tables here are byte-identical to the ones in
// server/publish.test.ts — that is what pins the deliberate app/server duplication of these two
// functions together.
import { describe, expect, test } from "bun:test";
import { nameClaimReleaseBlocker, packNameScope, packNameSegments } from "./packName";

describe("packNameScope", () => {
  test("a scoped name reports its scope segment", () => {
    expect(packNameScope("wespd/cacc-twin-team")).toBe("wespd");
    expect(packNameScope("acme/tools")).toBe("acme");
  });

  // The bare-name branch drives the withdraw UI: an unscoped claim can never be released (the
  // server refuses it outright), so collapsing this to "always return the first segment" would
  // offer staff an unclaim that always 422s.
  test("a bare name has no scope", () => {
    expect(packNameScope("gascity")).toBeUndefined();
    expect(packNameScope("cacc-twin-team")).toBeUndefined();
  });

  // A trailing slash leaves an empty second segment, so `rest` is "" — falsy, therefore bare.
  // Not reachable through the publish grammar; asserted so the truthiness check is deliberate.
  test("a trailing slash does not manufacture a scope", () => {
    expect(packNameScope("gascity/")).toBeUndefined();
  });
});

describe("packNameSegments", () => {
  test("a bare name is one segment", () => {
    expect(packNameSegments("gascity")).toEqual(["gascity"]);
  });

  // Collapsing this to `[name]` is what re-emits the `%2F` URL form.
  test("a scoped name is two segments", () => {
    expect(packNameSegments("wespd/cacc-twin-team")).toEqual(["wespd", "cacc-twin-team"]);
  });
});

describe("nameClaimReleaseBlocker", () => {
  const approved = (id: string, requestedName: string) => ({ id, requestedName, status: "approved" });

  // The reachable-by-any-test problem this function exists to solve: nothing can mint a bare name
  // claim, so no harness can produce an approved bare-named row, so this branch has no e2e path.
  test("an unscoped name can never have its claim released", () => {
    expect(nameClaimReleaseBlocker(approved("a", "cacc-twin-team"), [approved("a", "cacc-twin-team")])).toBe(
      "unscoped_name_reserved",
    );
  });

  test("a scoped name with no sibling release may be released", () => {
    const row = approved("a", "wespd/tools");
    expect(nameClaimReleaseBlocker(row, [row])).toBeUndefined();
    // Rows for OTHER names, and non-approved rows for this name, are not survivors.
    expect(
      nameClaimReleaseBlocker(row, [
        row,
        approved("b", "wespd/other"),
        { id: "c", requestedName: "wespd/tools", status: "withdrawn" },
        { id: "d", requestedName: "wespd/tools", status: "pending_review" },
      ]),
    ).toBeUndefined();
  });

  test("a scoped name whose sibling release is still served may not", () => {
    const row = approved("a", "wespd/tools");
    expect(nameClaimReleaseBlocker(row, [row, approved("b", "wespd/tools")])).toBe(
      "sibling_release_served",
    );
  });
});
