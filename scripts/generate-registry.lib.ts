import { readdir } from "node:fs/promises";
import { parse } from "smol-toml";
import {
  compareByCodepoint,
  PACK_TIERS,
  tierForTrusted,
  UNKNOWN_PUBLISHER,
  type PackTier,
} from "../shared/catalogPolicy";

type SourceConfig = {
  schema?: unknown;
  featured_pack_keys?: unknown;
  source?: unknown;
};

type RegistrySource = {
  name: string;
  url: string;
  publisher: string;
  trusted: boolean;
  expectedPacks: string[];
};

export type RegistryConfig = {
  sources: RegistrySource[];
  featuredPackKeys: string[];
};

type RawCatalog = {
  schema?: unknown;
  pack?: unknown;
};

type RawPack = {
  name?: unknown;
  description?: unknown;
  source?: unknown;
  source_kind?: unknown;
  release?: unknown;
};

type RawRelease = {
  version?: unknown;
  ref?: unknown;
  commit?: unknown;
  hash?: unknown;
  description?: unknown;
  withdrawn?: unknown;
  withdrawn_reason?: unknown;
};

type CatalogRelease = {
  version: string;
  ref: string;
  commit: string;
  hash: string;
  description: string;
  withdrawn: boolean;
  withdrawnReason?: string;
};

type CatalogReadme = {
  url: string;
  content: string;
};

type CatalogPack = {
  packKey?: string;
  registry: string;
  name: string;
  tier: PackTier;
  publisher: string;
  description: string;
  source: string;
  sourceKind: string;
  readme?: CatalogReadme;
  ogImage?: string;
  releases: CatalogRelease[];
};

type IngestedPack = Omit<CatalogPack, "tier" | "publisher">;

// A recoverable ingest problem: a bad pack/release was skipped, or a duplicate/collision
// was resolved. Source-level failures (fetch/parse/schema) are fatal and throw instead.
export type IngestWarning = {
  scope: "pack" | "release" | "collision";
  source: string;
  pack?: string;
  release?: string;
  reason: string;
};

export type SourceSummary = { name: string; url: string; packCount: number };

export type AggregateResult = {
  packs: CatalogPack[];
  sourceSummaries: SourceSummary[];
  warnings: IngestWarning[];
};

type RawJsonCatalog = { schema?: unknown; featured_pack_keys?: unknown; packs?: unknown };
type RawJsonPack = {
  pack_key?: unknown;
  registry?: unknown;
  name?: unknown;
  tier?: unknown;
  publisher?: unknown;
  description?: unknown;
  source?: unknown;
  source_kind?: unknown;
  readme?: unknown;
  releases?: unknown;
};

const sourceNamePattern = /^[a-z0-9][a-z0-9-]*$/;
// Ingested packs own the BARE half of the namespace; `owner/pack` is reserved for direct
// publishes (server/publish.ts, whose grammar is bare-OR-scoped for exactly that reason).
// Deliberately still permits `--`, because names already in public/registry.toml must keep
// round-tripping through reconstructPack.
const ingestedPackNamePattern = /^[a-z0-9][a-z0-9-]*$/;
// Mirrors ValidatePackName in internal/packregistry/catalog.go: `gc` rejects a segment over
// 64 characters and ValidateCatalog aborts on the FIRST bad name, so one over-long name here
// hides every pack in the catalog from every client.
const maxPackNameSegment = 64;
const releaseVersionPattern = /^[0-9]+\.[0-9]+(\.[0-9]+)?$/;
const commitPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^sha256:[0-9a-f]{64}$/;

// The site-wide social card, and the ONE og/ file renderOgFiles emits that is not derived from a
// pack name. It is written first, so a pack whose og filename equals it silently replaced it: the
// site card became a pack card, and every pack that falls back to `/og/registry.svg` (which is
// every direct publish — server/aggregate.ts) rendered the wrong image. `bun run generate:check`
// could not catch it, because the resulting tree is internally self-consistent.
const siteOgFilename = "registry.svg";
// Enumerated ONCE, here. renderOgFiles emits this set, and both name lanes (ingest and the
// committed-artifact reconstruction) refuse to produce a filename in it. `registry.toml` and
// `catalog.json` need no entry: they are written to outDir, not to og/, so no `<name>.svg` can
// ever collide with them. A future non-pack og file belongs in this set, and nowhere else.
const reservedOgFilenames: ReadonlySet<string> = new Set([siteOgFilename]);

// Exported so a test can pin the enumeration against what renderOgFiles actually emits — a new
// reserved file added to the renderer but not to the set would otherwise be squattable again.
export function reservedOgFilenameList() {
  return [...reservedOgFilenames];
}

// Rejects a pack name that would overwrite a reserved og file. Both call sites are deliberate and
// independently load-bearing: normalizePack (ingest — demoted to skip-and-warn, so one squatting
// upstream entry cannot freeze the hourly refresh of every other pack) and reconstructPack (the
// offline check — fatal, because a committed artifact must never contain one).
function assertUnreservedOgFilename(label: string, name: string) {
  const filename = packOgFilename(name);
  if (reservedOgFilenames.has(filename)) {
    throw new Error(
      `${label}: pack name ${JSON.stringify(name)} is reserved; its og card og/${filename} is the registry's own`,
    );
  }
}

const root = new URL("../", import.meta.url);
export const defaultSourcesPath = new URL("sources.toml", root);
export const defaultOutDir = new URL("public/", root);

export function outputPaths(outDir: URL) {
  return {
    registry: new URL("registry.toml", outDir),
    catalog: new URL("catalog.json", outDir),
    ogDir: new URL("og/", outDir),
  };
}

