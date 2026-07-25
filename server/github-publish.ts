import { posix as path } from "node:path";
import { parse } from "smol-toml";
import { sha256 } from "./crypto";
import { githubFetch } from "./github";
import { RequestError } from "./http";
import { normalizePackPath } from "./publish";
import type {
  GitHubPublishCandidate,
  GitHubPublishImportCreateInput,
  PublishRequestInput,
} from "./types";

type GitHubFetchFn = (apiPath: string, accessToken: string) => Promise<Response> | Response;

type DiscoveryOptions = {
  fetchGitHub?: GitHubFetchFn;
  maxInstallations?: number;
  maxRepositories?: number;
  maxCandidates?: number;
  maxPackTomlBytes?: number;
  now?: () => number;
};

type GitHubInstallation = {
  id?: number;
};

type GitHubRepository = {
  id?: number;
  name?: string;
  full_name?: string;
  html_url?: string;
  private?: boolean;
  default_branch?: string;
  owner?: {
    id?: number;
    login?: string;
  };
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    pull?: boolean;
  };
};

type GitHubPaged<T> = {
  installations?: T[];
  repositories?: T[];
};

type GitHubBranch = {
  commit?: {
    sha?: string;
    commit?: {
      tree?: {
        sha?: string;
      };
    };
  };
};

type GitHubTree = {
  tree?: Array<{
    path?: string;
    type?: string;
    size?: number;
  }>;
  truncated?: boolean;
};

type GitHubContentFile = {
  type?: string;
  encoding?: string;
  content?: string;
  size?: number;
};

type PackToml = {
  pack?: {
    name?: unknown;
    version?: unknown;
    description?: unknown;
  };
};

type PublishCandidateOverrides = {
  requestedName?: string;
  requestedVersion?: string;
  requestedDescription?: string;
  requestedRef?: string;
};

const importTtlMs = 30 * 60 * 1000;
const defaultMaxInstallations = 10;
const defaultMaxRepositories = 200;
const defaultMaxCandidates = 100;
const defaultMaxPackTomlBytes = 256 * 1024;
const commitPattern = /^[0-9a-f]{40}$/;
const packNamePattern = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/;
const releaseVersionPattern = /^[0-9]+\.[0-9]+(\.[0-9]+)?$/;

export async function discoverGitHubPublishCandidates(
  accessToken: string,
  options: DiscoveryOptions = {},
): Promise<GitHubPublishImportCreateInput> {
  const fetchGitHub = options.fetchGitHub ?? githubFetch;
  const maxInstallations = options.maxInstallations ?? defaultMaxInstallations;
  const maxRepositories = options.maxRepositories ?? defaultMaxRepositories;
  const maxCandidates = options.maxCandidates ?? defaultMaxCandidates;
  const maxPackTomlBytes = options.maxPackTomlBytes ?? defaultMaxPackTomlBytes;
  const now = options.now ?? Date.now;
  const candidates: GitHubPublishCandidate[] = [];
  const scanErrors: string[] = [];
  let repositoriesScanned = 0;
  let privateRepositoriesSkipped = 0;
  let truncated = false;

  installationLoop: for (let page = 1; page <= maxInstallations; page += 1) {
    const installations = await fetchInstallations(accessToken, fetchGitHub, page);
    for (const installation of installations) {
      if (!installation.id) continue;
      for (let repoPage = 1; repoPage <= 10; repoPage += 1) {
        const repositories = await fetchInstallationRepositories(
          accessToken,
          fetchGitHub,
          installation.id,
          repoPage,
        );
        for (const repository of repositories) {
          if (repositoriesScanned >= maxRepositories || candidates.length >= maxCandidates) {
            truncated = true;
            break installationLoop;
          }
          repositoriesScanned += 1;
          if (repository.private) {
            privateRepositoriesSkipped += 1;
            continue;
          }
          const permission = publishPermission(repository);
          if (!permission) continue;

          try {
            const discovered = await scanRepositoryForPackTomls(
              accessToken,
              fetchGitHub,
              repository,
              permission,
              maxPackTomlBytes,
              maxCandidates - candidates.length,
            );
            candidates.push(...discovered.candidates);
            truncated = truncated || discovered.truncated;
          } catch (error) {
            scanErrors.push(`${repository.full_name ?? "unknown repository"}: ${scanErrorMessage(error)}`);
          }
        }
        if (repositories.length < 100) break;
      }
    }
    if (installations.length < 100) break;
  }

  return {
    repositoriesScanned,
    privateRepositoriesSkipped,
    candidates,
    scanErrors: scanErrors.slice(0, 25),
    truncated,
    expiresAt: new Date(now() + importTtlMs),
  };
}

