import { Bot, Database, GitBranch, MessageCircle, MessagesSquare, PackageSearch } from "lucide-react";
import { parse } from "smol-toml";

const PRIMARY_REGISTRY_URL =
  import.meta.env.VITE_CATALOG_URL?.trim() || "/catalog.json";

const FALLBACK_REGISTRY_URL = import.meta.env.VITE_REGISTRY_URL?.trim() || "/registry.toml";

export type CatalogRelease = {
  version: string;
  ref: string;
  commit: string;
  hash: string;
  description: string;
  withdrawn: boolean;
  withdrawnReason?: string;
};

export type CatalogReadme = {
  url: string;
  content: string;
};

export type CatalogPack = {
  registry: string;
  name: string;
  description: string;
  source: string;
  sourceKind: string;
  readme?: CatalogReadme;
  ogImage?: string;
  releases: CatalogRelease[];
};

export type RegistryCatalogState = {
  packs: CatalogPack[];
  ogImage?: string;
  sourceUrl: string;
  loadedFromFallback: boolean;
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

type RawJsonCatalog = {
  schema?: unknown;
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

type RawJsonReadme = {
  url?: unknown;
  content?: unknown;
};

export async function fetchRegistryCatalog(): Promise<RegistryCatalogState> {
  try {
    return await fetchCatalogFrom(PRIMARY_REGISTRY_URL, false);
  } catch (primaryError) {
    try {
      return await fetchCatalogFrom(FALLBACK_REGISTRY_URL, true);
    } catch {
      const message =
        primaryError instanceof Error ? primaryError.message : "Unable to load registry catalog.";
      throw new Error(message);
    }
  }
}

async function fetchCatalogFrom(sourceUrl: string, loadedFromFallback: boolean) {
  const response = await fetch(sourceUrl, { headers: { Accept: "application/json, text/plain" } });
  if (!response.ok) {
    throw new Error(`Registry catalog request failed with HTTP ${response.status}.`);
  }
  const text = await response.text();
  const catalog =
    sourceUrl.endsWith(".json") || response.headers.get("content-type")?.includes("json")
      ? normalizeJsonCatalog(JSON.parse(text) as RawJsonCatalog)
      : normalizeCatalog(parse(text) as RawCatalog);
  return { ...catalog, sourceUrl, loadedFromFallback };
}

function normalizeCatalog(raw: RawCatalog): { packs: CatalogPack[]; ogImage?: string } {
  const schema = typeof raw.schema === "number" ? raw.schema : 1;
  if (schema !== 1) {
    throw new Error(`Unsupported registry catalog schema ${schema}.`);
  }

  const rawPacks = Array.isArray(raw.pack) ? raw.pack : [];
  return {
    packs: rawPacks.map((pack) => normalizePack(pack as RawPack)).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function normalizeJsonCatalog(raw: RawJsonCatalog): { packs: CatalogPack[]; ogImage?: string } {
  const schema = typeof raw.schema === "number" ? raw.schema : 1;
  if (schema !== 1) {
    throw new Error(`Unsupported registry catalog schema ${schema}.`);
  }

  const rawPacks = Array.isArray(raw.packs) ? raw.packs : [];
  return {
    ogImage: optionalString(raw.og_image),
    packs: rawPacks
      .map((pack) => normalizeJsonPack(pack as RawJsonPack))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function normalizeJsonPack(raw: RawJsonPack): CatalogPack {
  const name = requireString(raw.name, "pack.name");
  return {
    registry: optionalString(raw.registry) ?? "aggregate",
    name,
    description: requireString(raw.description, `${name}.description`),
    source: requireString(raw.source, `${name}.source`),
    sourceKind: requireString(raw.source_kind, `${name}.source_kind`),
    readme: normalizeJsonReadme(raw.readme),
    ogImage: optionalString(raw.og_image),
    releases: (Array.isArray(raw.releases) ? raw.releases : []).map((release) =>
      normalizeRelease(name, release as RawRelease),
    ),
  };
}

function normalizePack(raw: RawPack): CatalogPack {
  const name = requireString(raw.name, "pack.name");
  return {
    registry: "registry.toml",
    name,
    description: requireString(raw.description, `${name}.description`),
    source: requireString(raw.source, `${name}.source`),
    sourceKind: requireString(raw.source_kind, `${name}.source_kind`),
    releases: (Array.isArray(raw.release) ? raw.release : []).map((release) =>
      normalizeRelease(name, release as RawRelease),
    ),
  };
}

function normalizeJsonReadme(raw: unknown): CatalogReadme | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as RawJsonReadme;
  const url = optionalString(record.url);
  const content = optionalString(record.content);
  if (!url || !content) return undefined;
  return { url, content };
}

function normalizeRelease(packName: string, raw: RawRelease): CatalogRelease {
  const version = requireString(raw.version, `${packName}.release.version`);
  return {
    version,
    ref: requireString(raw.ref, `${packName}@${version}.ref`),
    commit: requireString(raw.commit, `${packName}@${version}.commit`),
    hash: requireString(raw.hash, `${packName}@${version}.hash`),
    description: requireString(raw.description, `${packName}@${version}.description`),
    withdrawn: raw.withdrawn === true,
    withdrawnReason:
      typeof raw.withdrawn_reason === "string" && raw.withdrawn_reason.trim()
        ? raw.withdrawn_reason
        : undefined,
  };
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Registry catalog is missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function latestActiveRelease(pack: CatalogPack) {
  return pack.releases
    .filter((release) => !release.withdrawn)
    .sort((a, b) => -compareVersions(a.version, b.version))[0];
}

export function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function releaseCounts(packs: CatalogPack[]) {
  return packs.reduce(
    (counts, pack) => {
      for (const release of pack.releases) {
        if (release.withdrawn) counts.withdrawn += 1;
        else counts.active += 1;
      }
      return counts;
    },
    { active: 0, withdrawn: 0 },
  );
}

export function shortCommit(commit: string) {
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}

export function buildImportCommands(pack: CatalogPack, latest: string) {
  const source = shellQuote(pack.source);
  const name = shellQuote(pack.name);
  return {
    floating: `gc import add ${source} --name ${name} --version '>=${latest}'`,
    exact: `gc import add ${source} --name ${name} --version '${latest}'`,
  };
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function categoryForPack(pack: CatalogPack) {
  const haystack = `${pack.name} ${pack.description}`.toLowerCase();
  if (haystack.includes("slack") || haystack.includes("discord")) {
    return { value: "chatops", label: "ChatOps", icon: MessagesSquare };
  }
  if (haystack.includes("github") || haystack.includes("webhook")) {
    return { value: "integration", label: "Integrations", icon: GitBranch };
  }
  if (haystack.includes("cass") || haystack.includes("search")) {
    return { value: "knowledge", label: "Knowledge", icon: Database };
  }
  if (haystack.includes("agent") || haystack.includes("workflow") || haystack.includes("town")) {
    return { value: "workflow", label: "Workflows", icon: Bot };
  }
  if (haystack.includes("message")) {
    return { value: "chatops", label: "ChatOps", icon: MessageCircle };
  }
  return { value: "workflow", label: "Workflows", icon: PackageSearch };
}