const readmeCandidates = ["README.md", "README.mdx", "readme.md", "SKILL.md"];
const maxReadmeChars = 80_000;

export async function readRegistryConfig(path: URL = defaultSourcesPath): Promise<RegistryConfig> {
  const raw = parse(await Bun.file(path).text()) as SourceConfig;
  const schema = requireSchema(raw.schema, "sources.toml");
  if (schema !== 1) {
    throw new Error(`unsupported sources.toml schema ${schema}`);
  }

  const rawSources = Array.isArray(raw.source) ? raw.source : [];
  if (rawSources.length === 0) {
    throw new Error("sources.toml must include at least one [[source]]");
  }

  const seen = new Set<string>();
  const expectedKeyOwners = new Map<string, string>();
  const sources = rawSources.map((rawSource, index): RegistrySource => {
    const record = rawSource as {
      name?: unknown;
      url?: unknown;
      publisher?: unknown;
      trusted?: unknown;
      expected_packs?: unknown;
    };
    const name = requireString(record.name, `source[${index}].name`);
    const url = requireString(record.url, `${name}.url`);
    const publisher = requireString(record.publisher, `${name}.publisher`).trim();

    if (!sourceNamePattern.test(name)) {
      throw new Error(`invalid registry source name ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate registry source name ${JSON.stringify(name)}`);
    }
    seen.add(name);
    validateSourceUrl(name, url);
    if (publisher === UNKNOWN_PUBLISHER) {
      throw new Error(`${name}.publisher must identify the configured source`);
    }

    if (record.trusted !== undefined && typeof record.trusted !== "boolean") {
      throw new Error(`${name}.trusted must be a boolean`);
    }
    if (!Array.isArray(record.expected_packs)) {
      throw new Error(`${name}.expected_packs must be an array`);
    }
    const expectedPacks: string[] = [];
    const seenPacks = new Set<string>();
    for (const [packIndex, value] of record.expected_packs.entries()) {
      const packName = requireString(value, `${name}.expected_packs[${packIndex}]`);
      if (!ingestedPackNamePattern.test(packName) || packName.length > maxPackNameSegment) {
        throw new Error(`${name}: invalid expected pack name ${JSON.stringify(packName)}`);
      }
      assertUnreservedOgFilename(`${name}.expected_packs`, packName);
      if (seenPacks.has(packName)) {
        throw new Error(`${name}: duplicate expected pack ${JSON.stringify(packName)}`);
      }
      seenPacks.add(packName);
      expectedPacks.push(packName);

      const key = `${name}--${packName}`;
      const previous = expectedKeyOwners.get(key);
      if (previous) {
        throw new Error(
          `sources.toml: expected packs ${JSON.stringify(previous)} and ${JSON.stringify(
            `${name}/${packName}`,
          )} share pack_key ${key}`,
        );
      }
      expectedKeyOwners.set(key, `${name}/${packName}`);
    }

    return {
      name,
      url,
      publisher,
      trusted: record.trusted === true,
      expectedPacks,
    };
  });

  const rawFeatured = raw.featured_pack_keys ?? [];
  if (!Array.isArray(rawFeatured)) {
    throw new Error("featured_pack_keys must be an array");
  }
  const featuredPackKeys: string[] = [];
  const seenFeatured = new Set<string>();
  for (const [index, value] of rawFeatured.entries()) {
    const key = requireString(value, `featured_pack_keys[${index}]`);
    if (seenFeatured.has(key)) {
      throw new Error(`duplicate featured pack_key ${JSON.stringify(key)}`);
    }
    seenFeatured.add(key);
    featuredPackKeys.push(key);
  }
  if (featuredPackKeys.length > 4) {
    throw new Error("featured_pack_keys may contain at most 4 entries");
  }
  for (const key of featuredPackKeys) {
    if (!expectedKeyOwners.has(key)) {
      throw new Error(`featured pack_key ${JSON.stringify(key)} is not declared in sources.toml`);
    }
  }

  return { sources, featuredPackKeys };
}

export async function readSources(path: URL = defaultSourcesPath) {
  return (await readRegistryConfig(path)).sources;
}

