import { describe, expect, test } from "bun:test";
import { selectFeaturedPacks } from "./catalogCuration";
import { filterAndSortPacks } from "./catalogFilters";
import type { CatalogPack } from "./registry";
import type { SearchState } from "./urlState";

function pack(
  name: string,
  options: {
    packKey?: string;
    tier?: CatalogPack["tier"];
    publisher?: string;
    active?: boolean;
  } = {},
): CatalogPack {
  return {
    packKey: options.packKey ?? `source--${name}`,
    registry: "source",
    name,
    tier: options.tier ?? "maintained",
    publisher: options.publisher ?? "Gas City",
    description: `${name} pack`,
    source: `https://example.com/${name}`,
    sourceKind: "git",
    searchText: "",
    releases: [
      {
        version: "1.0.0",
        ref: "main",
        commit: "a".repeat(40),
        hash: `sha256:${"b".repeat(64)}`,
        description: "release",
        withdrawn: options.active === false,
      },
    ],
  };
}

const featuredSearch: SearchState = {
  query: "",
  category: "all",
  author: "",
  includeWithdrawn: true,
  sort: "featured",
  view: "grid",
};

describe("Featured curation", () => {
  test("selects exact configured pack keys in declared order, independent of catalog order", () => {
    const packs = [pack("zulu"), pack("alpha"), pack("beta")];
    expect(
      selectFeaturedPacks(packs, ["source--beta", "source--alpha"]).map(
        (candidate) => candidate.name,
      ),
    ).toEqual(["beta", "alpha"]);
  });

  test("skips missing, withdrawn, and unknown-publisher entries without alphabetic backfill", () => {
    const packs = [
      pack("alpha", { active: false }),
      pack("beta", { publisher: "Unknown publisher" }),
      pack("unconfigured"),
    ];
    expect(
      selectFeaturedPacks(packs, [
        "source--missing",
        "source--alpha",
        "source--beta",
      ]),
    ).toEqual([]);
  });

  test("a known community pack is eligible only through its exact configured key", () => {
    const community = pack("acme/tool", {
      packKey: "direct--acme--tool",
      tier: "community",
      publisher: "acme",
    });
    expect(selectFeaturedPacks([community], ["direct--acme--tool"])).toEqual([
      community,
    ]);
    expect(selectFeaturedPacks([community], ["source--acme--tool"])).toEqual([]);
  });

  test("a direct replacement with the same name cannot inherit a base pack curation key", () => {
    const replacement = pack("alpha", {
      packKey: "direct--alpha",
      tier: "community",
      publisher: "community",
    });
    expect(selectFeaturedPacks([replacement], ["gascity-packs--alpha"])).toEqual(
      [],
    );
  });

  test("default Featured browse sort shares curation rank, then active codepoint order, then withdrawn", () => {
    const packs = [
      pack("zulu"),
      pack("beta"),
      pack("withdrawn", { active: false }),
      pack("alpha"),
    ];
    expect(
      filterAndSortPacks(packs, featuredSearch, [
        "source--beta",
        "source--zulu",
      ]).map((candidate) => candidate.name),
    ).toEqual(["beta", "zulu", "alpha", "withdrawn"]);
  });
});
