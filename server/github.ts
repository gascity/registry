import { createHmac, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "./config";
import { base64Url, randomToken, signValue, verifySignedValue } from "./crypto";
import { RequestError } from "./http";
import type { SourceRepository, VerifiedPackOwnershipInput } from "./types";

const githubWebUrl = "https://github.com";
const githubApiUrl = "https://api.github.com";
const githubClaimStateMaxAgeMs = 10 * 60 * 1000;

type GitHubClaimState = {
  nonce: string;
  userId: string;
  packKey: string;
  sourceUrl: string;
  redirectTo: string;
  createdAt: number;
};

type GitHubTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type GitHubUser = {
  id?: number;
  login?: string;
};

type GitHubRepository = {
  id?: number;
  name?: string;
  full_name?: string;
  private?: boolean;
  owner?: {
    id?: number;
    login?: string;
    type?: string;
  };
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    pull?: boolean;
    triage?: boolean;
  };
};

type GitHubInstallation = {
  id?: number;
};

type GitHubPaged<T> = {
  total_count?: number;
  installations?: T[];
  repositories?: T[];
};

type GitHubWebhookPayload = {
  action?: unknown;
  repositories?: unknown;
  repositories_removed?: unknown;
};

type VerifiedGitHubRepository = Omit<
  VerifiedPackOwnershipInput,
  "packKey" | "sourceUrl" | "verificationMethod"
> & {
  verificationMethod: "github_app_user_token";
};

export function parseGitHubSource(sourceUrl: string): SourceRepository | undefined {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return undefined;
  const [owner, rawRepo] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !rawRepo) return undefined;
  const name = rawRepo.replace(/\.git$/i, "");
  if (!isGitHubName(owner) || !isGitHubName(name)) return undefined;
  return {
    host: "github.com",
    owner,
    name,
    fullName: `${owner}/${name}`,
  };
}

export function githubAppInstallUrl(config: ServerConfig) {
  return config.githubApp
    ? `${githubWebUrl}/apps/${encodeURIComponent(config.githubApp.appSlug)}/installations/select_target`
    : undefined;
}

export function githubAppConfigured(config: ServerConfig) {
  return Boolean(config.githubApp);
}

export function githubAppClientId(config: ServerConfig) {
  return config.githubApp?.clientId;
}

export function githubAuthorizationUrl(config: ServerConfig, state: string) {
  if (!config.githubApp) {
    throw new RequestError(503, "GITHUB_APP_NOT_CONFIGURED", "GitHub ownership is not configured.");
  }
  const url = new URL(`${githubWebUrl}/login/oauth/authorize`);
  url.searchParams.set("client_id", config.githubApp.clientId);
  url.searchParams.set("redirect_uri", githubCallbackUrl(config));
  url.searchParams.set("state", state);
  return url.toString();
}

export function signGitHubClaimState(
  config: ServerConfig,
  state: Omit<GitHubClaimState, "nonce" | "createdAt">,
) {
  return signValue(
    base64Url(
      JSON.stringify({
        ...state,
        nonce: randomToken(18),
        createdAt: Date.now(),
      } satisfies GitHubClaimState),
    ),
    config.sessionSecret,
  );
}

export function verifyGitHubClaimState(config: ServerConfig, signedState: string) {
  const encoded = verifySignedValue(signedState, config.sessionSecret);
  if (!encoded) throw new RequestError(400, "BAD_GITHUB_STATE", "GitHub verification state is invalid.");
  let state: GitHubClaimState;
  try {
    state = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as GitHubClaimState;
  } catch {
    throw new RequestError(400, "BAD_GITHUB_STATE", "GitHub verification state is invalid.");
  }
  if (
    !state.userId ||
    !state.packKey ||
    !state.sourceUrl ||
    !state.redirectTo ||
    Date.now() - state.createdAt > githubClaimStateMaxAgeMs
  ) {
    throw new RequestError(400, "BAD_GITHUB_STATE", "GitHub verification state is invalid.");
  }
  return state;
}

export async function verifyGitHubPackOwnership(
  config: ServerConfig,
  code: string,
  sourceRepository: SourceRepository,
): Promise<VerifiedGitHubRepository> {
  if (!config.githubApp) {
    throw new RequestError(503, "GITHUB_APP_NOT_CONFIGURED", "GitHub ownership is not configured.");
  }
  const accessToken = await exchangeGitHubCode(config, code);
  const user = await fetchGitHubUser(accessToken);
  if (!user.id || !user.login) {
    throw new RequestError(401, "GITHUB_IDENTITY_FAILED", "GitHub identity verification failed.");
  }

  const repo = await findUserInstallationRepository(accessToken, sourceRepository);
  if (!repo) {
    throw new RequestError(
      403,
      "GITHUB_REPO_NOT_ACCESSIBLE",
      "Install the Registry GitHub App on the source repo, then verify again.",
    );
  }
  if (!repo.permissions?.admin) {
    throw new RequestError(
      403,
      "GITHUB_REPO_ADMIN_REQUIRED",
      "GitHub admin access to the source repo is required to verify pack ownership.",
    );
  }
  if (!repo.id || !repo.name || !repo.full_name || !repo.owner?.id || !repo.owner.login) {
    throw new RequestError(401, "GITHUB_REPO_VERIFY_FAILED", "GitHub repository verification failed.");
  }

  return {
    githubRepositoryId: String(repo.id),
    githubRepositoryFullName: repo.full_name,
    githubRepositoryName: repo.name,
    githubOwnerId: String(repo.owner.id),
    githubOwnerLogin: repo.owner.login,
    githubOwnerType: repo.owner.type === "Organization" ? "Organization" : "User",
    verificationMethod: "github_app_user_token",
  };
}

