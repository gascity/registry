/// <reference types="bun" />
// Runs under plain `bun test`. catalogFilters.ts pulls in registry.ts (which imports
// lucide-react for its category icons) but only for type/helper access, so the module
// imports cleanly here. These tests pin the ?author= filter added for issue #53.
import { describe, expect, test } from "bun:test";
import { filterAndSortPacks } from "./catalogFilters";
import type { CatalogPack } from "./registry";
import { readSearchState, type SearchState } from "./urlState";

function makePack(name: string, source: string): CatalogPack {
  return {
    packKey: `test--${name}`,
    registry: "test",
    name,
    tier: "community",
    publisher: "Test",
    description: "",
    source,
    sourceKind: "git",
    searchText: "",
    releases: [
      {
        version: "1.0.0",
        ref: "refs/tags/v1.0.0",
        commit: "0".repeat(40),
        hash: "sha256:0",
        description: "",
        withdrawn: false,
      },
    ],
  };
}

function stateWithAuthor(author: string): SearchState {
  return { ...readSearchState(""), author };
}

const wespdPack = makePack("cacc-twin-team", "https://github.com/wespd/cacc-twin-team");
const orgPack = makePack("gascity", "https://github.com/gastownhall/gascity-packs/tree/main/gascity");
const unparseablePack = makePack("mystery", "not a url");
const packs = [wespdPack, orgPack, unparseablePack];

describe("filterAndSortPacks author filter", () => {
  test("keeps only packs whose source owner matches", () => {
    const result = filterAndSortPacks(packs, stateWithAuthor("wespd"));
    expect(result.map((pack) => pack.name)).toEqual(["cacc-twin-team"]);
  });

  test("matches case-insensitively on both sides", () => {
    const result = filterAndSortPacks(packs, stateWithAuthor("WesPD"));
    expect(result.map((pack) => pack.name)).toEqual(["cacc-twin-team"]);
  });

  // Pins the pack-side .toLowerCase(): a mixed-case SOURCE owner must match a lowercase
  // filter (the reverse direction of the case above), so dropping either normalization
  // is caught rather than passing on lowercase-only fixtures.
  test("a mixed-case source owner matches a lowercase filter", () => {
    const mixedPack = makePack("mixed", "https://github.com/WesPD/mixed");
    const result = filterAndSortPacks([mixedPack], stateWithAuthor("wespd"));
    expect(result.map((pack) => pack.name)).toEqual(["mixed"]);
  });

  test("an empty author leaves the list unfiltered", () => {
    const result = filterAndSortPacks(packs, stateWithAuthor(""));
    expect(result).toHaveLength(3);
  });

  // A pack whose source owner cannot be derived can never be attributed, so it drops out of
  // any author-filtered list.
  test("a pack with an underivable author is excluded when an author filter is active", () => {
    const result = filterAndSortPacks(packs, stateWithAuthor("gastownhall"));
    expect(result.map((pack) => pack.name)).toEqual(["gascity"]);
  });
});