export async function aggregateSources(
  sources: RegistrySource[],
  options: { onWarning?: (warning: IngestWarning) => void } = {},
): Promise<AggregateResult> {
  const warnings: IngestWarning[] = [];
  const emit = (warning: IngestWarning) => {
    warnings.push(warning);
    options.onWarning?.(warning);
  };

  const packs: CatalogPack[] = [];
  const seenPacks = new Map<string, string>();
  const sourceSummaries: SourceSummary[] = [];

  // Sources are processed sequentially in sources.toml order. That order is load-bearing:
  // on a cross-source name collision the FIRST source wins, and warnings are emitted in a
  // deterministic order. Do not parallelize this loop.
  for (const source of sources) {
    // Source-level failures (fetch, TOML parse, schema) throw and abort the whole run —
    // we never silently drop a source's entire contribution.
    const text = await readSourceText(source);
    const { packs: normalizedPacks, declaredCount } = normalizeCatalog(source.name, text, emit);

    // Fail-safe: a source that declared packs but yielded none valid signals systematic
    // format drift, not one bad pack. Refuse rather than silently shrink the catalog.
    if (declaredCount > 0 && normalizedPacks.length === 0) {
      throw new Error(
        `${source.name}: all ${declaredCount} declared pack(s) failed validation; refusing to drop the entire source`,
      );
    }

    if (Array.isArray(source.expectedPacks)) {
      const expected = new Set(source.expectedPacks);
      for (const pack of normalizedPacks) {
        if (!expected.has(pack.name)) {
          throw new Error(
            `${source.name}: unexpected pack ${JSON.stringify(
              pack.name,
            )} is not declared in expected_packs`,
          );
        }
      }
      const actual = new Set(normalizedPacks.map((pack) => pack.name));
      for (const expectedName of source.expectedPacks) {
        if (!actual.has(expectedName)) {
          throw new Error(`${source.name}: expected pack ${JSON.stringify(expectedName)} is absent`);
        }
      }
    }

    const sourcePacks = normalizedPacks.map((pack) => ({
      ...pack,
      tier: tierForTrusted(source.trusted),
      publisher: source.publisher,
    }));

    let contributed = 0;
    for (const pack of sourcePacks) {
      const previous = seenPacks.get(pack.name);
      if (previous) {
        emit({
          scope: "collision",
          source: source.name,
          pack: pack.name,
          reason: `already provided by source ${previous}; first source in sources.toml order wins`,
        });
        continue;
      }
      seenPacks.set(pack.name, source.name);
      packs.push(pack);
      contributed += 1;
    }
    sourceSummaries.push({ name: source.name, url: source.url, packCount: contributed });
  }

  // Fail-safe: never write an empty catalog (e.g. every source drifted at once).
  if (packs.length === 0) {
    throw new Error("no packs survived aggregation; refusing to write an empty catalog");
  }

  packs.sort((a, b) => compareByCodepoint(a.name, b.name));

  // Distinct pack names can still collide on pack_key (`${registry}--${name/→--}`), which drives
  // reviews and ownership — source `x--a` + pack `b` and source `x` + pack `a--b` both flatten to
  // `x--a--b`. Keep the first in canonical order, skip later colliders with a warning.
  //
  // There is no pack-vs-pack og-filename check here on purpose. Ingested names are bare, so
  // `packOgFilename` is the name plus a suffix and therefore injective, and equal names are already
  // rejected by the cross-source dedupe above — so such a branch could never fire. A future
  // scoped-ingest lane will need one, and will need to decide then whether to reject at ingest or
  // skip fail-soft. The pack-vs-RESERVED case is the reachable one, and it is handled per-pack in
  // normalizePack (assertUnreservedOgFilename) so it warns and skips like any other bad pack.
  const keyOwners = new Map<string, string>();
  const unique: CatalogPack[] = [];
  for (const pack of packs) {
    const collidesWith = keyOwners.get(packKeyFor(pack));
    if (collidesWith) {
      emit({
        scope: "collision",
        source: pack.registry,
        pack: pack.name,
        reason: `pack_key collides with ${JSON.stringify(collidesWith)}; skipping`,
      });
      continue;
    }
    keyOwners.set(packKeyFor(pack), pack.name);
    unique.push(pack);
  }

  return {
    packs: await Promise.all(unique.map(enrichPackForWebsite)),
    sourceSummaries,
    warnings,
  };
}

async function readSourceText(source: RegistrySource) {
  const parsed = new URL(source.url);
  if (parsed.protocol === "file:") {
    return Bun.file(parsed).text();
  }

  const response = await fetch(source.url, {
    headers: { Accept: "text/plain" },
  });
  if (!response.ok) {
    throw new Error(`${source.name}: registry fetch failed with HTTP ${response.status}`);
  }
  return response.text();
}

async function enrichPackForWebsite(pack: CatalogPack): Promise<CatalogPack> {
  return {
    ...pack,
    readme: await fetchReadme(pack),
    ogImage: ogImagePath(pack.name),
  };
}

async function fetchReadme(pack: CatalogPack): Promise<CatalogReadme | undefined> {
  for (const url of inferReadmeUrls(pack.source)) {
    const readme = await fetchReadmeCandidate(url);
    if (readme) return readme;
  }
  return undefined;
}

async function fetchReadmeCandidate(url: string): Promise<CatalogReadme | undefined> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "text/markdown, text/plain" },
    });
    if (!response.ok) return undefined;

    const content = (await response.text()).trim();
    if (!content) return undefined;

    // Reserve room for the marker so the truncated output stays <= maxReadmeChars and
    // re-ingesting it is a no-op (idempotent) — otherwise the parity replay re-truncates.
    const truncationMarker = "\n\n_Readme truncated by registry aggregator._";
    return {
      url,
      content:
        content.length > maxReadmeChars
          ? `${content.slice(0, maxReadmeChars - truncationMarker.length).trimEnd()}${truncationMarker}`
          : content,
    };
  } catch {
    return undefined;
  }
}

function inferReadmeUrls(source: string) {
  const parsed = new URL(source);
  if (parsed.hostname !== "github.com") return [];

  let segments: string[];
  try {
    segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    // Malformed percent-escapes (e.g. `%zz`) pass `new URL()` but throw in
    // decodeURIComponent. Enrichment must never abort the whole run over one bad source.
    return [];
  }
  const [owner, rawRepo, kind, ref, ...rest] = segments;
  if (!owner || !rawRepo) return [];

  const repo = rawRepo.replace(/\.git$/, "");
  const locations: Array<{ ref: string; path: string[] }> = [];
  if (kind === "tree" && ref) {
    locations.push({ ref, path: rest });
  } else if (kind === "blob" && ref) {
    locations.push({ ref, path: rest.slice(0, -1) });
  } else if (!kind) {
    locations.push({ ref: "main", path: [] }, { ref: "master", path: [] });
  }

  return locations.flatMap((location) =>
    readmeCandidates.map((candidate) =>
      githubRawUrl(owner, repo, location.ref, [...location.path, candidate]),
    ),
  );
}

