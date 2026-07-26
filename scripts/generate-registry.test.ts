import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { parse } from "smol-toml";
import {
  aggregateSources,
  checkOutputs,
  type IngestWarning,
  outputPaths,
  readCatalogJson,
  readRegistryConfig,
  renderCatalogJson,
  renderOgFiles,
  renderRegistryToml,
  reservedOgFilenameList,
} from "./generate-registry.lib.ts";

// Every fixture uses file:// sources and https://example.com pack sources, so nothing here
// touches the network (readme enrichment only fetches for github.com hosts). We additionally
// poison `fetch` to prove it: any accidental network call throws.
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const HASH_0 = `sha256:${"0".repeat(64)}`;
const HASH_1 = `sha256:${"1".repeat(64)}`;

const SCRIPT = fileURLToPath(new URL("./generate-registry.ts", import.meta.url));
const POISON = fileURLToPath(new URL("./poison-fetch.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

let fetchCalls = 0;
let originalFetch: typeof fetch;
let gitBefore = "";
const createdDirs: string[] = [];

function gitStatus() {
  const proc = Bun.spawnSync(["git", "status", "--porcelain", "public/", "sources.toml"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
  });
  return proc.stdout.toString().trim();
}

beforeAll(() => {
  gitBefore = gitStatus();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    fetchCalls += 1;
    const target = typeof input === "string" ? input : String((input as { url?: unknown })?.url);
    throw new Error(`unexpected network fetch in test: ${target}`);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  // The suite must not change the committed tree (relative to however it started).
  expect(gitStatus()).toBe(gitBefore);
});

afterEach(() => {
  // Global hermeticity guard: no in-process test may reach (or attempt) the network.
  expect(fetchCalls).toBe(0);
  fetchCalls = 0;
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genreg-"));
  createdDirs.push(dir);
  return dir;
}

function releaseBlock(
  version: string,
  opts: { commit?: string; hash?: string; withdrawn?: boolean; reason?: string } = {},
) {
  const lines = [
    "  [[pack.release]]",
    `    version = "${version}"`,
    `    ref = "v${version}"`,
    `    commit = "${opts.commit ?? COMMIT_A}"`,
    `    hash = "${opts.hash ?? HASH_0}"`,
    `    description = "release ${version}"`,
  ];
  if (opts.withdrawn) lines.push("    withdrawn = true");
  if (opts.reason) lines.push(`    withdrawn_reason = "${opts.reason}"`);
  return lines.join("\n");
}

function packBlock(
  name: string,
  releases: string[],
  opts: { source?: string; description?: string; sourceKind?: string } = {},
) {
  return [
    "[[pack]]",
    `name = "${name}"`,
    `description = "${opts.description ?? `${name} pack`}"`,
    `source = "${opts.source ?? `https://example.com/${name}`}"`,
    `source_kind = "${opts.sourceKind ?? "git"}"`,
    "",
    ...releases,
  ].join("\n");
}

function catalogToml(...packBlocks: string[]) {
  return `schema = 1\n\n${packBlocks.join("\n\n")}\n`;
}

// Write an upstream registry.toml to disk and return a file:// source plus a matching
// sources.toml (for checkOutputs-based tests).
async function writeUpstream(
  name: string,
  toml: string,
  options: {
    publisher?: string;
    trusted?: boolean;
    expectedPacks?: string[];
    featuredPackKeys?: string[];
  } = {},
) {
  const dir = await tmp();
  const upstream = join(dir, "upstream.toml");
  await writeFile(upstream, toml);
  const url = pathToFileURL(upstream).href;
  const expectedPacks =
    options.expectedPacks ??
    [...toml.matchAll(/^name = "([^"]+)"$/gm)]
      .map((match) => match[1])
      .filter((packName) => /^[a-z0-9][a-z0-9-]*$/.test(packName) && packName.length <= 64)
      .filter((packName, index, names) => names.indexOf(packName) === index);
  const publisher = options.publisher ?? `${name} publisher`;
  const trusted = options.trusted ?? false;
  const featuredPackKeys = options.featuredPackKeys ?? [];
  const sourcesFile = join(dir, "sources.toml");
  await writeFile(
    sourcesFile,
    [
      "schema = 1",
      `featured_pack_keys = ${JSON.stringify(featuredPackKeys)}`,
      "",
      "[[source]]",
      `name = "${name}"`,
      `url = "${url}"`,
      `publisher = "${publisher}"`,
      `trusted = ${trusted}`,
      `expected_packs = ${JSON.stringify(expectedPacks)}`,
      "",
    ].join("\n"),
  );
  return {
    name,
    url,
    publisher,
    trusted,
    expectedPacks: options.expectedPacks,
    sourcesPath: pathToFileURL(sourcesFile),
  };
}

async function aggregate(sources: Array<{ name: string; url: string }>) {
  const collected: IngestWarning[] = [];
  const result = await aggregateSources(sources, { onWarning: (w) => collected.push(w) });
  // onWarning stream and the returned array must agree.
  expect(collected).toEqual(result.warnings);
  return result;
}

describe("registry-controlled attribution and curation config", () => {
  it("parses source attribution, its exact pack allowlist, and ordered Featured keys", async () => {
    const src = await writeUpstream(
      "curated",
      catalogToml(
        packBlock("alpha", [releaseBlock("1.0")]),
        packBlock("beta", [releaseBlock("1.0")]),
      ),
      {
        publisher: "Gas City",
        trusted: true,
        featuredPackKeys: ["curated--beta", "curated--alpha"],
      },
    );

    await expect(readRegistryConfig(src.sourcesPath)).resolves.toEqual({
      sources: [
        {
          name: "curated",
          url: src.url,
          publisher: "Gas City",
          trusted: true,
          expectedPacks: ["alpha", "beta"],
        },
      ],
      featuredPackKeys: ["curated--beta", "curated--alpha"],
    });
  });

  it("rejects a non-boolean trusted declaration instead of treating a truthy string as maintained", async () => {
    const src = await writeUpstream(
      "typed",
      catalogToml(packBlock("alpha", [releaseBlock("1.0")])),
    );
    const text = (await Bun.file(src.sourcesPath).text()).replace(
      "trusted = false",
      'trusted = "false"',
    );
    const patched = join(await tmp(), "sources.toml");
    await writeFile(patched, text);

    await expect(readRegistryConfig(pathToFileURL(patched))).rejects.toThrow(
      /typed\.trusted must be a boolean/,
    );
  });

  it("rejects a missing publisher instead of minting unattributed maintained metadata", async () => {
    const src = await writeUpstream(
      "missing-publisher",
      catalogToml(packBlock("alpha", [releaseBlock("1.0")])),
      { trusted: true },
    );
    const text = (await Bun.file(src.sourcesPath).text()).replace(
      /^publisher = .*$/m,
      "",
    );
    const patched = join(await tmp(), "sources.toml");
    await writeFile(patched, text);

    await expect(readRegistryConfig(pathToFileURL(patched))).rejects.toThrow(
      /missing-publisher\.publisher is required/,
    );
  });

  it("rejects duplicate Featured keys independently of the pack allowlist", async () => {
    const src = await writeUpstream(
      "featured-dup",
      catalogToml(packBlock("alpha", [releaseBlock("1.0")])),
      { featuredPackKeys: ["featured-dup--alpha", "featured-dup--alpha"] },
    );
    await expect(readRegistryConfig(src.sourcesPath)).rejects.toThrow(
      /duplicate featured pack_key "featured-dup--alpha"/,
    );
  });

  it("rejects an unknown Featured key independently of duplicate checking", async () => {
    const src = await writeUpstream(
      "featured-unknown",
      catalogToml(packBlock("alpha", [releaseBlock("1.0")])),
      { featuredPackKeys: ["featured-unknown--ghost"] },
    );
    await expect(readRegistryConfig(src.sourcesPath)).rejects.toThrow(
      /featured pack_key "featured-unknown--ghost" is not declared/,
    );
  });

  it("rejects more than four Featured keys independently of duplicate and unknown checking", async () => {
    const names = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const src = await writeUpstream(
      "featured-limit",
      catalogToml(...names.map((name) => packBlock(name, [releaseBlock("1.0")]))),
      { featuredPackKeys: names.map((name) => `featured-limit--${name}`) },
    );
    await expect(readRegistryConfig(src.sourcesPath)).rejects.toThrow(
      /featured_pack_keys may contain at most 4 entries/,
    );
  });
});

describe("registry-controlled attribution and expected-pack integrity", () => {
  it("derives maintained attribution only from a source whose trusted bit is exactly true", async () => {
    const maintained = await writeUpstream(
      "maintained-source",
      catalogToml(packBlock("alpha", [releaseBlock("1.0")])),
      { publisher: "Gas City", trusted: true },
    );
    const community = await writeUpstream(
      "community-source",
      catalogToml(packBlock("beta", [releaseBlock("1.0")])),
      { publisher: "Community Lab", trusted: false },
    );

    const result = await aggregateSources([maintained, community]);
    expect(result.packs.map(({ name, tier, publisher }) => ({ name, tier, publisher }))).toEqual([
      { name: "alpha", tier: "maintained", publisher: "Gas City" },
      { name: "beta", tier: "community", publisher: "Community Lab" },
    ]);
  });

  it("ignores upstream self-attribution and keeps the local source policy", async () => {
    const upstream = catalogToml(packBlock("alpha", [releaseBlock("1.0")])).replace(
      'source_kind = "git"',
      'source_kind = "git"\ntier = "maintained"\npublisher = "Gas City"',
    );
    const src = await writeUpstream("community-source", upstream, {
      publisher: "Independent Publisher",
      trusted: false,
    });

    const { packs } = await aggregateSources([src]);
    expect(packs[0]).toMatchObject({
      tier: "community",
      publisher: "Independent Publisher",
    });
  });

  it("fails when a trusted upstream adds an unreviewed pack outside expected_packs", async () => {
    const src = await writeUpstream(
      "curated",
      catalogToml(
        packBlock("alpha", [releaseBlock("1.0")]),
        packBlock("surprise", [releaseBlock("1.0")]),
      ),
      {
        publisher: "Gas City",
        trusted: true,
        expectedPacks: ["alpha"],
      },
    );

    await expect(aggregateSources([src])).rejects.toThrow(
      /curated: unexpected pack "surprise" is not declared in expected_packs/,
    );
  });

  it("fails when an expected pack disappears instead of silently shrinking the curated source", async () => {
    const src = await writeUpstream(
      "curated",
      catalogToml(packBlock("alpha", [releaseBlock("1.0")])),
      {
        publisher: "Gas City",
        trusted: true,
        expectedPacks: ["alpha", "missing"],
      },
    );

    await expect(aggregateSources([src])).rejects.toThrow(
      /curated: expected pack "missing" is absent/,
    );
  });

  it("emits identical attribution, canonical pack keys, and curation in JSON and TOML", async () => {
    const src = await writeUpstream(
      "curated",
      catalogToml(packBlock("alpha", [releaseBlock("1.0")])),
      {
        publisher: "Gas City",
        trusted: true,
        featuredPackKeys: ["curated--alpha"],
      },
    );
    const config = await readRegistryConfig(src.sourcesPath);
    const { packs, sourceSummaries } = await aggregateSources(config.sources);
    const toml = parse(renderRegistryToml(packs, config.featuredPackKeys)) as {
      featured_pack_keys: string[];
      pack: Array<Record<string, unknown>>;
    };
    const json = JSON.parse(
      renderCatalogJson(packs, sourceSummaries, config.featuredPackKeys),
    ) as {
      featured_pack_keys: string[];
      packs: Array<Record<string, unknown>>;
    };

    expect(toml.featured_pack_keys).toEqual(["curated--alpha"]);
    expect(json.featured_pack_keys).toEqual(toml.featured_pack_keys);
    expect(toml.pack[0]).toMatchObject({
      pack_key: "curated--alpha",
      registry: "curated",
      tier: "maintained",
      publisher: "Gas City",
    });
    expect(json.packs[0]).toMatchObject({
      pack_key: "curated--alpha",
      registry: "curated",
      tier: "maintained",
      publisher: "Gas City",
    });
  });
});

describe("ingest policy (skip-and-warn)", () => {
  it("a clean source produces no warnings", async () => {
    const src = await writeUpstream("clean", catalogToml(packBlock("alpha", [releaseBlock("1.0")])));
    const { packs, warnings } = await aggregate([src]);
    expect(warnings).toEqual([]);
    expect(packs.map((p) => p.name)).toEqual(["alpha"]);
  });

  it("skips a bad pack and keeps the good ones", async () => {
    const src = await writeUpstream(
      "mixed",
      catalogToml(
        packBlock("alpha", [releaseBlock("1.0")]),
        packBlock("BAD NAME", [releaseBlock("1.0")]),
        packBlock("gamma", [releaseBlock("1.0")]),
      ),
    );
    const { packs, warnings } = await aggregate([src]);
    expect(packs.map((p) => p.name)).toEqual(["alpha", "gamma"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].scope).toBe("pack");
  });

  it("skips a bad release but keeps the pack's valid releases", async () => {
    const src = await writeUpstream(
      "rel",
      catalogToml(
        packBlock("alpha", [
          releaseBlock("1.0"),
          releaseBlock("1.1", { commit: "nothex" }),
          releaseBlock("1.2"),
        ]),
      ),
    );
    const { packs, warnings } = await aggregate([src]);
    expect(packs[0].releases.map((r) => r.version)).toEqual(["1.0", "1.2"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].scope).toBe("release");
  });

  it("skips a pack whose every declared release is invalid", async () => {
    const src = await writeUpstream(
      "allbad",
      catalogToml(
        packBlock("alpha", [releaseBlock("1.0")]),
        packBlock("beta", [releaseBlock("9.9", { hash: "sha256:short" })]),
      ),
    );
    const { packs, warnings } = await aggregate([src]);
    expect(packs.map((p) => p.name)).toEqual(["alpha"]);
    // one release warning (bad hash) + one pack warning (all releases invalid)
    expect(warnings.map((w) => w.scope).sort()).toEqual(["pack", "release"]);
  });

  it("keeps a pack that declared no releases and one that is all-withdrawn", async () => {
    const src = await writeUpstream(
      "edge",
      catalogToml(
        packBlock("empty", []),
        packBlock("withdrawn-only", [releaseBlock("1.0", { withdrawn: true, reason: "gone" })]),
      ),
    );
    const { packs, warnings } = await aggregate([src]);
    expect(warnings).toEqual([]);
    expect(packs.map((p) => p.name).sort()).toEqual(["empty", "withdrawn-only"]);
  });

  it("keeps the first of identical within-source duplicate packs, warns", async () => {
    const dup = packBlock("dup", [releaseBlock("1.0")]);
    const src = await writeUpstream("wdup", catalogToml(dup, dup));
    const { packs, warnings } = await aggregate([src]);
    expect(packs.map((p) => p.name)).toEqual(["dup"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ scope: "collision", pack: "dup" });
  });

  it("drops all copies of conflicting within-source duplicate packs, warns", async () => {
    const src = await writeUpstream(
      "cdup",
      catalogToml(
        packBlock("keep", [releaseBlock("1.0")]),
        packBlock("dup", [releaseBlock("1.0", { commit: COMMIT_A })]),
        packBlock("dup", [releaseBlock("1.0", { commit: COMMIT_B })]),
      ),
    );
    const { packs, warnings } = await aggregate([src]);
    expect(packs.map((p) => p.name)).toEqual(["keep"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ scope: "collision", pack: "dup" });
  });

  it("drops conflicting duplicate release versions within a pack", async () => {
    const src = await writeUpstream(
      "reldup",
      catalogToml(
        packBlock("alpha", [
          releaseBlock("1.0", { commit: COMMIT_A }),
          releaseBlock("1.0", { commit: COMMIT_B }),
          releaseBlock("2.0"),
        ]),
      ),
    );
    const { packs, warnings } = await aggregate([src]);
    expect(packs[0].releases.map((r) => r.version)).toEqual(["2.0"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ scope: "release", release: "1.0" });
  });

  it("cross-source collision: first source in order wins, warns", async () => {
    const first = await writeUpstream(
      "first",
      catalogToml(packBlock("shared", [releaseBlock("1.0", { commit: COMMIT_A })])),
    );
    const second = await writeUpstream(
      "second",
      catalogToml(
        packBlock("shared", [releaseBlock("1.0", { commit: COMMIT_B })]),
        packBlock("unique", [releaseBlock("1.0")]),
      ),
    );
    const { packs, sourceSummaries, warnings } = await aggregate([first, second]);
    const shared = packs.find((p) => p.name === "shared");
    expect(shared?.releases[0].commit).toBe(COMMIT_A);
    expect(packs.map((p) => p.name).sort()).toEqual(["shared", "unique"]);
    expect(sourceSummaries).toEqual([
      { name: "first", url: first.url, packCount: 1 },
      { name: "second", url: second.url, packCount: 1 },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ scope: "collision", source: "second", pack: "shared" });
  });

  it("never performs a network fetch for file:// + example.com fixtures", async () => {
    const src = await writeUpstream("net", catalogToml(packBlock("alpha", [releaseBlock("1.0")])));
    await aggregate([src]);
    expect(fetchCalls).toBe(0);
  });

  it("skips a pack that used [pack.release] instead of [[pack.release]] (keeps others)", async () => {
    const typo = [
      "[[pack]]",
      'name = "bad"',
      'description = "bad pack"',
      'source = "https://example.com/bad"',
      'source_kind = "git"',
      "",
      "  [pack.release]",
      '    version = "1.0"',
      '    ref = "v1.0"',
      `    commit = "${COMMIT_A}"`,
      `    hash = "${HASH_0}"`,
      '    description = "r"',
    ].join("\n");
    const src = await writeUpstream(
      "reltypo",
      catalogToml(packBlock("good", [releaseBlock("1.0")]), typo),
    );
    const { packs, warnings } = await aggregate([src]);
    expect(packs.map((p) => p.name)).toEqual(["good"]);
    expect(warnings.some((w) => w.scope === "pack" && /array of tables/.test(w.reason))).toBe(true);
  });

  it("keeps (does not crash on) a github source with a malformed percent-escape", async () => {
    const src = await writeUpstream(
      "pct",
      catalogToml(
        packBlock("alpha", [releaseBlock("1.0")], { source: "https://github.com/o/r/tree/50%zz/x" }),
      ),
    );
    const { packs } = await aggregate([src]);
    expect(packs.map((p) => p.name)).toEqual(["alpha"]);
    expect(packs[0].readme).toBeUndefined();
    expect(fetchCalls).toBe(0);
  });

  // Ingested names are bare, so two packs can only share a derived identity across sources:
  // source `x--a` + pack `b` and source `x` + pack `a--b` both flatten to pack_key `x--a--b`.
  // (The og-filename half of that check is unreachable for bare names — see the comment on it.)
  it("skips a pack whose pack_key collides with another source's", async () => {
    const first = await writeUpstream("x--a", catalogToml(packBlock("b", [releaseBlock("1.0")])));
    const second = await writeUpstream("x", catalogToml(packBlock("a--b", [releaseBlock("1.0")])));
    const { packs, warnings } = await aggregate([first, second]);
    expect(packs.map((p) => p.name)).toEqual(["a--b"]);
    expect(warnings.some((w) => w.scope === "collision")).toBe(true);
  });

  it("skips a scoped upstream pack name and keeps the rest of the source", async () => {
    const src = await writeUpstream(
      "scoped",
      catalogToml(
        packBlock("alpha", [releaseBlock("1.0")]),
        packBlock("wespd/cacc-twin-team", [releaseBlock("1.0")]),
      ),
    );
    const { packs, warnings } = await aggregate([src]);
    expect(packs.map((p) => p.name)).toEqual(["alpha"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].scope).toBe("pack");
    expect(warnings[0].reason).toMatch(/scoped pack names are not ingestable/i);
  });

  it("escalates to fatal when every declared pack is scoped", async () => {
    const src = await writeUpstream("solo", catalogToml(packBlock("wespd/only", [releaseBlock("1.0")])));
    await expect(aggregate([src])).rejects.toThrow(/all 1 declared pack\(s\) failed validation/);
  });

  it("skips an upstream pack name longer than 64 characters", async () => {
    const src = await writeUpstream(
      "long",
      catalogToml(
        packBlock("alpha", [releaseBlock("1.0")]),
        packBlock("a".repeat(65), [releaseBlock("1.0")]),
      ),
    );
    const { packs, warnings } = await aggregate([src]);
    expect(packs.map((p) => p.name)).toEqual(["alpha"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].scope).toBe("pack");
    expect(warnings[0].reason).toMatch(/invalid pack name/);
  });

  it("still ingests a bare name with consecutive dashes and a 64-character name", async () => {
    const src = await writeUpstream(
      "dashes",
      catalogToml(
        packBlock("a--b", [releaseBlock("1.0")]),
        packBlock("a".repeat(64), [releaseBlock("1.0")]),
      ),
    );
    const { packs, warnings } = await aggregate([src]);
    expect(packs.map((p) => p.name)).toEqual(["a--b", "a".repeat(64)]);
    expect(warnings).toEqual([]);
  });

  // renderOgFiles writes the site-wide card FIRST and then one file per pack, so an upstream pack
  // named `registry` used to overwrite it: 16 og files instead of 17, zero warnings, and
  // generate:check green because the tree stayed self-consistent. Every pack that falls back to
  // /og/registry.svg then rendered that pack's card.
  it("skips an upstream pack that would overwrite the reserved site og card", async () => {
    const src = await writeUpstream(
      "squatter",
      catalogToml(
        packBlock("alpha", [releaseBlock("1.0")]),
        packBlock("registry", [releaseBlock("1.0")]),
      ),
    );
    const { packs, sourceSummaries, warnings } = await aggregate([src]);
    expect(packs.map((p) => p.name)).toEqual(["alpha"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].scope).toBe("pack"); // skip-and-warn, NOT fatal: the refresh keeps running
    expect(warnings[0].reason).toMatch(/reserved; its og card og\/registry\.svg/);

    // ...and the site card is still the site card.
    const og = renderOgFiles(packs, sourceSummaries);
    expect(og.map((f) => f.filename)).toEqual(["registry.svg", "alpha.svg"]);
    expect(og[0].content).toContain("Gas City Pack Registry"); // the site card's eyebrow, not a pack's
  });

  // The reserved set has to BE what the renderer emits beyond the per-pack files. With no packs,
  // renderOgFiles emits exactly the reserved files — so a future non-pack card added to the
  // renderer but not to the set fails here instead of becoming squattable.
  it("the reserved og filename set is exactly what renderOgFiles emits for zero packs", () => {
    expect(renderOgFiles([], []).map((file) => file.filename)).toEqual(reservedOgFilenameList());
  });

  it("skips a release whose withdrawn is not a boolean", async () => {
    const badWithdrawn = [
      "  [[pack.release]]",
      '    version = "2.0"',
      '    ref = "v2.0"',
      `    commit = "${COMMIT_A}"`,
      `    hash = "${HASH_0}"`,
      '    description = "r"',
      '    withdrawn = "true"',
    ].join("\n");
    const src = await writeUpstream("wd", catalogToml(packBlock("alpha", [releaseBlock("1.0"), badWithdrawn])));
    const { packs, warnings } = await aggregate([src]);
    expect(packs[0].releases.map((r) => r.version)).toEqual(["1.0"]);
    expect(warnings.some((w) => w.scope === "release" && /boolean/.test(w.reason))).toBe(true);
  });
});

describe("source-level failures are fatal", () => {
  it("throws when an upstream source cannot be read", async () => {
    const missing = pathToFileURL(join(await tmp(), "nope.toml")).href;
    await expect(aggregateSources([{ name: "gone", url: missing }])).rejects.toThrow();
  });

  it("throws on malformed upstream TOML", async () => {
    const src = await writeUpstream("bad", "this is not valid toml {{{");
    await expect(aggregateSources([src])).rejects.toThrow();
  });

  it("throws on an unsupported catalog schema", async () => {
    const src = await writeUpstream("v2", "schema = 2\n");
    await expect(aggregateSources([src])).rejects.toThrow(/schema/);
  });

  it("throws on a non-number catalog schema (not silently defaulted)", async () => {
    const src = await writeUpstream("bogus", 'schema = "1"\n');
    await expect(aggregateSources([src])).rejects.toThrow(/schema must be a number/);
  });

  it("throws on a single-table [pack] instead of [[pack]] (does not silently wipe the source)", async () => {
    const src = await writeUpstream("packtypo", 'schema = 1\n\n[pack]\nname = "alpha"\n');
    await expect(aggregateSources([src])).rejects.toThrow(/array of tables/);
  });
});

describe("empty-catalog guards", () => {
  it("refuses when a source declared packs but none survived", async () => {
    const src = await writeUpstream("wipe", catalogToml(packBlock("BAD NAME", [releaseBlock("1.0")])));
    await expect(aggregateSources([src])).rejects.toThrow(/refusing to drop the entire source/);
  });

  it("refuses to write an empty catalog", async () => {
    const src = await writeUpstream("empty", "schema = 1\n");
    await expect(aggregateSources([src])).rejects.toThrow(/empty catalog/);
  });
});

// Generate a valid output tree for the offline-check tests, using the lib directly.
async function generateInto(sourcesPath: URL, outDir: URL) {
  const paths = outputPaths(outDir);
  const { sources, featuredPackKeys } = await readRegistryConfig(sourcesPath);
  const { packs, sourceSummaries } = await aggregateSources(sources);
  await Bun.write(paths.registry, renderRegistryToml(packs, featuredPackKeys));
  await Bun.write(
    paths.catalog,
    renderCatalogJson(packs, sourceSummaries, featuredPackKeys),
  );
  await mkdir(paths.ogDir, { recursive: true });
  for (const file of renderOgFiles(packs, sourceSummaries)) {
    await Bun.write(new URL(file.filename, paths.ogDir), file.content);
  }
}

describe("offline check (checkOutputs)", () => {
  async function goodOutput() {
    const src = await writeUpstream(
      "fx",
      catalogToml(
        packBlock("alpha", [releaseBlock("1.0"), releaseBlock("2.0")]),
        packBlock("beta", [releaseBlock("1.0")]),
      ),
    );
    const outDir = pathToFileURL(`${await tmp()}/`);
    await generateInto(src.sourcesPath, outDir);
    return { src, outDir };
  }

  async function copyOut(outDir: URL) {
    const dst = await tmp();
    await cp(fileURLToPath(outDir).replace(/\/+$/, ""), dst, { recursive: true });
    return pathToFileURL(`${dst}/`);
  }

  it("passes on freshly generated output with zero fetches", async () => {
    const { src, outDir } = await goodOutput();
    await expect(checkOutputs({ sourcesPath: src.sourcesPath, outDir })).resolves.toBeUndefined();
    expect(fetchCalls).toBe(0);
  });

  it("fails on a one-byte catalog.json edit, naming the file", async () => {
    const { src, outDir } = await goodOutput();
    const copy = await copyOut(outDir);
    const catalog = new URL("catalog.json", copy);
    await writeFile(fileURLToPath(catalog), `${await Bun.file(catalog).text()} `);
    await expect(checkOutputs({ sourcesPath: src.sourcesPath, outDir: copy })).rejects.toThrow(
      /catalog\.json is out of date/,
    );
  });

  it("fails on registry.toml drift", async () => {
    const { src, outDir } = await goodOutput();
    const copy = await copyOut(outDir);
    const registry = new URL("registry.toml", copy);
    await writeFile(fileURLToPath(registry), `${await Bun.file(registry).text()}\n# drift\n`);
    await expect(checkOutputs({ sourcesPath: src.sourcesPath, outDir: copy })).rejects.toThrow(
      /registry\.toml is out of date/,
    );
  });

  it("fails with a friendly message on a missing og file", async () => {
    const { src, outDir } = await goodOutput();
    const copy = await copyOut(outDir);
    await rm(fileURLToPath(new URL("og/alpha.svg", copy)));
    await expect(checkOutputs({ sourcesPath: src.sourcesPath, outDir: copy })).rejects.toThrow(
      /alpha\.svg is missing/,
    );
  });

  it("fails on a stale og file", async () => {
    const { src, outDir } = await goodOutput();
    const copy = await copyOut(outDir);
    await writeFile(fileURLToPath(new URL("og/orphan.svg", copy)), "<svg></svg>");
    await expect(checkOutputs({ sourcesPath: src.sourcesPath, outDir: copy })).rejects.toThrow(
      /orphan\.svg is stale/,
    );
  });

  it("fails when sources.toml gains a source without regenerating", async () => {
    const { src, outDir } = await goodOutput();
    const patched = join(await tmp(), "sources.toml");
    const extra = pathToFileURL(join(await tmp(), "extra.toml")).href;
    await writeFile(
      patched,
      `${await Bun.file(src.sourcesPath).text()}\n[[source]]\nname = "extra"\nurl = "${extra}"\npublisher = "Extra publisher"\ntrusted = false\nexpected_packs = []\n`,
    );
    await expect(
      checkOutputs({ sourcesPath: pathToFileURL(patched), outDir }),
    ).rejects.toThrow(/catalog\.json is out of date/);
  });

  it("fails cleanly on malformed catalog.json (no stack-trace leak)", async () => {
    const { src, outDir } = await goodOutput();
    const copy = await copyOut(outDir);
    await writeFile(fileURLToPath(new URL("catalog.json", copy)), "definitely not json");
    await expect(checkOutputs({ sourcesPath: src.sourcesPath, outDir: copy })).rejects.toThrow(
      /catalog\.json: invalid JSON/,
    );
  });
});

// Craft a catalog.json directly to exercise the reconstruction validators.
function jsonPack(
  name: string,
  opts: {
    registry?: string;
    tier?: string;
    publisher?: string;
    releases?: Array<{ version: string; commit?: string; hash?: string }>;
  } = {},
) {
  const registry = opts.registry ?? "s";
  const releases = (opts.releases ?? [{ version: "1.0" }]).map((r) => ({
    version: r.version,
    ref: `v${r.version}`,
    commit: r.commit ?? COMMIT_A,
    hash: r.hash ?? HASH_0,
    description: "d",
    withdrawn: false,
  }));
  return {
    pack_key: `${registry}--${name.replaceAll("/", "--")}`,
    registry,
    name,
    tier: opts.tier ?? "community",
    publisher: opts.publisher ?? "Test publisher",
    description: `${name} pack`,
    source: `https://example.com/${name}`,
    source_kind: "git",
    search_text: "x",
    og_image: "/og/x.svg",
    releases,
  };
}

async function writeCatalog(packs: unknown[], schema: unknown = 1) {
  const dir = await tmp();
  const body = `${JSON.stringify({ schema, source_count: 1, pack_count: packs.length, featured_pack_keys: [], sources: [], og_image: "/og/registry.svg", packs }, null, 2)}\n`;
  const file = new URL("catalog.json", pathToFileURL(`${dir}/`));
  await writeFile(fileURLToPath(file), body);
  return file;
}

describe("catalog reconstruction validators (readCatalogJson)", () => {
  it("rejects duplicate packs", async () => {
    const file = await writeCatalog([jsonPack("a"), jsonPack("a")]);
    await expect(readCatalogJson(file)).rejects.toThrow(/duplicate pack/);
  });

  it("rejects an invalid pack name", async () => {
    const file = await writeCatalog([jsonPack("Bad Name")]);
    await expect(readCatalogJson(file)).rejects.toThrow(/invalid pack name/);
  });

  it("rejects a release with a bad commit", async () => {
    const file = await writeCatalog([jsonPack("a", { releases: [{ version: "1.0", commit: "nothex" }] })]);
    await expect(readCatalogJson(file)).rejects.toThrow(/commit/);
  });

  // A committed catalog may only hold bare names: scoped names belong to the publish lane, and
  // a scoped name here would mean `bun run generate` could never reproduce the artifact.
  it("rejects a scoped pack name", async () => {
    const file = await writeCatalog([jsonPack("wespd/cacc-twin-team")]);
    await expect(readCatalogJson(file)).rejects.toThrow(/invalid pack name/);
  });

  it("rejects a pack name longer than 64 characters", async () => {
    const file = await writeCatalog([jsonPack("a".repeat(65))]);
    await expect(readCatalogJson(file)).rejects.toThrow(/invalid pack name/);
  });

  it("accepts a bare pack name of exactly 64 characters", async () => {
    const file = await writeCatalog([jsonPack("a".repeat(64))]);
    expect((await readCatalogJson(file)).packs.map((p) => p.name)).toEqual(["a".repeat(64)]);
  });

  // Fatal on this lane, unlike ingest's skip-and-warn: a committed catalog.json naming a pack
  // `registry` is an artifact whose next `bun run generate` overwrites the site og card, and the
  // offline check is the last gate before it is blessed.
  it("rejects a pack name that squats the reserved site og filename", async () => {
    const file = await writeCatalog([jsonPack("registry")]);
    await expect(readCatalogJson(file)).rejects.toThrow(
      /pack name "registry" is reserved; its og card og\/registry\.svg/,
    );
  });

  it("rejects packs that share a pack_key across sources (distinct og filenames)", async () => {
    const file = await writeCatalog([
      jsonPack("b", { registry: "x--a" }),
      jsonPack("a--b", { registry: "x" }),
    ]);
    await expect(readCatalogJson(file)).rejects.toThrow(/pack_key/);
  });

  it("rejects a non-number schema", async () => {
    const file = await writeCatalog([jsonPack("a")], "1");
    await expect(readCatalogJson(file)).rejects.toThrow(/schema must be a number/);
  });
});

describe("checkOutputs structural validation", () => {
  async function sourcesFor(...names: string[]) {
    const dir = await tmp();
    const file = join(dir, "sources.toml");
    const blocks = names
      .map(
        (n) =>
          `[[source]]\nname = "${n}"\nurl = "https://example.com/${n}.toml"\npublisher = "Test publisher"\ntrusted = false\nexpected_packs = ["alpha", "beta"]\n`,
      )
      .join("\n");
    await writeFile(file, `schema = 1\nfeatured_pack_keys = []\n\n${blocks}`);
    return pathToFileURL(file);
  }

  it("rejects a pack referencing an undeclared source", async () => {
    const catalog = await writeCatalog([jsonPack("a", { registry: "ghost" })]);
    const sourcesPath = await sourcesFor("s");
    const outDir = new URL("./", catalog);
    await expect(checkOutputs({ sourcesPath, outDir })).rejects.toThrow(/not declared in sources\.toml/);
  });

  it("rejects packs that are not in canonical order", async () => {
    const catalog = await writeCatalog([jsonPack("beta"), jsonPack("alpha")]);
    const sourcesPath = await sourcesFor("s");
    const outDir = new URL("./", catalog);
    await expect(checkOutputs({ sourcesPath, outDir })).rejects.toThrow(/not in canonical order/);
  });

  it("rejects a committed catalog with zero packs (a wiped-but-consistent tree)", async () => {
    const catalog = await writeCatalog([]);
    const sourcesPath = await sourcesFor("s");
    const outDir = new URL("./", catalog);
    await expect(checkOutputs({ sourcesPath, outDir })).rejects.toThrow(/empty catalog/);
  });
});

// CLI contract via a real subprocess. fetch is poisoned in the child through --preload, and
// GITHUB_STEP_SUMMARY is scrubbed unless a test opts in — so no test can silently reach the
// network or the host's step summary.
function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  Object.assign(env, extraEnv);
  const proc = Bun.spawnSync([process.execPath, "--preload", POISON, SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("CLI contract", () => {
  it("exits 1 on an unknown argument", () => {
    const { code, stderr } = runCli(["--nope"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown argument");
  });

  it("generates to --out-dir with warnings and still exits 0", async () => {
    const src = await writeUpstream(
      "cli",
      catalogToml(packBlock("alpha", [releaseBlock("1.0")]), packBlock("BAD NAME", [releaseBlock("1.0")])),
    );
    const out = await tmp();
    const { code, stdout, stderr } = runCli([
      "--sources",
      fileURLToPath(src.sourcesPath),
      "--out-dir",
      out,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("wrote 1 pack(s)");
    expect(stderr).toContain("warning:");
    expect(await Bun.file(join(out, "catalog.json")).exists()).toBe(true);
  });

  it("exits 1 under --strict when there are warnings, but still writes the outputs", async () => {
    const src = await writeUpstream(
      "cli-strict",
      catalogToml(packBlock("alpha", [releaseBlock("1.0")]), packBlock("BAD NAME", [releaseBlock("1.0")])),
    );
    const out = await tmp();
    const { code, stderr } = runCli([
      "--strict",
      "--sources",
      fileURLToPath(src.sourcesPath),
      "--out-dir",
      out,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("ingest warning(s) with --strict");
    expect(await Bun.file(join(out, "catalog.json")).exists()).toBe(true);
  });

  it("exits 0 under --strict when there are no warnings", async () => {
    const src = await writeUpstream("cli-clean", catalogToml(packBlock("alpha", [releaseBlock("1.0")])));
    const { code } = runCli([
      "--strict",
      "--sources",
      fileURLToPath(src.sourcesPath),
      "--out-dir",
      await tmp(),
    ]);
    expect(code).toBe(0);
  });

  it("exits 1 when --sources points at a missing file", () => {
    const { code, stderr } = runCli(["--sources", join(REPO_ROOT, "does-not-exist.toml"), "--out-dir", "/tmp"]);
    expect(code).toBe(1);
    expect(stderr).toContain("generate-registry:");
  });

  it("appends warnings to GITHUB_STEP_SUMMARY when set", async () => {
    const src = await writeUpstream(
      "cli-summary",
      catalogToml(packBlock("alpha", [releaseBlock("1.0")]), packBlock("BAD NAME", [releaseBlock("1.0")])),
    );
    const summary = join(await tmp(), "summary.md");
    const { code } = runCli(
      ["--sources", fileURLToPath(src.sourcesPath), "--out-dir", await tmp()],
      { GITHUB_STEP_SUMMARY: summary },
    );
    expect(code).toBe(0);
    expect(await Bun.file(summary).text()).toContain("Registry ingest warnings");
  });

  it("produces byte-identical output on repeated runs", async () => {
    const src = await writeUpstream(
      "cli-det",
      catalogToml(packBlock("alpha", [releaseBlock("1.0")]), packBlock("beta", [releaseBlock("2.0")])),
    );
    const a = await tmp();
    const b = await tmp();
    runCli(["--sources", fileURLToPath(src.sourcesPath), "--out-dir", a]);
    runCli(["--sources", fileURLToPath(src.sourcesPath), "--out-dir", b]);
    expect(await Bun.file(join(a, "catalog.json")).text()).toBe(
      await Bun.file(join(b, "catalog.json")).text(),
    );
    expect(await Bun.file(join(a, "registry.toml")).text()).toBe(
      await Bun.file(join(b, "registry.toml")).text(),
    );
  });

  it("rejects a following flag being swallowed as a value (--out-dir --check)", async () => {
    const src = await writeUpstream("cli-swallow", catalogToml(packBlock("alpha", [releaseBlock("1.0")])));
    const { code, stderr } = runCli(["--sources", fileURLToPath(src.sourcesPath), "--out-dir", "--check"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--out-dir requires a value");
  });

  it("accepts the --flag=value form", async () => {
    const src = await writeUpstream("cli-eq", catalogToml(packBlock("alpha", [releaseBlock("1.0")])));
    const out = await tmp();
    const { code } = runCli([`--sources=${fileURLToPath(src.sourcesPath)}`, `--out-dir=${out}`]);
    expect(code).toBe(0);
    expect(await Bun.file(join(out, "catalog.json")).exists()).toBe(true);
  });

  it("--check exits 0 on freshly generated output and 1 after a mutation", async () => {
    const src = await writeUpstream("cli-check", catalogToml(packBlock("alpha", [releaseBlock("1.0")])));
    const out = await tmp();
    const sources = fileURLToPath(src.sourcesPath);
    expect(runCli(["--sources", sources, "--out-dir", out]).code).toBe(0);

    const pass = runCli(["--check", "--sources", sources, "--out-dir", out]);
    expect(pass.code).toBe(0);
    expect(pass.stdout).toContain("aggregate registry outputs are current");

    await writeFile(join(out, "catalog.json"), `${await Bun.file(join(out, "catalog.json")).text()} `);
    const fail = runCli(["--check", "--sources", sources, "--out-dir", out]);
    expect(fail.code).toBe(1);
    expect(fail.stderr).toMatch(/catalog\.json is out of date/);
  });
});
