/// <reference types="bun" />
// Runs under plain `bun test`: `import.meta.env.BASE_URL` is undefined outside Vite, so
// base.ts's MOUNT_BASE is "" and stripBase/withBase are identities here. That is the standalone
// build's configuration, which is the one the tests below are written against.
import { describe, expect, test } from "bun:test";
import {
  buildSearchString,
  hasActiveSearch,
  packPath,
  parseRoute,
  readSearchState,
  type SearchState,
} from "./urlState";

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

const idleState: SearchState = {
  query: "",
  category: "all",
  author: "",
  includeWithdrawn: false,
  sort: "featured",
  view: "list",
};

describe("hasActiveSearch", () => {
  test("a non-empty query is an active search", () => {
    expect(hasActiveSearch({ ...idleState, query: "slack" })).toBe(true);
  });

  test("an empty or whitespace-only query is not", () => {
    expect(hasActiveSearch(idleState)).toBe(false);
    expect(hasActiveSearch({ ...idleState, query: "   " })).toBe(false);
  });

  // An author filter also collapses the page: it only ever arrives from the pack-detail
  // link or a deep link, never from a control inside the browse section, so landing on the
  // author's packs directly under the search bar is the intended behavior.
  test("a non-empty author is an active search", () => {
    expect(hasActiveSearch({ ...idleState, author: "wespd" })).toBe(true);
  });

  test("a whitespace-only author is not", () => {
    expect(hasActiveSearch({ ...idleState, author: "   " })).toBe(false);
  });

  // The collapse is query/author only: category/withdrawn controls live inside the browse
  // section (collapsing above them would yank the page), and sort/view are presentation.
  test("category, withdrawn, sort, and view alone are not an active search", () => {
    expect(hasActiveSearch({ ...idleState, category: "integration" })).toBe(false);
    expect(hasActiveSearch({ ...idleState, includeWithdrawn: true })).toBe(false);
    expect(hasActiveSearch({ ...idleState, sort: "name" })).toBe(false);
    expect(hasActiveSearch({ ...idleState, view: "grid" })).toBe(false);
  });
});

describe("search state author", () => {
  test("the author key round-trips through readSearchState", () => {
    expect(readSearchState("?author=wespd").author).toBe("wespd");
    expect(readSearchState("").author).toBe("");
  });

  test("buildSearchString emits the author key only when set", () => {
    expect(buildSearchString({ ...readSearchState(""), author: "wespd" })).toBe("?author=wespd");
    expect(buildSearchString(readSearchState(""))).toBe("");
  });

  // readSearchState now constrains author to the GitHub owner shape, so a value with a
  // space (which a real derived author can never contain) is rejected to "" — closing the
  // tab-title / og / filter-chip spoofing vector for arbitrary ?author= copy.
  test("an author outside the GitHub owner shape is rejected", () => {
    expect(readSearchState("?author=a%20b").author).toBe("");
  });

  test("a valid GitHub owner round-trips and invalid shapes normalize to empty", () => {
    expect(readSearchState("?author=WesPD-123").author).toBe("WesPD-123");
    expect(readSearchState("?author=%3Cimg%3E").author).toBe("");
    expect(readSearchState(`?author=${"a".repeat(40)}`).author).toBe("");
  });
});

describe("readSearchState", () => {
  // Mirrors the sort validation: an unknown ?category=bogus would otherwise filter the
  // catalog to nothing with no active-filter chip and no way back but the sidebar.
  test("an unknown category falls back to all", () => {
    expect(readSearchState("?category=bogus").category).toBe("all");
    expect(readSearchState("?category=integration").category).toBe("integration");
    expect(hasActiveSearch(readSearchState("?category=bogus"))).toBe(false);
  });
});