function githubRawUrl(owner: string, repo: string, ref: string, pathParts: string[]) {
  const path = pathParts.map((part) => encodeURIComponent(part)).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/${encodeURIComponent(ref)}/${path}`;
}

function normalizeCatalog(
  registry: string,
  text: string,
  emit: (warning: IngestWarning) => void,
): { packs: IngestedPack[]; declaredCount: number } {
  // TOML parse failure and schema mismatch are source-level → fatal (throw).
  const raw = parse(text) as RawCatalog;
  const schema = requireSchema(raw.schema, `${registry}: registry catalog`);
  if (schema !== 1) {
    throw new Error(`${registry}: unsupported registry catalog schema ${schema}`);
  }

  // A single-table `[pack]` (object) instead of `[[pack]]` (array-of-tables) is a classic
  // upstream typo. Coercing it to `[]` would make declaredCount 0 and silently vanish the
  // source past the wipe guard, so treat a present-but-non-array `pack` as source-level fatal.
  if (raw.pack !== undefined && !Array.isArray(raw.pack)) {
    throw new Error(`${registry}: [pack] must be an array of tables — use [[pack]]`);
  }
  const rawPacks = Array.isArray(raw.pack) ? raw.pack : [];
  // Per-pack failures are recoverable: skip the bad pack, keep the rest.
  const normalized: IngestedPack[] = [];
  for (const rawPack of rawPacks) {
    try {
      normalized.push(normalizePack(registry, rawPack as RawPack, emit));
    } catch (error) {
      emit({ scope: "pack", source: registry, reason: describeError(error) });
    }
  }

  const packs = dedupeKeepingConsistent(
    normalized,
    (pack) => pack.name,
    (name, kept, count) =>
      emit({
        scope: "collision",
        source: registry,
        pack: name,
        reason: kept
          ? `pack ${JSON.stringify(name)} declared ${count}x within source; keeping first`
          : `pack ${JSON.stringify(name)} declared ${count}x within source with conflicting data; skipping all copies`,
      }),
  );

  return { packs, declaredCount: rawPacks.length };
}

function normalizePack(
  registry: string,
  raw: RawPack,
  emit: (warning: IngestWarning) => void,
): IngestedPack {
  const name = requireString(raw.name, `${registry}.pack.name`);
  // A scoped upstream name would not merely squat a publish claim, it would WIN it:
  // mergeApprovedEntry refuses an approved publish that collides with a base pack, so the served
  // pack would keep the name while pointing at the upstream source. It gets its own greppable
  // reason because stderr and GITHUB_STEP_SUMMARY are the only channels watching the hourly
  // refresh. Either throw is demoted to a per-pack skip-and-warn by normalizeCatalog — one bad
  // entry must not freeze the refresh of every other pack — and a source whose packs ALL fail
  // still escalates to fatal via the wipe guard in aggregateSources.
  if (!ingestedPackNamePattern.test(name) || name.length > maxPackNameSegment) {
    throw new Error(
      name.includes("/")
        ? `${registry}: scoped pack names are not ingestable; ${JSON.stringify(name)} belongs to the publish namespace`
        : `${registry}: invalid pack name ${JSON.stringify(name)}`,
    );
  }
  // Reachable on a name the grammar above ACCEPTS: `registry` is a perfectly legal bare name.
  assertUnreservedOgFilename(registry, name);

  const sourceKind = requireString(raw.source_kind, `${registry}.${name}.source_kind`);
  if (sourceKind !== "git") {
    throw new Error(`${registry}.${name}: unsupported source_kind ${JSON.stringify(sourceKind)}`);
  }

  const source = requireString(raw.source, `${registry}.${name}.source`);
  // Validate here so a non-URL source is skipped as a bad pack rather than throwing
  // uncaught later in enrichment's `new URL(pack.source)` and aborting the whole run.
  assertParseableUrl(source, `${registry}.${name}.source`);

  // Same `[[pack.release]]`-vs-`[pack.release]` typo trap as the pack level. Throwing here is
  // caught by normalizeCatalog and demoted to a skip-and-warn for this one pack.
  if (raw.release !== undefined && !Array.isArray(raw.release)) {
    throw new Error(`${registry}.${name}: [pack.release] must be an array of tables — use [[pack.release]]`);
  }
  const rawReleases = Array.isArray(raw.release) ? raw.release : [];
  const normalizedReleases: CatalogRelease[] = [];
  for (const rawRelease of rawReleases) {
    try {
      normalizedReleases.push(normalizeRelease(registry, name, rawRelease as RawRelease));
    } catch (error) {
      emit({ scope: "release", source: registry, pack: name, reason: describeError(error) });
    }
  }

  const releases = dedupeKeepingConsistent(
    normalizedReleases,
    (release) => release.version,
    (version, kept, count) =>
      emit({
        scope: "release",
        source: registry,
        pack: name,
        release: version,
        reason: kept
          ? `release ${version} declared ${count}x; keeping first`
          : `release ${version} declared ${count}x with conflicting data; skipping all copies`,
      }),
  );

  // Only skip the whole pack when it declared releases and every one was invalid. A pack
  // that declared no releases, or whose releases are all withdrawn, is still valid.
  if (rawReleases.length > 0 && releases.length === 0) {
    throw new Error(`${registry}.${name}: all ${rawReleases.length} declared release(s) were invalid`);
  }

  return {
    registry,
    name,
    description: requireString(raw.description, `${registry}.${name}.description`),
    source,
    sourceKind,
    releases,
  };
}

// Group items by key, preserving first-seen order. A key seen once passes through. A key
// seen more than once with byte-identical items keeps the first (kept=true); with differing
// items, all copies are dropped (kept=false) — we never guess which conflicting copy is real.
function dedupeKeepingConsistent<T>(
  items: T[],
  keyOf: (item: T) => string,
  onDuplicate: (key: string, kept: boolean, count: number) => void,
): T[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
      order.push(key);
    }
  }

  const result: T[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const first = JSON.stringify(group[0]);
    const allIdentical = group.every((item) => JSON.stringify(item) === first);
    onDuplicate(key, allIdentical, group.length);
    if (allIdentical) result.push(group[0]);
  }
  return result;
}

function normalizeRelease(registry: string, packName: string, raw: RawRelease): CatalogRelease {
  const version = requireString(raw.version, `${registry}.${packName}.release.version`);
  const label = `${registry}.${packName}@${version}`;
  if (!releaseVersionPattern.test(version)) {
    throw new Error(`${label}: version must be semver major.minor[.patch]`);
  }

  const commit = requireString(raw.commit, `${label}.commit`);
  if (!commitPattern.test(commit)) {
    throw new Error(`${label}: commit must be a full lowercase SHA`);
  }

  const hash = requireString(raw.hash, `${label}.hash`);
  if (!hashPattern.test(hash)) {
    throw new Error(`${label}: hash must be sha256:<64 lowercase hex>`);
  }

  if (raw.withdrawn !== undefined && typeof raw.withdrawn !== "boolean") {
    throw new Error(`${label}: withdrawn must be a boolean`);
  }
  const withdrawn = raw.withdrawn === true;

  return {
    version,
    ref: requireString(raw.ref, `${label}.ref`),
    commit,
    hash,
    description: requireString(raw.description, `${label}.description`),
    withdrawn,
    // Only carry a reason for an actually-withdrawn release. renderRegistryToml emits the
    // reason only under `withdrawn`, so keeping it otherwise would desync the two artifacts.
    withdrawnReason:
      withdrawn && typeof raw.withdrawn_reason === "string" && raw.withdrawn_reason.trim()
        ? raw.withdrawn_reason
        : undefined,
  };
}

export function renderRegistryToml(
  packs: CatalogPack[],
  featuredPackKeys: string[] = [],
) {
  const lines = [
    "schema = 1",
    `featured_pack_keys = [${featuredPackKeys.map(quote).join(", ")}]`,
    "",
  ];
  for (const pack of packs) {
    lines.push("[[pack]]");
    lines.push(`  pack_key = ${quote(packKeyFor(pack))}`);
    lines.push(`  registry = ${quote(pack.registry)}`);
    lines.push(`  name = ${quote(pack.name)}`);
    lines.push(`  tier = ${quote(pack.tier)}`);
    lines.push(`  publisher = ${quote(pack.publisher)}`);
    lines.push(`  description = ${quote(pack.description)}`);
    lines.push(`  source = ${quote(pack.source)}`);
    lines.push(`  source_kind = ${quote(pack.sourceKind)}`);
    lines.push("");

    for (const release of pack.releases) {
      lines.push("  [[pack.release]]");
      lines.push(`    version = ${quote(release.version)}`);
      lines.push(`    ref = ${quote(release.ref)}`);
      lines.push(`    commit = ${quote(release.commit)}`);
      lines.push(`    hash = ${quote(release.hash)}`);
      lines.push(`    description = ${quote(release.description)}`);
      if (release.withdrawn) {
        lines.push("    withdrawn = true");
        if (release.withdrawnReason) {
          lines.push(`    withdrawn_reason = ${quote(release.withdrawnReason)}`);
        }
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCatalogJson(
  packs: CatalogPack[],
  sources: Array<{ name: string; url: string; packCount: number }>,
  featuredPackKeys: string[] = [],
) {
  return `${JSON.stringify(
    {
      schema: 1,
      source_count: sources.length,
      pack_count: packs.length,
      featured_pack_keys: featuredPackKeys,
      sources: sources.map((source) => ({
        name: source.name,
        url: source.url,
        pack_count: source.packCount,
      })),
      og_image: "/og/registry.svg",
      packs: packs.map((pack) => ({
        pack_key: packKeyFor(pack),
        registry: pack.registry,
        name: pack.name,
        tier: pack.tier,
        publisher: pack.publisher,
        description: pack.description,
        source: pack.source,
        source_kind: pack.sourceKind,
        search_text: searchTextFor(pack),
        readme: pack.readme,
        og_image: pack.ogImage ?? ogImagePath(pack.name),
        latest: latestActiveVersion(pack),
        releases: pack.releases.map((release) => ({
          version: release.version,
          ref: release.ref,
          commit: release.commit,
          hash: release.hash,
          description: release.description,
          withdrawn: release.withdrawn,
          withdrawn_reason: release.withdrawnReason,
        })),
      })),
    },
    null,
    2,
  )}\n`;
}

export function renderOgFiles(
  packs: CatalogPack[],
  sources: Array<{ name: string; url: string; packCount: number }>,
): Array<{ filename: string; content: string }> {
  return [
    { filename: siteOgFilename, content: renderRegistryOgSvg(packs, sources) },
    ...packs.map((pack) => ({
      filename: packOgFilename(pack.name),
      content: renderPackOgSvg(pack),
    })),
  ];
}

function renderRegistryOgSvg(
  packs: CatalogPack[],
  sources: Array<{ name: string; url: string; packCount: number }>,
) {
  const releases = packs.reduce((count, pack) => count + pack.releases.length, 0);
  return renderOgSvg({
    eyebrow: "Gas City Pack Registry",
    title: "Registry",
    description: "Versioned Gas City workflow packs with immutable release hashes and import commands.",
    stats: [
      { value: String(packs.length), label: "packs" },
      { value: String(releases), label: "releases" },
      { value: String(sources.length), label: "sources" },
    ],
  });
}

function renderPackOgSvg(pack: CatalogPack) {
  const latest = latestActiveVersion(pack);
  return renderOgSvg({
    eyebrow: `${pack.registry} / ${pack.sourceKind}`,
    title: pack.name,
    description: pack.description,
    stats: [
      { value: latest ? `v${latest}` : "none", label: "latest" },
      { value: String(pack.releases.length), label: "releases" },
      {
        value: pack.releases.some((release) => release.withdrawn) ? "review" : "active",
        label: "state",
      },
    ],
  });
}

function renderOgSvg({
  eyebrow,
  title,
  description,
  stats,
}: {
  eyebrow: string;
  title: string;
  description: string;
  stats: Array<{ value: string; label: string }>;
}) {
  const titleLines = wrapText(title.toUpperCase(), 15, 2);
  const descriptionLines = wrapText(description, 72, 3);
  const statBlocks = stats
    .slice(0, 3)
    .map((stat, index) => {
      const x = 88 + index * 250;
      return `<g>
        <text x="${x}" y="508" fill="#B1C0D1" font-family="Saira, sans-serif" font-size="24">${escapeXml(
          stat.label,
        )}</text>
        <text x="${x}" y="556" fill="#D9EBFF" font-family="Syncopate, sans-serif" font-size="34" font-weight="700">${escapeXml(
          stat.value,
        )}</text>
      </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeXml(
    title,
  )}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#101A28"/>
      <stop offset="0.54" stop-color="#050912"/>
      <stop offset="1" stop-color="#03060D"/>
    </linearGradient>
    <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse">
      <path d="M 80 0 L 0 0 0 80" fill="none" stroke="#7CAADE" stroke-opacity="0.12" stroke-width="1"/>
    </pattern>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="10" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#grid)"/>
  <path d="M0 0 H1200 V190 C925 144 772 254 566 188 C348 118 176 176 0 112 Z" fill="#A9CEFF" fill-opacity="0.05"/>
  <rect x="56" y="54" width="1088" height="522" rx="18" fill="#0A1019" fill-opacity="0.78" stroke="#CED7E2" stroke-opacity="0.22"/>
  <rect x="86" y="84" width="56" height="56" rx="8" fill="#F2D995"/>
  <path d="M114 98 L132 108 V128 L114 138 L96 128 V108 Z" fill="none" stroke="#08111A" stroke-width="3" stroke-linejoin="round"/>
  <path d="M96 108 L114 118 L132 108 M114 118 V138" fill="none" stroke="#08111A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="164" y="111" fill="#F2D995" font-family="IBM Plex Mono, monospace" font-size="24" font-weight="500">${escapeXml(
    eyebrow,
  )}</text>
  ${renderSvgTextLines(titleLines, 86, 238, 76, 80, "#F2D995", "Syncopate, sans-serif", "700")}
  ${renderSvgTextLines(descriptionLines, 90, 360, 28, 38, "#E8EEF7", "Saira, sans-serif", "400")}
  <path d="M86 450 H1114" stroke="#CED7E2" stroke-opacity="0.18"/>
  ${statBlocks}
  <g filter="url(#glow)" opacity="0.95">
    <path d="M864 150 H1018 L1076 226 V356 H922 L864 280 Z" fill="none" stroke="#A9CEFF" stroke-opacity="0.7" stroke-width="4"/>
    <circle cx="924" cy="218" r="15" fill="#F2D995"/>
    <circle cx="1012" cy="302" r="15" fill="#FF8F5A"/>
    <circle cx="970" cy="258" r="12" fill="#D9EBFF"/>
  </g>
