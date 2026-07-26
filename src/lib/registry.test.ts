import { afterEach, describe, expect, test } from "bun:test";
import { fetchRegistryCatalog } from "./registry";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const release = {
  version: "1.0.0",
  ref: "main",
  commit: "a".repeat(40),
  hash: `sha256:${"b".repeat(64)}`,
  description: "release",
};

describe("catalog attribution parsing", () => {
  test("JSON carries exact attribution and ordered Featured keys", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          schema: 1,
          featured_pack_keys: ["source--beta", "source--alpha"],
          packs: [
            {
              pack_key: "source--alpha",
              registry: "source",
              name: "alpha",
              tier: "maintained",
              publisher: "Gas City",
              description: "Alpha",
              source: "https://example.com/alpha",
              source_kind: "git",
              releases: [release],
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const catalog = await fetchRegistryCatalog();
    expect(catalog.featuredPackKeys).toEqual(["source--beta", "source--alpha"]);
    expect(catalog.packs[0]).toMatchObject({
      packKey: "source--alpha",
      registry: "source",
      tier: "maintained",
      publisher: "Gas City",
    });
  });

  test("TOML fallback preserves the canonical pack_key and attribution", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      return new Response(
        `schema = 1
featured_pack_keys = ["gascity-packs--alpha"]

[[pack]]
pack_key = "gascity-packs--alpha"
registry = "gascity-packs"
name = "alpha"
tier = "maintained"
publisher = "Gas City"
description = "Alpha"
source = "https://example.com/alpha"
source_kind = "git"

[[pack.release]]
version = "1.0.0"
ref = "main"
commit = "${"a".repeat(40)}"
hash = "sha256:${"b".repeat(64)}"
description = "release"
`,
        { headers: { "Content-Type": "text/plain" } },
      );
    }) as unknown as typeof fetch;

    const catalog = await fetchRegistryCatalog();
    expect(catalog.loadedFromFallback).toBe(true);
    expect(catalog.featuredPackKeys).toEqual(["gascity-packs--alpha"]);
    expect(catalog.packs[0]).toMatchObject({
      packKey: "gascity-packs--alpha",
      registry: "gascity-packs",
      tier: "maintained",
      publisher: "Gas City",
    });
  });

  test("missing, invalid, and unattributed maintained metadata all downgrade to Community", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          schema: 1,
          featured_pack_keys: [],
          packs: [
            {
              pack_key: "direct--missing",
              registry: "direct",
              name: "missing",
              description: "Missing",
              source: "https://example.com/missing",
              source_kind: "git",
              releases: [release],
            },
            {
              pack_key: "direct--invalid",
              registry: "direct",
              name: "invalid",
              tier: "official",
              publisher: "Impostor",
              description: "Invalid",
              source: "https://example.com/invalid",
              source_kind: "git",
              releases: [release],
            },
            {
              pack_key: "direct--unattributed",
              registry: "direct",
              name: "unattributed",
              tier: "maintained",
              publisher: " ",
              description: "Unattributed",
              source: "https://example.com/unattributed",
              source_kind: "git",
              releases: [release],
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const catalog = await fetchRegistryCatalog();
    expect(
      Object.fromEntries(
        catalog.packs.map(({ name, tier, publisher }) => [
          name,
          { tier, publisher },
        ]),
      ),
    ).toEqual({
      missing: { tier: "community", publisher: "Unknown publisher" },
      invalid: { tier: "community", publisher: "Impostor" },
      unattributed: { tier: "community", publisher: "Unknown publisher" },
    });
  });
});
