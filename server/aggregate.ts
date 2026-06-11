import { parse } from "smol-toml";
import type { PublishRegistryEntry, PublishRequestRow } from "./types";

type RuntimeRelease = {
  version: string;
  ref: string;
  commit: string;
  hash: string;
  description: string;
  withdrawn?: boolean;
  withdrawnReason?: string;
};

type RuntimePack = {
  registry: string;
  name: string;
  description: string;
  source: string;
  sourceKind: string;
  readme?: unknown;
  ogImage?: string;
  releases: RuntimeRelease[];
};

type RawTomlCatalog = {
  schema?: unknown;
  pack?: unknown;
};

type RawTomlPack = {
  name?: unknown;
  description?: unknown;
  source?: unknown;
  source_kind?: unknown;
  release?: unknown;
};

type RawTomlRelease = {
  version?: unknown;
  ref?: unknown;
  commit?: unknown;
  hash?: unknown;
  description?: unknown;
  withdrawn?: unknown;
  withdrawn_reason?: unknown;
};

type RawJsonCatalog = {
  schema?: unknown;
  source_count?: unknown;
  pack_count?: unknown;
  sources?: unknown;
  og_image?: unknown;
  packs?: unknown;
};

type RawJsonPack = {
  registry?: unknown;
  name?: unknown;
  description?: unknown;
  source?: unknown;
  source_kind?: unknown;
  readme?: unknown;
  og_image?: unknown;
  releases?: unknown;
};

export function renderRegistryTomlWithApprovedPublishes(
  baseToml: string,
  requests: PublishRequestRow[],
) {
  const entries = approvedEntries(requests);
  if (entries.length === 0) return baseToml;
  const packs = mergeApprovedEntries(readTomlPacks(baseToml), entries);
  return renderRegistryToml(packs);
}

export function renderCatalogJsonWithApprovedPublishes(
  baseJson: string,
  requests: PublishRequestRow[],
) {
  const entries = approvedEntries(requests);
  if (entries.length === 0) return baseJson;
  const raw = JSON.parse(baseJson) as RawJsonCatalog;
  const packs = mergeApprovedEntries(readJsonPacks(raw), entries);
  const directPackCount = packs.filter((pack) => pack.registry === "direct").length;
  const baseSources = Array.isArray(raw.sources) ? raw.sources : [];
  const sources =
    directPackCount > 0
      ? [
          ...baseSources,
          {
            name: "direct",
            url: "registry://direct-publish",
            pack_count: directPackCount,
          },
        ]
      : baseSources;

  return `${JSON.stringify(
    {
      schema: 1,
      source_count: sources.length,
      pack_count: packs.length,
      sources,
      og_image: typeof raw.og_image === "string" ? raw.og_image : "/og/registry.svg",
      packs: packs.map(catalogJsonPack),
    },
    null,
    2,
  )}\n`;
}

function approvedEntries(requests: PublishRequestRow[]) {
  return requests
    .filter((request) => request.status === "approved" && request.registryEntry)
    .map((request) => request.registryEntry as PublishRegistryEntry);
}

function mergeApprovedEntries(basePacks: RuntimePack[], entries: PublishRegistryEntry[]) {
  const packs = basePacks.map((pack) => ({ ...pack, releases: [...pack.releases] }));
  for (const entry of entries) {
    const release = entry.release;
    let pack = packs.find((candidate) => candidate.name === entry.name);
    if (!pack) {
      pack = {
        registry: "direct",
        name: entry.name,
        description: entry.description,
        source: entry.source,
        sourceKind: entry.sourceKind,
        ogImage: "/og/registry.svg",
        releases: [],
      };
      packs.push(pack);
    }
    const existingRelease = pack.releases.find((candidate) => candidate.version === release.version);
    if (existingRelease) {
      if (
        existingRelease.commit === release.commit &&
        existingRelease.hash === release.hash &&
        existingRelease.ref === release.ref
      ) {
        continue;
      }
      throw new Error(`approved publish conflicts with existing ${entry.name} ${release.version}`);
    }
    pack.releases.push({ ...release });
  }
  packs.sort((left, right) => left.name.localeCompare(right.name));
  for (const pack of packs) {
    pack.releases.sort((left, right) => compareVersions(left.version, right.version));
  }
  return packs;
}

