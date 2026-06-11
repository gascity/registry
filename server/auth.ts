import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { ServerConfig } from "./config";
import { pkceChallenge, randomToken, signValue, verifySignedValue } from "./crypto";
import { appendCookie, parseCookies, redirect, safeRedirectPath } from "./http";
import { parseBearerToken } from "./tokens";
import type { ApiTokenAuthResult, IdentityClaims, RegistryStore, SessionRecord } from "./types";

const sessionCookie = "registry_session";
const oauthCookie = "registry_oauth";
const oauthMaxAgeSeconds = 10 * 60;
const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;

type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  issuer: string;
};

type OAuthState = {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectTo: string;
  createdAt: number;
};

let cachedDiscovery: { issuer: string; discovery: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> } | null =
  null;

export function getSessionCookie(request: Request) {
  return parseCookies(request).get(sessionCookie);
}

export async function getRequestSession(
  request: Request,
  store: RegistryStore,
): Promise<SessionRecord | null> {
  const token = getSessionCookie(request);
  if (!token) return null;
  return await store.getSession(token);
}

export async function getRequestApiTokenAuth(
  request: Request,
  store: RegistryStore,
): Promise<ApiTokenAuthResult | null> {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  const token = parseBearerToken(header);
  if (!token) return null;
  return await store.getUserForApiToken(token);
}

export function requireCsrf(request: Request, session: SessionRecord | null) {
  if (!session) throw new AuthError(401, "UNAUTHENTICATED", "Sign in required.");
  const csrf = request.headers.get("x-csrf-token");
  if (!csrf || csrf !== session.csrfToken) {
    throw new AuthError(403, "BAD_CSRF", "Request verification failed.");
  }
}

export async function startLogin(request: Request, config: ServerConfig) {
  if (!config.authProvider) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Registry sign-in is not configured.");
  }
  if (config.authProvider === "workos") return startWorkosLogin(request, config);
  return startOidcLogin(request, config);
}

async function startOidcLogin(request: Request, config: ServerConfig) {
  if (!config.oidc) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Registry sign-in is not configured.");
  }
  const url = new URL(request.url);
  const redirectTo = safeRedirectPath(url.searchParams.get("redirect"));
  const state: OAuthState = {
    state: randomToken(18),
    nonce: randomToken(18),
    codeVerifier: randomToken(48),
    redirectTo,
    createdAt: Date.now(),
  };
  const discovery = await getDiscovery(config);
  const authorizationUrl = new URL(discovery.authorization_endpoint);
  authorizationUrl.searchParams.set("client_id", config.oidc.clientId);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", "openid email profile");
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl(config));
  authorizationUrl.searchParams.set("state", state.state);
  authorizationUrl.searchParams.set("nonce", state.nonce);
  authorizationUrl.searchParams.set("code_challenge", pkceChallenge(state.codeVerifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  const headers = new Headers();
  appendCookie(headers, oauthCookie, signValue(JSON.stringify(state), config.sessionSecret), {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax",
    maxAge: oauthMaxAgeSeconds,
    path: "/",
  });
  return redirect(authorizationUrl.toString(), headers);
}

async function startWorkosLogin(request: Request, config: ServerConfig) {
  if (!config.workos) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Registry sign-in is not configured.");
  }
  const url = new URL(request.url);
  const redirectTo = safeRedirectPath(url.searchParams.get("redirect"));
  const state: OAuthState = {
    state: randomToken(18),
    nonce: "",
    codeVerifier: "",
    redirectTo,
    createdAt: Date.now(),
  };
  const authorizationUrl = new URL(`${config.workos.apiBaseUrl}/user_management/authorize`);
  authorizationUrl.searchParams.set("provider", "authkit");
  authorizationUrl.searchParams.set("client_id", config.workos.clientId);
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl(config));
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("state", state.state);

  const headers = new Headers();
  appendCookie(headers, oauthCookie, signValue(JSON.stringify(state), config.sessionSecret), {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax",
    maxAge: oauthMaxAgeSeconds,
    path: "/",
  });
  return redirect(authorizationUrl.toString(), headers);
}