</svg>
`;
}

function renderSvgTextLines(
  lines: string[],
  x: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  fill: string,
  fontFamily: string,
  fontWeight: string,
) {
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * lineHeight}" fill="${fill}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}">${escapeXml(
          line,
        )}</text>`,
    )
    .join("");
}

function wrapText(value: string, maxChars: number, maxLines: number) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:!?]+$/g, "")}...`;
  }
  return lines;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ogImagePath(packName: string) {
  return `/og/${packOgFilename(packName)}`;
}

function packKeyFor(pack: CatalogPack) {
  return `${pack.registry}--${pack.name.replaceAll("/", "--")}`;
}

function packOgFilename(packName: string) {
  return `${packName.replaceAll("/", "--")}.svg`;
}

function searchTextFor(pack: CatalogPack) {
  return [
    pack.name,
    pack.registry,
    pack.tier,
    pack.publisher,
    pack.description,
    pack.source,
    pack.sourceKind,
    pack.readme?.content ?? "",
    ...pack.releases.map((release) => `${release.version} ${release.description}`),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export async function removeStaleOgFiles(ogDir: URL, expected: Set<string>) {
  for (const entry of await listOgFiles(ogDir)) {
    if (!expected.has(entry)) {
      await Bun.file(new URL(entry, ogDir)).delete();
    }
  }
}

export async function assertNoStaleOgFiles(ogDir: URL, expected: Set<string>) {
  for (const entry of await listOgFiles(ogDir)) {
    if (!expected.has(entry)) {
      throw new Error(`og/${entry} is stale; run bun run generate`);
    }
  }
}

async function listOgFiles(ogDir: URL) {
  try {
    return (await readdir(ogDir)).filter((entry) => entry.endsWith(".svg"));
  } catch {
    return [];
  }
}

export async function assertCurrent(path: URL, expected: string) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`${basenameOf(path)} is missing; run bun run generate`);
  }
  const actual = await file.text();
  if (actual !== expected) {
    throw new Error(`${basenameOf(path)} is out of date; run bun run generate`);
  }
}

function basenameOf(path: URL) {
  return decodeURIComponent(path.pathname.split("/").pop() ?? "");
}

function latestActiveVersion(pack: CatalogPack) {
  return pack.releases
    .filter((release) => !release.withdrawn)
    .sort((a, b) => -compareVersions(a.version, b.version))[0]?.version;
}

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function validateSourceUrl(name: string, value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "file:") {
    throw new Error(`${name}: source url must use https:// or file://`);
  }
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function requirePackTier(value: unknown, field: string): PackTier {
  if (typeof value !== "string" || !PACK_TIERS.includes(value as PackTier)) {
    throw new Error(`${field} must be "maintained" or "community"`);
  }
  return value as PackTier;
}