export async function validateGitHubWebhook(request: Request, config: ServerConfig) {
  if (!config.githubApp?.webhookSecret) {
    throw new RequestError(404, "NOT_FOUND", "Not found.");
  }
  const maxWebhookBytes = 256 * 1024;
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > maxWebhookBytes) {
    throw new RequestError(413, "PAYLOAD_TOO_LARGE", "Webhook body is too large.");
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > maxWebhookBytes) {
    throw new RequestError(413, "PAYLOAD_TOO_LARGE", "Webhook body is too large.");
  }
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyWebhookSignature(body, signature, config.githubApp.webhookSecret)) {
    throw new RequestError(401, "BAD_SIGNATURE", "Webhook signature verification failed.");
  }
  const event = request.headers.get("x-github-event") ?? "unknown";
  const delivery = request.headers.get("x-github-delivery") ?? "unknown";
  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(body) as GitHubWebhookPayload;
  } catch {
    throw new RequestError(400, "INVALID_JSON", "Webhook body must be valid JSON.");
  }
  return { event, delivery, payload };
}

export function revokedRepositoryIdsFromWebhook(event: string, payload: GitHubWebhookPayload) {
  const action = typeof payload.action === "string" ? payload.action : "";
  if (event === "installation" && action === "deleted") {
    return repositoryIds(payload.repositories);
  }
  if (event === "installation_repositories" && action === "removed") {
    return repositoryIds(payload.repositories_removed);
  }
  return [];
}

function githubCallbackUrl(config: ServerConfig) {
  return `${config.appUrl}/api/ownership/github/callback`;
}

async function exchangeGitHubCode(config: ServerConfig, code: string) {
  if (!config.githubApp) {
    throw new RequestError(503, "GITHUB_APP_NOT_CONFIGURED", "GitHub ownership is not configured.");
  }
  const response = await fetch(`${githubWebUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.githubApp.clientId,
      client_secret: config.githubApp.clientSecret,
      code,
      redirect_uri: githubCallbackUrl(config),
    }),
  });
  if (!response.ok) {
    throw new RequestError(401, "GITHUB_TOKEN_EXCHANGE_FAILED", "GitHub verification failed.");
  }
  const payload = (await response.json()) as GitHubTokenResponse;
  if (!payload.access_token) {
    console.error("[registry] GitHub token exchange failed", {
      error: payload.error,
      errorDescription: payload.error_description,
      clientId: config.githubApp.clientId,
      appSlug: config.githubApp.appSlug,
    });
    throw new RequestError(
      401,
      "GITHUB_TOKEN_EXCHANGE_FAILED",
      "GitHub verification failed. The registry verifier app credentials may be misconfigured.",
    );
  }
  return payload.access_token;
}

async function fetchGitHubUser(accessToken: string) {
  const response = await githubFetch("/user", accessToken);
  if (!response.ok) throw new RequestError(401, "GITHUB_IDENTITY_FAILED", "GitHub identity verification failed.");
  return (await response.json()) as GitHubUser;
}

async function findUserInstallationRepository(
  accessToken: string,
  sourceRepository: SourceRepository,
) {
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubFetch(`/user/installations?per_page=100&page=${page}`, accessToken);
    if (!response.ok) {
      throw new RequestError(401, "GITHUB_INSTALLATIONS_FAILED", "GitHub installation lookup failed.");
    }
    const payload = (await response.json()) as GitHubPaged<GitHubInstallation>;
    const installations = payload.installations ?? [];
    for (const installation of installations) {
      if (!installation.id) continue;
      const repo = await findRepositoryInInstallation(accessToken, installation.id, sourceRepository);
      if (repo) return repo;
    }
    if (installations.length < 100) break;
  }
  return null;
}

async function findRepositoryInInstallation(
  accessToken: string,
  installationId: number,
  sourceRepository: SourceRepository,
) {
  const expected = sourceRepository.fullName.toLowerCase();
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubFetch(
      `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      accessToken,
    );
    if (!response.ok) {
      throw new RequestError(401, "GITHUB_REPOSITORIES_FAILED", "GitHub repository lookup failed.");
    }
    const payload = (await response.json()) as GitHubPaged<GitHubRepository>;
    const repositories = payload.repositories ?? [];
    const repo = repositories.find((candidate) => candidate.full_name?.toLowerCase() === expected);
    if (repo) return repo;
    if (repositories.length < 100) break;
  }
  return null;
}

function githubFetch(path: string, accessToken: string) {
  return fetch(`${githubApiUrl}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gascity-registry",
    },
  });
}

function verifyWebhookSignature(body: string, signature: string | null, secret: string) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isGitHubName(value: string) {
  return /^[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith(".") && !value.endsWith(".");
}

function repositoryIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "number" && Number.isFinite(id)) ids.push(String(id));
    if (typeof id === "string" && /^\d+$/.test(id)) ids.push(id);
  }
  return [...new Set(ids)];
}
