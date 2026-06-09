import { parse } from "smol-toml";

type SourceConfig = {
  schema?: unknown;
  source?: unknown;
};

type RegistrySource = {
  name: string;
  url: string;
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

type CatalogPack = {
  registry: string;
  name: string;
  description: string;
  source: string;
  sourceKind: string;
  releases: CatalogRelease[];
};

const sourceNamePattern = /^[a-z0-9][a-z0-9-]*$/;
const packNamePattern = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/;
const releaseVersionPattern = /^[0-9]+\.[0-9]+(\.[0-9]+)?$/;
const commitPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^sha256:[0-9a-f]{64}$/;

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

const root = new URL("../", import.meta.url);
const sourcesPath = new URL("sources.toml", root);
const registryPath = new URL("public/registry.toml", root);
const catalogPath = new URL("public/catalog.json", root);

async function main() {
  const sources = await readSources();
  const { packs, sourceSummaries } = await aggregateSources(sources);
  const registryToml = renderRegistryToml(packs);
  const catalogJson = renderCatalogJson(packs, sourceSummaries);

  if (checkOnly) {
    await assertCurrent(registryPath, registryToml);
    await assertCurrent(catalogPath, catalogJson);
    console.log("aggregate registry outputs are current");
    return;
  }

  await Bun.write(registryPath, registryToml);
  await Bun.write(catalogPath, catalogJson);
  console.log(`wrote ${packs.length} pack(s) from ${sources.length} source(s)`);
}

async function readSources() {
  const raw = parse(await Bun.file(sourcesPath).text()) as SourceConfig;
  const schema = typeof raw.schema === "number" ? raw.schema : 1;
  if (schema !== 1) {
    throw new Error(`unsupported sources.toml schema ${schema}`);
  }

  const rawSources = Array.isArray(raw.source) ? raw.source : [];
  if (rawSources.length === 0) {
    throw new Error("sources.toml must include at least one [[source]]");
  }

  const seen = new Set<string>();
  return rawSources.map((rawSource, index): RegistrySource => {
    const record = rawSource as { name?: unknown; url?: unknown };
    const name = requireString(record.name, `source[${index}].name`);
    const url = requireString(record.url, `${name}.url`);

    if (!sourceNamePattern.test(name)) {
      throw new Error(`invalid registry source name ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate registry source name ${JSON.stringify(name)}`);
    }
    seen.add(name);
    validateSourceUrl(name, url);
    return { name, url };
  });
}

async function aggregateSources(sources: RegistrySource[]) {
  const packs: CatalogPack[] = [];
  const seenPacks = new Map<string, string>();
  const sourceSummaries: Array<{ name: string; url: string; packCount: number }> = [];

  for (const source of sources) {
    const catalog = normalizeCatalog(source.name, await readSourceText(source));
    for (const pack of catalog) {
      const previous = seenPacks.get(pack.name);
      if (previous) {
        throw new Error(
          `duplicate pack ${JSON.stringify(pack.name)} from ${source.name}; already provided by ${previous}`,
        );
      }
      seenPacks.set(pack.name, source.name);
      packs.push(pack);
    }
    sourceSummaries.push({ name: source.name, url: source.url, packCount: catalog.length });
  }

  packs.sort((a, b) => a.name.localeCompare(b.name));
  return { packs, sourceSummaries };
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

function normalizeCatalog(registry: string, text: string) {
  const raw = parse(text) as RawCatalog;
  const schema = typeof raw.schema === "number" ? raw.schema : 1;
  if (schema !== 1) {
    throw new Error(`${registry}: unsupported registry catalog schema ${schema}`);
  }

  const rawPacks = Array.isArray(raw.pack) ? raw.pack : [];
  const seen = new Set<string>();
  return rawPacks.map((rawPack): CatalogPack => {
    const pack = normalizePack(registry, rawPack as RawPack);
    if (seen.has(pack.name)) {
      throw new Error(`${registry}: duplicate pack ${JSON.stringify(pack.name)}`);
    }
    seen.add(pack.name);
    return pack;
  });
}

function normalizePack(registry: string, raw: RawPack): CatalogPack {
  const name = requireString(raw.name, `${registry}.pack.name`);
  if (!packNamePattern.test(name)) {
    throw new Error(`${registry}: invalid pack name ${JSON.stringify(name)}`);
  }

  const sourceKind = requireString(raw.source_kind, `${registry}.${name}.source_kind`);
  if (sourceKind !== "git") {
    throw new Error(`${registry}.${name}: unsupported source_kind ${JSON.stringify(sourceKind)}`);
  }

  const releases = (Array.isArray(raw.release) ? raw.release : []).map((release) =>
    normalizeRelease(registry, name, release as RawRelease),
  );
  const seenReleases = new Set<string>();
  for (const release of releases) {
    if (seenReleases.has(release.version)) {
      throw new Error(`${registry}.${name}: duplicate release ${JSON.stringify(release.version)}`);
    }
    seenReleases.add(release.version);
  }

  return {
    registry,
    name,
    description: requireString(raw.description, `${registry}.${name}.description`),
    source: requireString(raw.source, `${registry}.${name}.source`),
    sourceKind,
    releases,
  };
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

  return {
    version,
    ref: requireString(raw.ref, `${label}.ref`),
    commit,
    hash,
    description: requireString(raw.description, `${label}.description`),
    withdrawn: raw.withdrawn === true,
    withdrawnReason:
      typeof raw.withdrawn_reason === "string" && raw.withdrawn_reason.trim()
        ? raw.withdrawn_reason
        : undefined,
  };
}

function renderRegistryToml(packs: CatalogPack[]) {
  const lines = ["schema = 1", ""];
  for (const pack of packs) {
    lines.push("[[pack]]");
    lines.push(`  name = ${quote(pack.name)}`);
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

function renderCatalogJson(
  packs: CatalogPack[],
  sources: Array<{ name: string; url: string; packCount: number }>,
) {
  return `${JSON.stringify(
    {
      schema: 1,
      source_count: sources.length,
      pack_count: packs.length,
      sources: sources.map((source) => ({
        name: source.name,
        url: source.url,
        pack_count: source.packCount,
      })),
      packs: packs.map((pack) => ({
        registry: pack.registry,
        name: pack.name,
        description: pack.description,
        source: pack.source,
        source_kind: pack.sourceKind,
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

async function assertCurrent(path: URL, expected: string) {
  const actual = await Bun.file(path).text();
  if (actual !== expected) {
    throw new Error(`${path.pathname.replace(`${root.pathname}`, "")} is out of date; run bun run generate`);
  }
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

function quote(value: string) {
  return JSON.stringify(value);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`generate-registry: ${message}`);
  process.exit(1);
});
