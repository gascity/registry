import { useCallback, useEffect, useMemo, useState } from "react";

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
  devAuthEnabled: boolean;
  store?: "file" | "postgres";
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
      const response = await fetch("/api/me", { headers: { Accept: "application/json" } });
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
      signIn(redirectTo = currentPath()) {
        window.location.href = `/api/auth/login?redirect=${encodeURIComponent(redirectTo)}`;
      },
      devSignIn(redirectTo = currentPath()) {
        window.location.href = `/api/dev/sign-in?redirect=${encodeURIComponent(redirectTo)}`;
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

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  csrfToken?: string | null,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof data?.error?.message === "string" ? data.error.message : "Request failed.";
    throw new Error(message);
  }
  return data as T;
}

export function currentPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}
