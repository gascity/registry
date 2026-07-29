/// <reference types="bun" />
// `src/lib/*` runs under plain `bun test` (no DOM, no Vite): packAuthor.ts imports nothing,
// which is what keeps that true. The author is derived from the GitHub owner segment of the
// source URL — the only ownership signal present for every pack in the catalog.
import { describe, expect, test } from "bun:test";
import { packAuthor } from "./packAuthor";

describe("packAuthor", () => {
  // Ingested packs point at a tree URL under the org repo; the owner is the org.
  test("an ingested tree URL yields the repo owner", () => {
    expect(packAuthor("https://github.com/gastownhall/gascity-packs/tree/main/gascity")).toBe(
      "gastownhall",
    );
  });

  // Direct-published packs point at the claimed repo root — the cacc-twin-team shape.
  test("a repo-root URL yields the owner", () => {
    expect(packAuthor("https://github.com/wespd/cacc-twin-team")).toBe("wespd");
  });

  test("www.github.com is accepted", () => {
    expect(packAuthor("https://www.github.com/acme/x")).toBe("acme");
  });

  // GitHub logins are case-insensitive, but the displayed value keeps the source casing;
  // callers lowercase for comparison.
  test("case is preserved in the returned owner", () => {
    expect(packAuthor("https://github.com/WesPD/x")).toBe("WesPD");
  });

  test("a non-github host has no derivable author", () => {
    expect(packAuthor("https://gitlab.com/acme/x")).toBeUndefined();
  });

  test("an unparseable string has no derivable author", () => {
    expect(packAuthor("not a url")).toBeUndefined();
  });

  test("a github URL with an empty path has no derivable author", () => {
    expect(packAuthor("https://github.com/")).toBeUndefined();
  });
});
