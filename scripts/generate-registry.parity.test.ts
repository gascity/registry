import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  aggregateSources,
  readCatalogJson,
  readSources,
  renderCatalogJson,
  renderOgFiles,
  renderRegistryToml,
} from "./generate-registry.lib.ts";

// Byte-safety anchor for the P3.3 refactor. Runs the FULL generation pipeline
// (readSources -> aggregateSources -> render*) entirely offline: `fetch` is stubbed to
// serve the committed public/registry.toml for the upstream source URL and each pack's
// embedded readme back to its own URL (404 for everything else). The re-rendered output
// must byte-match the committed public/ artifacts. Because it exercises ingest +
// enrichment + rendering — not just the render half that `generate:check` covers — this is
// what proves the extraction/parametrization never changed a single output byte.

const publicDir = new URL("../public/", import.meta.url);
const registryPath = new URL("registry.toml", publicDir);
const catalogPath = new URL("catalog.json", publicDir);
const ogDir = new URL("og/", publicDir);

type CommittedCatalog = {
  sources: Array<{ url: string }>;
  packs: Array<{ readme?: { url: string; content: string } }>;
};

let committedRegistry = "";
let committedCatalog = "";
let renderedRegistry = "";
let renderedCatalog = "";
let renderedOg: Array<{ name: string; content: string }> = [];
let fetchCount = 0;
let gitBefore = "";

function gitStatus() {
  const proc = Bun.spawnSync(["git", "status", "--porcelain", "public/", "sources.toml"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdout: "pipe",
  });
  return proc.stdout.toString().trim();
}

beforeAll(async () => {
  gitBefore = gitStatus();
  committedRegistry = await Bun.file(registryPath).text();
  committedCatalog = await Bun.file(catalogPath).text();
  const parsed = JSON.parse(committedCatalog) as CommittedCatalog;

  // Serve each source URL with a registry.toml rendered from ONLY that source's packs (for a
  // single source this equals the merged public/registry.toml). Serving the merged doc to every
  // source would turn every extra source's packs into cross-source collisions once >1 source.
  const { packs: committedPacks } = await readCatalogJson(catalogPath);
  const packsBySource = new Map<string, typeof committedPacks>();
  for (const pack of committedPacks) {
    const list = packsBySource.get(pack.registry) ?? [];
    list.push(pack);
    packsBySource.set(pack.registry, list);
  }

  const bodyByUrl = new Map<string, string>();
  for (const source of parsed.sources) {
    bodyByUrl.set(source.url, renderRegistryToml(packsBySource.get(source.name) ?? []));
  }
  for (const pack of parsed.packs) {
    if (pack.readme) bodyByUrl.set(pack.readme.url, pack.readme.content);
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    fetchCount += 1;
    const url = typeof input === "string" ? input : String((input as { url?: unknown }).url);
    const body = bodyByUrl.get(url);
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body, { status: 200 });
  }) as typeof fetch;

  try {
    const sources = await readSources();
    const { packs, sourceSummaries } = await aggregateSources(sources);
    renderedRegistry = renderRegistryToml(packs);
    renderedCatalog = renderCatalogJson(packs, sourceSummaries);
    renderedOg = renderOgFiles(packs, sourceSummaries).map((file) => ({
      name: file.filename,
      content: file.content,
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

describe("generate-registry full-pipeline parity (offline)", () => {
  it("actually hit the stubbed fetch (proves the pipeline ran, no live network)", () => {
    expect(fetchCount).toBeGreaterThan(0);
  });

  it("re-renders public/registry.toml byte-for-byte", () => {
    expect(renderedRegistry).toBe(committedRegistry);
  });

  it("re-renders public/catalog.json byte-for-byte", () => {
    expect(renderedCatalog).toBe(committedCatalog);
  });

  it("re-renders every og/*.svg byte-for-byte with no missing or extra files", async () => {
    const committedNames = (await readdir(ogDir)).filter((n) => n.endsWith(".svg")).sort();
    const renderedNames = renderedOg.map((file) => file.name).sort();
    expect(renderedNames).toEqual(committedNames);

    for (const file of renderedOg) {
      expect(file.content).toBe(await Bun.file(new URL(file.name, ogDir)).text());
    }
  });
});

afterAll(() => {
  // Guard: the parity run must not change the committed tree (relative to however it started).
  expect(gitStatus()).toBe(gitBefore);
});