export function publishInputFromGitHubCandidate(
  candidate: GitHubPublishCandidate,
  overrides: PublishCandidateOverrides = {},
): PublishRequestInput {
  const requestedName = cleanOverride(overrides.requestedName) || candidate.pack.name;
  const requestedVersion = cleanOverride(overrides.requestedVersion) || candidate.pack.version || "";
  const requestedDescription =
    cleanOverride(overrides.requestedDescription) || candidate.pack.description || undefined;
  const requestedRef = cleanOverride(overrides.requestedRef) || candidate.branch;
  return {
    repoUrl: candidate.repository.htmlUrl,
    commit: candidate.commit,
    packPath: candidate.packPath,
    requestedName,
    requestedVersion,
    requestedRef,
    requestedDescription,
  };
}

async function fetchInstallations(
  accessToken: string,
  fetchGitHub: GitHubFetchFn,
  page: number,
) {
  const response = await fetchGitHub(`/user/installations?per_page=100&page=${page}`, accessToken);
  if (!response.ok) {
    throw new RequestError(401, "GITHUB_INSTALLATIONS_FAILED", "GitHub installation lookup failed.");
  }
  const payload = (await response.json()) as GitHubPaged<GitHubInstallation>;
  return payload.installations ?? [];
}

async function fetchInstallationRepositories(
  accessToken: string,
  fetchGitHub: GitHubFetchFn,
  installationId: number,
  page: number,
) {
  const response = await fetchGitHub(
    `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
    accessToken,
  );
  if (!response.ok) {
    throw new RequestError(401, "GITHUB_REPOSITORIES_FAILED", "GitHub repository lookup failed.");
  }
  const payload = (await response.json()) as GitHubPaged<GitHubRepository>;
  return payload.repositories ?? [];
}

async function scanRepositoryForPackTomls(
  accessToken: string,
  fetchGitHub: GitHubFetchFn,
  repository: GitHubRepository,
  permission: GitHubPublishCandidate["repository"]["permission"],
  maxPackTomlBytes: number,
  remainingCandidateSlots: number,
) {
  const normalized = normalizeRepository(repository);
  if (!normalized) return { candidates: [], truncated: false };
  const branch = await fetchDefaultBranch(accessToken, fetchGitHub, normalized);
  if (!branch.commit || !branch.tree) return { candidates: [], truncated: false };
  const tree = await fetchRecursiveTree(accessToken, fetchGitHub, normalized, branch.tree);
  const allPackTomlPaths = packTomlPathsFromTree(tree);
  const packTomlPaths = allPackTomlPaths.slice(0, remainingCandidateSlots);
  const candidates: GitHubPublishCandidate[] = [];

  for (const packTomlPath of packTomlPaths) {
    const packPath = normalizeCandidatePackPath(packTomlPath);
    if (!packPath) continue;
    const content = await fetchPackTomlContent(
      accessToken,
      fetchGitHub,
      normalized,
      packTomlPath,
      branch.commit,
      maxPackTomlBytes,
    );
    if (!content) continue;
    const metadata = packMetadataFromToml(content);
    if (!metadata) continue;
    const warnings: string[] = [];
    if (!metadata.version) warnings.push("pack.toml does not declare [pack].version.");
    candidates.push({
      id: candidateId(normalized.fullName, branch.commit, packTomlPath, metadata.name),
      repository: {
        id: normalized.id,
        fullName: normalized.fullName,
        owner: normalized.owner,
        ownerId: normalized.ownerId,
        name: normalized.name,
        htmlUrl: normalized.htmlUrl,
        defaultBranch: normalized.defaultBranch,
        permission,
      },
      branch: normalized.defaultBranch,
      commit: branch.commit,
      packPath,
      packTomlPath,
      pack: metadata,
      warnings,
    });
  }

  return { candidates, truncated: Boolean(tree.truncated) || allPackTomlPaths.length > remainingCandidateSlots };
}

function publishPermission(repository: GitHubRepository) {
  if (repository.permissions?.admin) return "admin";
  if (repository.permissions?.maintain) return "maintain";
  if (repository.permissions?.push) return "push";
  return undefined;
}

function normalizeRepository(repository: GitHubRepository) {
  if (!repository.id || !repository.full_name || !repository.name || !repository.default_branch) return null;
  const [owner, name] = repository.full_name.split("/");
  if (!owner || !name) return null;
  return {
    id: String(repository.id),
    owner,
    // Rename-stable account id; absent if the installation response omitted the owner object.
    ownerId: repository.owner?.id ? String(repository.owner.id) : undefined,
    name,
    fullName: repository.full_name,
    htmlUrl: repository.html_url || `https://github.com/${repository.full_name}`,
    defaultBranch: repository.default_branch,
  };
}

