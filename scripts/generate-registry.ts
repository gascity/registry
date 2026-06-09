import { mkdir, readdir } from "node:fs/promises";
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

type CatalogReadme = {
  url: string;
  content: string;
};

type CatalogPack = {
  registry: string;
  name: string;
  description: string;
  source: string;
  sourceKind: string;
  readme?: CatalogReadme;
  ogImage?: string;
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
const ogDirPath = new URL("public/og/", root);

const readmeCandidates = ["README.md", "README.mdx", "readme.md", "SKILL.md"];
const maxReadmeChars = 80_000;

async function main() {
  const sources = await readSources();
  const { packs, sourceSummaries } = await aggregateSources(sources);
  const registryToml = renderRegistryToml(packs);
  const catalogJson = renderCatalogJson(packs, sourceSummaries);
  const ogFiles = renderOgFiles(packs, sourceSummaries);

  if (checkOnly) {
    await assertCurrent(registryPath, registryToml);
    await assertCurrent(catalogPath, catalogJson);
    for (const file of ogFiles) {
      await assertCurrent(file.path, file.content);
    }
    await assertNoStaleOgFiles(new Set(ogFiles.map((file) => file.path.pathname)));
    console.log("aggregate registry outputs are current");
    return;
  }

  await Bun.write(registryPath, registryToml);
  await Bun.write(catalogPath, catalogJson);
  await mkdir(ogDirPath, { recursive: true });
  for (const file of ogFiles) {
    await Bun.write(file.path, file.content);
  }
  await removeStaleOgFiles(new Set(ogFiles.map((file) => file.path.pathname)));
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
  return {
    packs: await Promise.all(packs.map(enrichPackForWebsite)),
    sourceSummaries,
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

    return {
      url,
      content:
        content.length > maxReadmeChars
          ? `${content.slice(0, maxReadmeChars).trimEnd()}\n\n_Readme truncated by registry aggregator._`
          : content,
    };
  } catch {
    return undefined;
  }
}

function inferReadmeUrls(source: string) {
  const parsed = new URL(source);
  if (parsed.hostname !== "github.com") return [];

  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
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
      og_image: "/og/registry.svg",
      packs: packs.map((pack) => ({
        registry: pack.registry,
        name: pack.name,
        description: pack.description,
        source: pack.source,
        source_kind: pack.sourceKind,
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

function renderOgFiles(
  packs: CatalogPack[],
  sources: Array<{ name: string; url: string; packCount: number }>,
) {
  return [
    {
      path: new URL("registry.svg", ogDirPath),
      content: renderRegistryOgSvg(packs, sources),
    },
    ...packs.map((pack) => ({
      path: new URL(packOgFilename(pack.name), ogDirPath),
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

function packOgFilename(packName: string) {
  return `${packName.replaceAll("/", "--")}.svg`;
}

async function removeStaleOgFiles(expectedPathnames: Set<string>) {
  for (const entry of await listOgFiles()) {
    const path = new URL(entry, ogDirPath);
    if (!expectedPathnames.has(path.pathname)) {
      await Bun.file(path).delete();
    }
  }
}

async function assertNoStaleOgFiles(expectedPathnames: Set<string>) {
  for (const entry of await listOgFiles()) {
    const path = new URL(entry, ogDirPath);
    if (!expectedPathnames.has(path.pathname)) {
      throw new Error(`${path.pathname.replace(`${root.pathname}`, "")} is stale; run bun run generate`);
    }
  }
}

async function listOgFiles() {
  try {
    return (await readdir(ogDirPath)).filter((entry) => entry.endsWith(".svg"));
  } catch {
    return [];
  }
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