function quote(value: string) {
  return JSON.stringify(value);
}

function requireSchema(value: unknown, label: string) {
  // Absent schema defaults to 1 (back-compat); a present but non-number schema is a
  // corrupt/incompatible document and must fail loudly rather than silently default.
  if (value !== undefined && typeof value !== "number") {
    throw new Error(`${label} schema must be a number`);
  }
  return typeof value === "number" ? value : 1;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function assertParseableUrl(value: string, field: string) {
  try {
    new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
}

// Reconstruct the in-memory catalog from a committed catalog.json, mapping RAW fields only.
// Derived fields (pack_key, search_text, latest, og_image, counts) are deliberately dropped
// so the offline check recomputes and re-verifies them — carrying them over would make the
// round-trip circular and able to false-pass. Validation here is strict (throws): a corrupt
// cron-written artifact must fail the check, not be treated as ground truth.
export async function readCatalogJson(
  path: URL,
): Promise<{ packs: CatalogPack[]; featuredPackKeys: string[] }> {
  let raw: RawJsonCatalog;
  try {
    raw = JSON.parse(await Bun.file(path).text()) as RawJsonCatalog;
  } catch (error) {
    throw new Error(`catalog.json: invalid JSON (${describeError(error)})`);
  }

  const schema = requireSchema(raw.schema, "catalog.json");
  if (schema !== 1) {
    throw new Error(`catalog.json: unsupported schema ${schema}`);
  }

  if (!Array.isArray(raw.featured_pack_keys)) {
    throw new Error("catalog.json: featured_pack_keys must be an array");
  }
  const featuredPackKeys = raw.featured_pack_keys.map((value, index) =>
    requireString(value, `catalog.json featured_pack_keys[${index}]`),
  );
  if (featuredPackKeys.length > 4) {
    throw new Error("catalog.json: featured_pack_keys may contain at most 4 entries");
  }
  if (new Set(featuredPackKeys).size !== featuredPackKeys.length) {
    throw new Error("catalog.json: duplicate featured pack_key");
  }

  const rawPacks = Array.isArray(raw.packs) ? raw.packs : [];
  const packs = rawPacks.map((rawPack) => reconstructPack(rawPack as RawJsonPack));

  const seenNames = new Set<string>();
  const keyOwners = new Map<string, string>();
  for (const pack of packs) {
    if (seenNames.has(pack.name)) {
      throw new Error(`catalog.json: duplicate pack ${JSON.stringify(pack.name)}`);
    }
    seenNames.add(pack.name);
    // No pack-vs-pack og-filename check: reconstructPack accepts bare names only, so the og
    // filename is the name plus a suffix and the duplicate-name throw above already covers it.
    // Pack-vs-reserved is checked per pack in reconstructPack (assertUnreservedOgFilename).
    const packKey = packKeyFor(pack);
    const keyOwner = keyOwners.get(packKey);
    if (keyOwner) {
      throw new Error(
        `catalog.json: packs ${JSON.stringify(keyOwner)} and ${JSON.stringify(pack.name)} share pack_key ${packKey}`,
      );
    }
    keyOwners.set(packKey, pack.name);
  }

  const servedKeys = new Set(packs.map(packKeyFor));
  for (const key of featuredPackKeys) {
    if (!servedKeys.has(key)) {
      throw new Error(`catalog.json: featured pack_key ${JSON.stringify(key)} is not present`);
    }
  }

  return { packs, featuredPackKeys };
}

function reconstructPack(raw: RawJsonPack): CatalogPack {
  const registry = requireString(raw.registry, "catalog.json pack.registry");
  const name = requireString(raw.name, "catalog.json pack.name");
  // Same grammar as normalizePack, or the offline check would either bless an artifact ingest
  // could never emit, or reject one it could.
  if (!ingestedPackNamePattern.test(name) || name.length > maxPackNameSegment) {
    throw new Error(`catalog.json: invalid pack name ${JSON.stringify(name)}`);
  }
  // Fatal here, unlike the ingest lane: nothing recovers from a committed artifact that squats a
  // reserved og filename, and blessing one would let the next `generate` overwrite the site card.
  assertUnreservedOgFilename("catalog.json", name);

  const sourceKind = requireString(raw.source_kind, `catalog.json ${name}.source_kind`);
  if (sourceKind !== "git") {
    throw new Error(`catalog.json ${name}: unsupported source_kind ${JSON.stringify(sourceKind)}`);
  }

  const source = requireString(raw.source, `catalog.json ${name}.source`);
  assertParseableUrl(source, `catalog.json ${name}.source`);
  const packKey = requireString(raw.pack_key, `catalog.json ${name}.pack_key`);
  const expectedPackKey = `${registry}--${name.replaceAll("/", "--")}`;
  if (packKey !== expectedPackKey) {
    throw new Error(
      `catalog.json ${name}: pack_key ${JSON.stringify(packKey)} must be ${JSON.stringify(
        expectedPackKey,
      )}`,
    );
  }
  const tier = requirePackTier(raw.tier, `catalog.json ${name}.tier`);
  const publisher = requireString(
    raw.publisher,
    `catalog.json ${name}.publisher`,
  ).trim();
  if (publisher === UNKNOWN_PUBLISHER) {
    throw new Error(`catalog.json ${name}.publisher must identify the configured source`);
  }

  const rawReleases = Array.isArray(raw.releases) ? raw.releases : [];
  const releases = rawReleases.map((release) =>
    normalizeRelease("catalog.json", name, release as RawRelease),
  );
  const seenVersions = new Set<string>();
  for (const release of releases) {
    if (seenVersions.has(release.version)) {
      throw new Error(`catalog.json ${name}: duplicate release ${JSON.stringify(release.version)}`);
    }
    seenVersions.add(release.version);
  }

  return {
    packKey,
    registry,
    name,
    tier,
    publisher,
    description: requireString(raw.description, `catalog.json ${name}.description`),
    source,
    sourceKind,
    readme: reconstructReadme(name, raw.readme),
    releases,
  };
}

function reconstructReadme(packName: string, raw: unknown): CatalogReadme | undefined {
  if (raw === undefined || raw === null) return undefined;
  const record = raw as { url?: unknown; content?: unknown };
  return {
    url: requireString(record.url, `catalog.json ${packName}.readme.url`),
    content: requireString(record.content, `catalog.json ${packName}.readme.content`),
  };
}

export function summarizeSources(sources: RegistrySource[], packs: CatalogPack[]): SourceSummary[] {
  return sources.map((source) => ({
    name: source.name,
    url: source.url,
    packCount: packs.filter((pack) => pack.registry === source.name).length,
  }));
}

// Offline consistency check: reconstruct the catalog from committed bytes, re-render every
// artifact with all derived fields recomputed, and assert byte-equality with what is
// committed. Proves the committed artifacts are mutually consistent and canonical — it does
// NOT fetch, so it never depends on (or fails because of) live upstream drift.
export async function checkOutputs(
  options: { sourcesPath?: URL; outDir?: URL } = {},
): Promise<void> {
  const sourcesPath = options.sourcesPath ?? defaultSourcesPath;
  const outDir = options.outDir ?? defaultOutDir;
  const paths = outputPaths(outDir);

  const config = await readRegistryConfig(sourcesPath);
  const { sources, featuredPackKeys } = config;
  const { packs, featuredPackKeys: committedFeaturedPackKeys } = await readCatalogJson(
    paths.catalog,
  );

  // Mirror the generate-side wipe guard: a committed empty catalog is never legitimate, so
  // the offline check must reject it too (a wiped-but-self-consistent tree would else pass).
  if (packs.length === 0) {
    throw new Error("catalog.json: contains no packs; refusing to bless an empty catalog");
  }

  const sourceNames = new Set(sources.map((source) => source.name));
  const packsBySource = new Map<string, CatalogPack[]>();
  for (const pack of packs) {
    if (!sourceNames.has(pack.registry)) {
      throw new Error(
        `catalog.json: pack ${JSON.stringify(pack.name)} references source ${JSON.stringify(
          pack.registry,
        )} not declared in sources.toml`,
      );
    }
    const list = packsBySource.get(pack.registry) ?? [];
    list.push(pack);
    packsBySource.set(pack.registry, list);
  }
  for (const source of sources) {
    const sourcePacks = packsBySource.get(source.name) ?? [];
    const actualNames = new Set(sourcePacks.map((pack) => pack.name));
    for (const pack of sourcePacks) {
      if (!source.expectedPacks.includes(pack.name)) {
        throw new Error(
          `catalog.json: pack ${JSON.stringify(pack.name)} is not assigned to source ${JSON.stringify(
            source.name,
          )} by sources.toml`,
        );
      }
      const expectedTier = tierForTrusted(source.trusted);
      if (pack.tier !== expectedTier || pack.publisher !== source.publisher) {
        throw new Error(
          `catalog.json: attribution for ${JSON.stringify(pack.name)} does not match sources.toml`,
        );
      }
    }
    for (const expectedName of source.expectedPacks) {
      if (!actualNames.has(expectedName)) {
        throw new Error(
          `catalog.json: expected pack ${JSON.stringify(expectedName)} is absent from source ${JSON.stringify(
            source.name,
          )}`,
        );
      }
    }
  }
  if (
    committedFeaturedPackKeys.length !== featuredPackKeys.length ||
    committedFeaturedPackKeys.some((key, index) => key !== featuredPackKeys[index])
  ) {
    throw new Error("catalog.json: featured_pack_keys do not match sources.toml");
  }
  for (let index = 1; index < packs.length; index += 1) {
    if (compareByCodepoint(packs[index - 1].name, packs[index].name) >= 0) {
      throw new Error(
        `catalog.json: packs are not in canonical order (${packs[index - 1].name} before ${packs[index].name}); run bun run generate`,
      );
    }
  }

  const sourceSummaries = summarizeSources(sources, packs);
  const registryToml = renderRegistryToml(packs, featuredPackKeys);
  const catalogJson = renderCatalogJson(packs, sourceSummaries, featuredPackKeys);
  const ogFiles = renderOgFiles(packs, sourceSummaries);

  await assertCurrent(paths.registry, registryToml);
  await assertCurrent(paths.catalog, catalogJson);
  for (const file of ogFiles) {
    await assertCurrent(new URL(file.filename, paths.ogDir), file.content);
  }
  await assertNoStaleOgFiles(paths.ogDir, new Set(ogFiles.map((file) => file.filename)));
}