async function fetchDefaultBranch(
  accessToken: string,
  fetchGitHub: GitHubFetchFn,
  repository: NonNullable<ReturnType<typeof normalizeRepository>>,
) {
  const response = await fetchGitHub(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/branches/${encodeURIComponent(
      repository.defaultBranch,
    )}`,
    accessToken,
  );
  if (!response.ok) return { commit: undefined, tree: undefined };
  const payload = (await response.json()) as GitHubBranch;
  const commit = payload.commit?.sha?.toLowerCase();
  const tree = payload.commit?.commit?.tree?.sha?.toLowerCase();
  return {
    commit: commit && commitPattern.test(commit) ? commit : undefined,
    tree: tree && commitPattern.test(tree) ? tree : undefined,
  };
}

async function fetchRecursiveTree(
  accessToken: string,
  fetchGitHub: GitHubFetchFn,
  repository: NonNullable<ReturnType<typeof normalizeRepository>>,
  treeSha: string,
) {
  const response = await fetchGitHub(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${treeSha}?recursive=1`,
    accessToken,
  );
  if (!response.ok) return { tree: [], truncated: false } satisfies GitHubTree;
  return (await response.json()) as GitHubTree;
}

function packTomlPathsFromTree(tree: GitHubTree) {
  return (tree.tree ?? [])
    .filter((entry) => entry.type === "blob" && entry.path?.split("/").pop()?.toLowerCase() === "pack.toml")
    .map((entry) => entry.path!)
    .sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right));
}

async function fetchPackTomlContent(
  accessToken: string,
  fetchGitHub: GitHubFetchFn,
  repository: NonNullable<ReturnType<typeof normalizeRepository>>,
  packTomlPath: string,
  commit: string,
  maxPackTomlBytes: number,
) {
  const response = await fetchGitHub(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/${encodePath(
      packTomlPath,
    )}?ref=${encodeURIComponent(commit)}`,
    accessToken,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`unable to fetch ${packTomlPath}`);
  const payload = (await response.json()) as GitHubContentFile;
  if (payload.type !== "file" || payload.encoding !== "base64" || !payload.content) return null;
  if (payload.size && payload.size > maxPackTomlBytes) return null;
  const text = Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8");
  if (Buffer.byteLength(text, "utf8") > maxPackTomlBytes) return null;
  return text;
}

function normalizeCandidatePackPath(packTomlPath: string) {
  const dirname = path.dirname(packTomlPath);
  const rawPackPath = dirname === "." ? "." : dirname;
  try {
    return normalizePackPath(rawPackPath);
  } catch {
    return undefined;
  }
}

function packMetadataFromToml(text: string) {
  let raw: PackToml;
  try {
    raw = parse(text) as PackToml;
  } catch {
    return undefined;
  }
  const name = stringValue(raw.pack?.name);
  if (!name || !packNamePattern.test(name)) return undefined;
  const version = stringValue(raw.pack?.version);
  const description = stringValue(raw.pack?.description)?.slice(0, 240);
  return {
    name,
    version: version && releaseVersionPattern.test(version) ? version : undefined,
    description,
  };
}

function candidateId(fullName: string, commit: string, packTomlPath: string, packName: string) {
  return `gpc_${sha256(`${fullName}:${commit}:${packTomlPath}:${packName}`).slice(0, 24)}`;
}

function encodePath(value: string) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function pathDepth(value: string) {
  return value.split("/").length;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : undefined;
}

function cleanOverride(value: string | undefined) {
  const clean = value?.trim();
  return clean || undefined;
}

function scanErrorMessage(error: unknown) {
  if (error instanceof RequestError) return error.message;
  if (error instanceof Error) return error.message;
  return "scan failed";
}
