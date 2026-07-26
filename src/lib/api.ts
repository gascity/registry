import { useCallback, useEffect, useMemo, useState } from "react";
import { withBase } from "./base";

export type PublicUser = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  email?: string;
  role: "admin" | "moderator" | "user";
};

export type AuthState = {
  user: PublicUser | null;
  csrfToken: string | null;
  authConfigured: boolean;
  authProvider?: "oidc" | "workos" | null;
  devAuthEnabled: boolean;
  store?: "file" | "postgres";
};

export type ApiTokenRow = {
  id: string;
  label: string;
  prefix: string;
  kind: "personal" | "github_actions_publish";
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export type ApiTokenCreateResult = ApiTokenRow & {
  token: string;
};

export type ReviewRow = {
  id: string;
  packKey: string;
  rating: number;
  title?: string;
  body: string;
  recommend: boolean;
  createdAt: string;
  updatedAt: string;
  user: PublicUser;
  viewerCanDelete: boolean;
};

export type ReviewListResult = {
  summary: {
    count: number;
    averageRating: number | null;
    recommendCount: number;
  };
  reviews: ReviewRow[];
  viewerReview: ReviewRow | null;
  viewerHasStarred: boolean;
};

export type ReviewInput = {
  packKey: string;
  rating: number;
  title?: string;
  body: string;
  recommend: boolean;
};

export type PackOwnership = {
  packKey: string;
  sourceUrl: string;
  sourceRepository?: {
    host: "github.com";
    owner: string;
    name: string;
    fullName: string;
  };
  verificationStatus: "unverified" | "verified";
  verificationMethod?: "github_app_user_token" | "manual";
  publisher?: {
    id: string;
    handle: string;
    displayName: string;
    kind: "user" | "org";
    trusted: boolean;
    githubOwnerLogin?: string;
    githubOwnerId?: string;
  };
  verifiedAt?: string;
  githubApp?: {
    configured: boolean;
    installUrl?: string;
    clientId?: string;
  };
};

export type PublishRequestStatus =
  | "pending_validation"
  | "validation_failed"
  | "pending_review"
  | "approved"
  | "rejected"
  | "withdrawn";

export type PublishSubmissionMethod =
  | "web_session"
  | "api_token"
  | "github_actions_oidc"
  | "github_import";

export type PublishRegistryEntry = {
  name: string;
  description: string;
  source: string;
  sourceKind: "git";
  release: {
    version: string;
    ref: string;
    commit: string;
    hash: string;
    description: string;
  };
};

export type PublishRequestRow = {
  id: string;
  status: PublishRequestStatus;
  repository: {
    host: "github.com";
    owner: string;
    name: string;
    fullName: string;
  };
  repoUrl: string;
  sourceUrl: string;
  packPath: string;
  commit: string;
  requestedName: string;
  requestedVersion: string;
  requestedRef?: string;
  requestedDescription?: string;
  registryEntry?: PublishRegistryEntry;
  validationError?: string;
  validatedAt?: string;
  statusReason?: string;
  reviewedAt?: string;
  reviewedBy?: PublicUser;
  createdAt: string;
  updatedAt: string;
  submittedBy: PublicUser;
  submissionMethod?: PublishSubmissionMethod;
  sourceGithubRepositoryId?: string;
  sourceGithubOwnerId?: string;
};

export type GitHubPublishCandidate = {
  id: string;
  repository: {
    id: string;
    fullName: string;
    owner: string;
    name: string;
    htmlUrl: string;
    defaultBranch: string;
    permission: "admin" | "maintain" | "push";
  };
  branch: string;
  commit: string;
  packPath: string;
  packTomlPath: string;
  pack: {
    name: string;
    version?: string;
    description?: string;
  };
  warnings: string[];
};

export type GitHubPublishImportRow = {
  id: string;
  userId: string;
  repositoriesScanned: number;
  privateRepositoriesSkipped: number;
  candidates: GitHubPublishCandidate[];
  scanErrors: string[];
  truncated: boolean;
  expiresAt: string;
  createdAt: string;
};

const signedOutState: AuthState = {
  user: null,
  csrfToken: null,
  authConfigured: false,
  devAuthEnabled: false,
};

export function useAuthState() {
  const [auth, setAuth] = useState<AuthState>(signedOutState);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(withBase("/api/me"), { headers: { Accept: "application/json" } });
      if (!response.ok) {
        setAuth(signedOutState);
        return;
      }
      setAuth((await response.json()) as AuthState);
    } catch {
      setAuth(signedOutState);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const actions = useMemo(
    () => ({
      signIn(redirectTo?: unknown) {
        window.location.href = `${withBase("/api/auth/login")}?redirect=${encodeURIComponent(authRedirectTarget(redirectTo))}`;
      },
      devSignIn(redirectTo?: unknown) {
        window.location.href = `${withBase("/api/dev/sign-in")}?redirect=${encodeURIComponent(authRedirectTarget(redirectTo))}`;
      },
      async signOut() {
        await apiRequest("/api/auth/logout", { method: "POST" }, auth.csrfToken);
        setAuth(signedOutState);
      },
      refresh,
    }),
    [auth.csrfToken, refresh],
  );

  return { auth, isLoading, ...actions };
}

// Carries the server's machine-readable error code alongside the message, so callers can branch on
// the code instead of pattern-matching prose. Extends Error on purpose: every existing
// `err instanceof Error ? err.message : …` call site keeps working untouched.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly publishRequest?: PublishRequestRow,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  csrfToken?: string | null,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(withBase(path), { ...init, headers });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof data?.error?.message === "string" ? data.error.message : "Request failed.";
    // "UNKNOWN" when the body was not our { error: { code, message } } envelope (a proxy error
    // page, say) — a code-based branch must never fire on a response the server did not shape.
    const code = typeof data?.error?.code === "string" ? data.error.code : "UNKNOWN";
    const publishRequest =
      data &&
      typeof data === "object" &&
      "publishRequest" in data &&
      data.publishRequest &&
      typeof data.publishRequest === "object"
        ? (data.publishRequest as PublishRequestRow)
        : undefined;
    throw new ApiError(response.status, code, message, publishRequest);
  }
  return data as T;
}

export function currentPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function authRedirectTarget(value: unknown) {
  return typeof value === "string" ? value : currentPath();
}
