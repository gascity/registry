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

export type CatalogRenderIssue =
  | { kind: "base"; error: Error }
  | { kind: "entry"; requestId: string; name: string; version: string; error: Error };

export type RenderOptions = {
  // "strict" (default): any un-mergeable approved entry throws — the approve-time dry run
  // (assertPublishRequestCanMerge) relies on this to REJECT conflicts at approve time.
  // "fail-soft": skip the bad entry / fall back to the base artifact and report via onIssue.
  // Only the public serve path opts into fail-soft, so one poisoned approved publish can never
  // 500 /registry.toml + /catalog.json for everyone.
  mode?: "strict" | "fail-soft";
  onIssue?: (issue: CatalogRenderIssue) => void;
};

type ApprovedEntry = { requestId: string; entry: PublishRegistryEntry };

export function renderRegistryTomlWithApprovedPublishes(
  baseToml: string,
  requests: PublishRequestRow[],
  options: RenderOptions = {},
) {
  const entries = approvedEntries(requests);
  if (entries.length === 0) return baseToml;
  let basePacks: RuntimePack[];
  try {
    basePacks = readTomlPacks(baseToml);
  } catch (error) {
    if (options.mode !== "fail-soft") throw error;
    options.onIssue?.({ kind: "base", error: asError(error) });
    return baseToml; // serve the committed artifact unmerged rather than 500
  }
  return renderRegistryToml(mergeApprovedEntries(basePacks, entries, options));
}

export function renderCatalogJsonWithApprovedPublishes(
  baseJson: string,
  requests: PublishRequestRow[],
  options: RenderOptions = {},
) {
  const entries = approvedEntries(requests);
  if (entries.length === 0) return baseJson;
  let raw: RawJsonCatalog;
  let basePacks: RuntimePack[];
  try {
    raw = JSON.parse(baseJson) as RawJsonCatalog;
    basePacks = readJsonPacks(raw);
  } catch (error) {
    if (options.mode !== "fail-soft") throw error;
    options.onIssue?.({ kind: "base", error: asError(error) });
    return baseJson;
  }
  const packs = mergeApprovedEntries(basePacks, entries, options);
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

function approvedEntries(requests: PublishRequestRow[]): ApprovedEntry[] {
  return requests
    .filter((request) => request.status === "approved" && request.registryEntry)
    .map((request) => ({ requestId: request.id, entry: request.registryEntry as PublishRegistryEntry }));
}

function mergeApprovedEntries(basePacks: RuntimePack[], entries: ApprovedEntry[], options: RenderOptions) {
  const packs = basePacks.map((pack) => ({ ...pack, releases: [...pack.releases] }));
  for (const { requestId, entry } of entries) {
    try {
      mergeApprovedEntry(packs, entry);
    } catch (error) {
      if (options.mode !== "fail-soft") throw error;
      options.onIssue?.({
        kind: "entry",
        requestId,
        name: typeof entry?.name === "string" ? entry.name : "(unknown)",
        version: typeof entry?.release?.version === "string" ? entry.release.version : "(unknown)",
        error: asError(error),
      });
    }
  }
  packs.sort((left, right) => left.name.localeCompare(right.name));
  for (const pack of packs) {
    pack.releases.sort((left, right) => compareVersions(left.version, right.version));
  }
  return packs;
}

// Merge one approved direct-publish entry. Re-validates the stored registry_entry BEFORE any
// mutation (a junk row must not reach the renderer — quote(undefined) would emit a literal
// `undefined`), so a skipped entry in fail-soft mode leaves zero partial state.
function mergeApprovedEntry(packs: RuntimePack[], entry: PublishRegistryEntry) {
  const name = requireString(entry?.name, "approved entry name");
  const release = entry?.release ?? ({} as PublishRegistryEntry["release"]);
  const version = requireString(release?.version, `${name} release version`);
  requireString(entry.description, `${name} description`);
  requireString(entry.source, `${name} source`);
  requireString(entry.sourceKind, `${name} sourceKind`);
  requireString(release.ref, `${name}@${version} ref`);
  requireString(release.commit, `${name}@${version} commit`);
  requireString(release.hash, `${name}@${version} hash`);
  requireString(release.description, `${name}@${version} description`);

  const pack = packs.find((candidate) => candidate.name === name);
  const existingRelease = pack?.releases.find((candidate) => candidate.version === version);
  if (existingRelease) {
    if (
      existingRelease.commit === release.commit &&
      existingRelease.hash === release.hash &&
      existingRelease.ref === release.ref
    ) {
      return;
    }
    throw new Error(`approved publish conflicts with existing ${name} ${version}`);
  }
  // Validation passed — only now mutate.
  const target =
    pack ??
    (() => {
      const created: RuntimePack = {
        registry: "direct",
        name,
        description: entry.description,
        source: entry.source,
        sourceKind: entry.sourceKind,
        ogImage: "/og/registry.svg",
        releases: [],
      };
      packs.push(created);
      return created;
    })();
  target.releases.push({ ...release });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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