export async function finishLogin(request: Request, config: ServerConfig, store: RegistryStore) {
  if (!config.authProvider) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Registry sign-in is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new AuthError(400, "BAD_CALLBACK", "OAuth callback is incomplete.");

  const rawState = parseCookies(request).get(oauthCookie);
  const verified = rawState ? verifySignedValue(rawState, config.sessionSecret) : null;
  if (!verified) throw new AuthError(400, "BAD_CALLBACK", "OAuth state is missing.");
  const oauthState = JSON.parse(verified) as OAuthState;
  if (oauthState.state !== state || Date.now() - oauthState.createdAt > oauthMaxAgeSeconds * 1000) {
    throw new AuthError(400, "BAD_CALLBACK", "OAuth state is invalid.");
  }

  const identity =
    config.authProvider === "workos"
      ? await finishWorkosLogin(request, config, code)
      : await finishOidcLogin(config, code, oauthState);
  const user = await store.ensureUser(identity);
  const session = await store.createSession(user.id);

  const headers = new Headers();
  appendCookie(headers, sessionCookie, session.token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax",
    maxAge: sessionMaxAgeSeconds,
    path: "/",
  });
  appendCookie(headers, oauthCookie, "", {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax",
    maxAge: 0,
    path: "/",
  });
  return redirect(oauthState.redirectTo, headers);
}

