/// <reference types="bun" />
// Runs under plain `bun test`: `import.meta.env.BASE_URL` is undefined outside Vite, so
// base.ts's MOUNT_BASE is "" and stripBase/withBase are identities here. That is the standalone
// build's configuration, which is the one the tests below are written against.
import { describe, expect, test } from "bun:test";
import { packPath, parseRoute } from "./urlState";

describe("packPath", () => {
  // Byte-for-byte what it emitted before the two-segment change. Every pack in the committed
  // catalog is bare-named, as is the one live bare community pack and every e2e URL literal, so
  // this is the assertion that says "nothing currently served moved".
  test("a bare name's URL is unchanged", () => {
    expect(packPath("gascity")).toBe("/packs/gascity");
    expect(packPath("cacc-twin-team")).toBe("/packs/cacc-twin-team");
  });

  // Reverting to encodeURIComponent(name) puts the %2F back.
  test("a scoped name becomes two real path segments", () => {
    expect(packPath("wespd/cacc-twin-team")).toBe("/packs/wespd/cacc-twin-team");
    expect(packPath("acme/tools")).toBe("/packs/acme/tools");
  });

  // Segments are still individually escaped — the split happens before the encode, so only the
  // separator survives as a literal slash.
  test("segments are escaped individually", () => {
    expect(packPath("acme/a b")).toBe("/packs/acme/a%20b");
  });
});

describe("parseRoute", () => {
  test("a bare pack path resolves", () => {
    expect(parseRoute("/packs/gascity")).toEqual({ kind: "pack", name: "gascity" });
    expect(parseRoute("/packs/gascity/")).toEqual({ kind: "pack", name: "gascity" });
  });

  // The regression this route change exists to fix: with a single-segment matcher this returned
  // { kind: "home" } — a silently wrong page, not a 404.
  test("a two-segment pack path resolves to the scoped name", () => {
    expect(parseRoute("/packs/wespd/cacc-twin-team")).toEqual({
      kind: "pack",
      name: "wespd/cacc-twin-team",
    });
    expect(parseRoute("/packs/wespd/cacc-twin-team/")).toEqual({
      kind: "pack",
      name: "wespd/cacc-twin-team",
    });
  });

  // Back-compat: links already shared in the encoded form keep working. Dropping the
  // decodeURIComponent 404s every one of them.
  test("the legacy percent-encoded form still resolves to the same name", () => {
    expect(parseRoute("/packs/wespd%2Fcacc-twin-team")).toEqual({
      kind: "pack",
      name: "wespd/cacc-twin-team",
    });
    expect(parseRoute("/packs/acme%2Ftools")).toEqual({ kind: "pack", name: "acme/tools" });
  });

  // The matcher stays anchored at one-or-two segments. Loosening it to `(.+)` would swallow
  // deeper paths into a bogus pack name instead of leaving them to fall through.
  test("deeper and empty pack paths fall through to home", () => {
    expect(parseRoute("/packs/a/b/c")).toEqual({ kind: "home" });
    expect(parseRoute("/packs/")).toEqual({ kind: "home" });
    expect(parseRoute("/packs")).toEqual({ kind: "home" });
  });

  test("the other routes are untouched", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/account")).toEqual({ kind: "account" });
    expect(parseRoute("/admin/publish-requests")).toEqual({ kind: "adminPublish" });
    expect(parseRoute("/publish")).toEqual({ kind: "publish" });
  });
});

// The round trip is the property that matters: whatever packPath emits, parseRoute has to read
// back as the same name, for both name shapes.
describe("packPath / parseRoute round trip", () => {
  for (const name of ["gascity", "cacc-twin-team", "wespd/cacc-twin-team", "acme/tools"]) {
    test(`round trips ${name}`, () => {
      expect(parseRoute(packPath(name))).toEqual({ kind: "pack", name });
    });
  }
});