function readTomlPacks(baseToml: string): RuntimePack[] {
  const raw = parse(baseToml) as RawTomlCatalog;
  const rawPacks = Array.isArray(raw.pack) ? raw.pack : [];
  return rawPacks.map((pack) => normalizeTomlPack(pack as RawTomlPack));
}

function normalizeTomlPack(raw: RawTomlPack): RuntimePack {
  const name = requireString(raw.name, "pack.name");
  return {
    registry: "gascity-packs",
    name,
    description: requireString(raw.description, `${name}.description`),
    source: requireString(raw.source, `${name}.source`),
    sourceKind: requireString(raw.source_kind, `${name}.source_kind`),
    releases: (Array.isArray(raw.release) ? raw.release : []).map((release) =>
      normalizeTomlRelease(name, release as RawTomlRelease),
    ),
  };
}

function normalizeTomlRelease(packName: string, raw: RawTomlRelease): RuntimeRelease {
  const version = requireString(raw.version, `${packName}.release.version`);
  return {
    version,
    ref: requireString(raw.ref, `${packName}@${version}.ref`),
    commit: requireString(raw.commit, `${packName}@${version}.commit`),
    hash: requireString(raw.hash, `${packName}@${version}.hash`),
    description: requireString(raw.description, `${packName}@${version}.description`),
    withdrawn: raw.withdrawn === true,
    withdrawnReason: typeof raw.withdrawn_reason === "string" ? raw.withdrawn_reason : undefined,
  };
}

function readJsonPacks(raw: RawJsonCatalog): RuntimePack[] {
  const rawPacks = Array.isArray(raw.packs) ? raw.packs : [];
  return rawPacks.map((pack) => normalizeJsonPack(pack as RawJsonPack));
}

function normalizeJsonPack(raw: RawJsonPack): RuntimePack {
  const name = requireString(raw.name, "pack.name");
  return {
    registry: stringValue(raw.registry) ?? "aggregate",
    name,
    description: requireString(raw.description, `${name}.description`),
    source: requireString(raw.source, `${name}.source`),
    sourceKind: requireString(raw.source_kind, `${name}.source_kind`),
    readme: raw.readme,
    ogImage: stringValue(raw.og_image),
    releases: (Array.isArray(raw.releases) ? raw.releases : []).map((release) =>
      normalizeJsonRelease(name, release as RawTomlRelease),
    ),
  };
}

function normalizeJsonRelease(packName: string, raw: RawTomlRelease): RuntimeRelease {
  return normalizeTomlRelease(packName, raw);
}

function renderRegistryToml(packs: RuntimePack[]) {
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

function catalogJsonPack(pack: RuntimePack) {
  const latest = latestActiveVersion(pack);
  return {
    pack_key: `${pack.registry}--${pack.name.replaceAll("/", "--")}`,
    registry: pack.registry,
    name: pack.name,
    description: pack.description,
    source: pack.source,
    source_kind: pack.sourceKind,
    search_text: searchTextFor(pack),
    readme: pack.readme,
    og_image: pack.ogImage ?? "/og/registry.svg",
    latest,
    releases: pack.releases.map((release) => ({
      version: release.version,
      ref: release.ref,
      commit: release.commit,
      hash: release.hash,
      description: release.description,
      withdrawn: release.withdrawn === true,
      withdrawn_reason: release.withdrawnReason,
    })),
  };
}

function latestActiveVersion(pack: RuntimePack) {
  return pack.releases
    .filter((release) => !release.withdrawn)
    .sort((left, right) => -compareVersions(left.version, right.version))[0]?.version;
}

function searchTextFor(pack: RuntimePack) {
  return [
    pack.name,
    pack.registry,
    pack.description,
    pack.source,
    pack.sourceKind,
    ...pack.releases.map((release) => `${release.version} ${release.description}`),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function quote(value: string) {
  return JSON.stringify(value);
}