async function finishOidcLogin(config: ServerConfig, code: string, oauthState: OAuthState) {
  if (!config.oidc) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Registry sign-in is not configured.");
  }
  const discovery = await getDiscovery(config);
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${config.oidc.clientId}:${config.oidc.clientSecret}`,
      ).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(config),
      code_verifier: oauthState.codeVerifier,
    }),
  });
  if (!tokenResponse.ok) {
    throw new AuthError(401, "TOKEN_EXCHANGE_FAILED", "Sign-in failed.");
  }
  const tokenPayload = (await tokenResponse.json()) as {
    id_token?: string;
    access_token?: string;
  };
  if (!tokenPayload.id_token) throw new AuthError(401, "TOKEN_EXCHANGE_FAILED", "Sign-in failed.");

  const claims = await verifyIdToken(tokenPayload.id_token, config, oauthState.nonce);
  const userInfo = tokenPayload.access_token
    ? await fetchUserInfo(discovery, tokenPayload.access_token)
    : {};
  return identityFromClaims({ ...claims, ...userInfo }, config);
}

async function finishWorkosLogin(request: Request, config: ServerConfig, code: string) {
  if (!config.workos) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Registry sign-in is not configured.");
  }
  const response = await fetch(`${config.workos.apiBaseUrl}/user_management/authenticate`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.workos.apiKey}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: config.workos.clientId,
      client_secret: config.workos.apiKey,
      code,
      user_agent: request.headers.get("user-agent"),
      ip_address: clientIp(request),
    }),
  });
  if (!response.ok) {
    throw new AuthError(401, "TOKEN_EXCHANGE_FAILED", "Sign-in failed.");
  }
  const payload = (await response.json()) as {
    user?: WorkosUser;
    organization_id?: string | null;
  };
  if (!payload.user?.id) throw new AuthError(401, "TOKEN_EXCHANGE_FAILED", "Sign-in failed.");
  return identityFromWorkos(payload.user, payload.organization_id ?? undefined);
}

export async function createDevSession(request: Request, config: ServerConfig, store: RegistryStore) {
  if (!config.devAuthEnabled) {
    throw new AuthError(404, "NOT_FOUND", "Not found.");
  }
  const url = new URL(request.url);
  const handle = url.searchParams.get("handle")?.trim() || "local";
  let user = await store.ensureUser({
    subject: `dev:${handle}`,
    gasCityUserId: `dev:${handle}`,
    handle,
    displayName: handle === "local" ? "Local Developer" : handle,
    email: `${handle}@dev.registry.local`,
  });
  const requestedRole = url.searchParams.get("role")?.trim().toLowerCase();
  if (requestedRole === "admin" || requestedRole === "moderator" || requestedRole === "user") {
    user = await store.setUserRoleForDev(user.id, requestedRole);
  }
  const session = await store.createSession(user.id);
  const headers = new Headers();
  appendCookie(headers, sessionCookie, session.token, {
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    maxAge: sessionMaxAgeSeconds,
    path: "/",
  });
  return redirect(safeRedirectPath(url.searchParams.get("redirect")), headers);
}

export async function clearSession(request: Request, config: ServerConfig, store: RegistryStore) {
  const token = getSessionCookie(request);
  if (token) await store.destroySession(token);
  const headers = new Headers();
  appendCookie(headers, sessionCookie, "", {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax",
    maxAge: 0,
    path: "/",
  });
  return new Response(null, { status: 204, headers });
}

async function getDiscovery(config: ServerConfig) {
  if (!config.oidc) throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Auth is not configured.");
  if (cachedDiscovery?.issuer === config.oidc.issuer) return cachedDiscovery.discovery;
  const response = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new AuthError(503, "DISCOVERY_FAILED", "Auth discovery failed.");
  const discovery = (await response.json()) as Discovery;
  cachedDiscovery = {
    issuer: config.oidc.issuer,
    discovery,
    jwks: createRemoteJWKSet(new URL(discovery.jwks_uri)),
  };
  return discovery;
}

async function verifyIdToken(idToken: string, config: ServerConfig, nonce: string) {
  if (!config.oidc) throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Auth is not configured.");
  await getDiscovery(config);
  if (!cachedDiscovery) throw new AuthError(503, "DISCOVERY_FAILED", "Auth discovery failed.");
  const { payload } = await jwtVerify(idToken, cachedDiscovery.jwks, {
    issuer: config.oidc.issuer,
    audience: config.oidc.clientId,
  });
  if (payload.nonce !== nonce) {
    throw new AuthError(401, "BAD_ID_TOKEN", "Sign-in verification failed.");
  }
  return payload;
}

async function fetchUserInfo(discovery: Discovery, accessToken: string): Promise<JWTPayload> {
  if (!discovery.userinfo_endpoint) return {};
  const response = await fetch(discovery.userinfo_endpoint, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) return {};
  return (await response.json()) as JWTPayload;
}

function identityFromClaims(claims: JWTPayload, config: ServerConfig): IdentityClaims {
  if (!config.oidc) throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Auth is not configured.");
  if (!claims.sub) throw new AuthError(401, "BAD_ID_TOKEN", "Sign-in verification failed.");
  const gasCityUserId = stringClaim(claims[config.oidc.gasCityUserIdClaim]);
  if (!gasCityUserId) {
    throw new AuthError(401, "BAD_ID_TOKEN", "Sign-in identity is missing a Gas City user ID.");
  }
  const preferredUsername = stringClaim(claims.preferred_username);
  const email = stringClaim(claims.email);
  return {
    subject: claims.sub,
    gasCityUserId,
    gasCityAccountId: config.oidc.gasCityAccountIdClaim
      ? stringClaim(claims[config.oidc.gasCityAccountIdClaim])
      : undefined,
    email,
    handle: preferredUsername ?? email?.split("@")[0],
    displayName: stringClaim(claims.name) ?? preferredUsername,
    avatarUrl: stringClaim(claims.picture),
  };
}

type WorkosUser = {
  id: string;
  email?: string;
  first_name?: string | null;
  last_name?: string | null;
  profile_picture_url?: string | null;
};

function identityFromWorkos(user: WorkosUser, organizationId?: string | null): IdentityClaims {
  const displayName = [user.first_name, user.last_name]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ");
  const email = stringClaim(user.email);
  return {
    subject: `workos:${user.id}`,
    gasCityUserId: user.id,
    gasCityAccountId: stringClaim(organizationId),
    email,
    handle: email?.split("@")[0],
    displayName: displayName || email,
    avatarUrl: stringClaim(user.profile_picture_url),
  };
}

function stringClaim(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clientIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    undefined
  );
}

function callbackUrl(config: ServerConfig) {
  return `${config.appUrl}/api/auth/callback`;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
