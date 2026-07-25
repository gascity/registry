// findCatalogPackSource is a pure lookup over text the caller read. Its predecessor read
// ../dist/catalog.json and ../public/catalog.json through module constants, so no test could
// control what the ownership routes saw and the answer depended on whether `bun run build` had run.
// Every fixture here is inline for exactly that reason.
import { describe, expect, test } from "bun:test";
import { findCatalogPackSource } from "./catalog";

const catalogJson = JSON.stringify({
  schema: 1,
  packs: [
    {
      pack_key: "gascity-packs--bmad",
      name: "bmad",
      source: "https://github.com/gastownhall/gascity-packs/tree/main/bmad",
    },
    {
      pack_key: "gascity-packs--gastown",
      name: "gastown",
      source: "https://github.com/gastownhall/gascity-packs/tree/main/gastown",
    },
  ],
});

describe("findCatalogPackSource", () => {
  test("returns the pack identity and source for a known pack_key", () => {
    expect(findCatalogPackSource(catalogJson, "gascity-packs--bmad")).toEqual({
      packKey: "gascity-packs--bmad",
      name: "bmad",
      source: "https://github.com/gastownhall/gascity-packs/tree/main/bmad",
    });
  });

  test("returns null for a pack_key the artifact does not carry", () => {
    // The generated artifact never contains a `direct--` key — that is the whole reason
    // /api/ownership used to 422 for every direct publish. The caller resolves those against
    // pack_name_claims instead.
    expect(findCatalogPackSource(catalogJson, "direct--acme--thing")).toBeNull();
    expect(findCatalogPackSource(catalogJson, "gascity-packs--nope")).toBeNull();
  });

  test("a corrupt or shapeless artifact returns null instead of throwing", () => {
    // This feeds two public reads; a parse error must not 500 them. Failing closed is safe: with no
    // base pack found the caller falls through to the claim branch, which only answers `direct--`.
    expect(findCatalogPackSource("{not json", "gascity-packs--bmad")).toBeNull();
    expect(findCatalogPackSource("null", "gascity-packs--bmad")).toBeNull();
    expect(findCatalogPackSource(JSON.stringify({ schema: 1 }), "gascity-packs--bmad")).toBeNull();
    expect(findCatalogPackSource(JSON.stringify({ packs: "nope" }), "gascity-packs--bmad")).toBeNull();
  });

  test("skips entries missing any of pack_key, name or source", () => {
    const partial = JSON.stringify({
      packs: [
        { pack_key: "gascity-packs--x", name: "x" },
        { pack_key: "gascity-packs--y", name: "y", source: "   " },
        { pack_key: "gascity-packs--z", name: "z", source: 7 },
        null,
        "nope",
      ],
    });
    expect(findCatalogPackSource(partial, "gascity-packs--x")).toBeNull();
    expect(findCatalogPackSource(partial, "gascity-packs--y")).toBeNull();
    expect(findCatalogPackSource(partial, "gascity-packs--z")).toBeNull();
  });
});
