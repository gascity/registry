import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { ServerConfig } from "./config";
import { pkceChallenge, randomToken, signValue, verifySignedValue } from "./crypto";
import { appendCookie, cookiePath, parseCookies, redirect, safeRedirectPath } from "./http";
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

export type LoginOptions = { staff?: boolean };

export async function startLogin(request: Request, config: ServerConfig, opts: LoginOptions = {}) {
  if (!config.authProvider) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Registry sign-in is not configured.");
  }
  if (config.authProvider === "workos") return startWorkosLogin(request, config);
  return startOidcLogin(request, config, opts);
}

async function startOidcLogin(request: Request, config: ServerConfig, opts: LoginOptions = {}) {
  if (!config.oidc) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Registry sign-in is not configured.");
  }
  const url = new URL(request.url);
  const redirectTo = safeRedirectPath(config, url.searchParams.get("redirect"));
  // Pin the IdP so the customer login skips Keycloak's chooser entirely (straight to GitHub),
  // and /staff (or ?idp=staff) goes straight to Gas City SSO. Unset hints = legacy chooser.
  const wantStaff = opts.staff || url.searchParams.get("idp") === "staff";
  const idpHint = wantStaff ? config.oidc.staffIdpHint : config.oidc.idpHint;
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
  if (idpHint) authorizationUrl.searchParams.set("kc_idp_hint", idpHint);

  const headers = new Headers();
  appendCookie(headers, oauthCookie, signValue(JSON.stringify(state), config.sessionSecret), {
    httpOnly: true,
    secure: config.isProduction,
    // SameSite=None (prod) so the cookie survives the cross-site OAuth callback when the
    // registry is framed in the apex shell (works.gascity.com/registry). Requires Secure.
    sameSite: config.isProduction ? "None" : "Lax",
    maxAge: oauthMaxAgeSeconds,
    path: cookiePath(config),
  });
  return redirect(authorizationUrl.toString(), headers);
}

async function startWorkosLogin(request: Request, config: ServerConfig) {
  if (!config.workos) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Registry sign-in is not configured.");
  }
  const url = new URL(request.url);
  const redirectTo = safeRedirectPath(config, url.searchParams.get("redirect"));
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
    // SameSite=None (prod) so the cookie survives the cross-site OAuth callback when the
    // registry is framed in the apex shell (works.gascity.com/registry). Requires Secure.
    sameSite: config.isProduction ? "None" : "Lax",
    maxAge: oauthMaxAgeSeconds,
    path: cookiePath(config),
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
    path: cookiePath(config),
  });
  appendCookie(headers, oauthCookie, "", {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax",
    maxAge: 0,
    path: cookiePath(config),
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
  // Enforce the signed ID-token boundary before making the optional userinfo request. Userinfo is
  // profile enrichment only and must never participate in broker or authorization decisions.
  const verifiedBroker = verifyOidcBrokerBoundary(claims, config);
  const userInfo = tokenPayload.access_token
    ? await fetchUserInfo(discovery, tokenPayload.access_token)
    : {};
  return buildIdentityFromOidcTokenResponse(claims, userInfo, config, verifiedBroker);
}

// Build the identity from an OIDC token response. Only an explicit allowlist of PROFILE fields is
// read from userinfo; identity keys, email, broker source, and privilege-bearing realm roles come
// from the cryptographically VERIFIED ID token. Kept pure and directly tested below.
export function identityFromOidcTokenResponse(
  claims: JWTPayload,
  userInfo: JWTPayload,
  config: ServerConfig,
): IdentityClaims {
  return buildIdentityFromOidcTokenResponse(
    claims,
    userInfo,
    config,
    verifyOidcBrokerBoundary(claims, config),
  );
}

type VerifiedBroker = "github" | "gascity-sso" | "customer-sso";

function verifyOidcBrokerBoundary(
  claims: JWTPayload,
  config: ServerConfig,
): VerifiedBroker | null {
  if (!config.oidc?.enforceBrokerBoundary) return null;
  return enforceVerifiedBrokerBoundary(claims);
}

function buildIdentityFromOidcTokenResponse(
  claims: JWTPayload,
  userInfo: JWTPayload,
  config: ServerConfig,
  verifiedBroker: VerifiedBroker | null,
): IdentityClaims {
  const identity = identityProfileFromVerifiedClaims(claims, config);
  if (userInfo.sub !== undefined && userInfo.sub !== identity.subject) {
    throw new AuthError(401, "BAD_USERINFO", "Sign-in profile verification failed.");
  }

  // Explicit profile allowlist: identity keys, email, and authorization always remain the values
  // from the cryptographically verified ID token.
  const userInfoUsername = stringClaim(userInfo.preferred_username);
  const userInfoName = stringClaim(userInfo.name);
  const userInfoPicture = stringClaim(userInfo.picture);
  if (userInfoUsername) identity.handle = userInfoUsername;
  if (userInfoName) identity.displayName = userInfoName;
  if (userInfoPicture) identity.avatarUrl = userInfoPicture;

  const verifiedRoles = realmRoles(claims);
  const privilegedRoleSourceAllowed = verifiedBroker === null || verifiedBroker === GASCITY_SSO_IDP;
  identity.assertedAdmin =
    privilegedRoleSourceAllowed && verifiedRoles.includes(STAFF_REALM_ROLE);
  identity.assertedOrgMember =
    privilegedRoleSourceAllowed && verifiedRoles.includes(REGISTRY_MEMBER_REALM_ROLE);
  return identity;
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
    // Dev mirror of the OIDC registry-member realm-role assertion; live-synced like prod.
    assertedOrgMember: url.searchParams.get("orgMember") === "1",
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
    path: cookiePath(config),
  });
  return redirect(safeRedirectPath(config, url.searchParams.get("redirect")), headers);
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
    path: cookiePath(config),
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

// These are persistent Keycloak user roles, not current-login provenance. The OIDC identity
// builder may turn them into Registry assertions only after the broker-session boundary is
// verified (or when that Gas City-specific boundary is explicitly disabled for generic OIDC).
// registry-staff promotes a user to Registry admin.
const STAFF_REALM_ROLE = "registry-staff";

// registry-member marks a verified @gascity org member. It is live-synced in ensureUser (unlike
// the promote-only staff role), so losing the trusted assertion de-provisions on the next login.
const REGISTRY_MEMBER_REALM_ROLE = "registry-member";

const GITHUB_IDP = "github";
const GASCITY_SSO_IDP = "gascity-sso";

// Keycloak records the broker used for this exact login in its core `identity_provider`
// user-session note; the customer realm maps that note into the Registry ID token as
// `idp_connection`. Unlike a user attribute or userinfo, this claim is tied to the current broker
// session and covered by the realm's token signature.
// GitHub plus canonical/grandfathered sso-* aliases are customer rails; gascity-sso is the only
// staff rail. Fail closed when provenance is absent or unknown: a persistent privileged role must
// never turn a later customer login into a staff login.
function enforceVerifiedBrokerBoundary(claims: JWTPayload): VerifiedBroker {
  const broker = exactStringClaim(claims.idp_connection);
  if (!broker) {
    throw new AuthError(
      401,
      "BAD_ID_TOKEN",
      "Sign-in identity provider could not be verified.",
    );
  }

  const verifiedBroker = classifyVerifiedBroker(broker);

  const verifiedRoles = strictRealmRoles(claims);
  const carriesRegistryPrivilege =
    verifiedRoles.includes(STAFF_REALM_ROLE) ||
    verifiedRoles.includes(REGISTRY_MEMBER_REALM_ROLE);
  if (verifiedBroker !== GASCITY_SSO_IDP && carriesRegistryPrivilege) {
    throw new AuthError(
      403,
      "STAFF_SSO_REQUIRED",
      "Gas City staff and organization members sign in with Gas City SSO, not a customer identity provider — go to registry.gascity.com/staff.",
    );
  }

  if (verifiedBroker === GITHUB_IDP) {
    const email = exactStringClaim(claims.email);
    if (!email || claims.email_verified !== true) {
      throw new AuthError(
        401,
        "BAD_ID_TOKEN",
        "Sign-in identity is missing a trusted email address.",
      );
    }
    if (hasGasCityStaffEmailShape(email)) {
      throw new AuthError(
        403,
        "STAFF_SSO_REQUIRED",
        "Gas City staff sign in with Gas City SSO, not GitHub — go to registry.gascity.com/staff.",
      );
    }
    return GITHUB_IDP;
  }

  if (verifiedBroker === GASCITY_SSO_IDP) {
    const email = exactStringClaim(claims.email);
    if (
      !email ||
      claims.email_verified !== true ||
      !isCanonicalGasCityStaffEmail(email) ||
      !hostedDomainMatchesEmail(claims.hd, email) ||
      !verifiedRoles.includes(STAFF_REALM_ROLE)
    ) {
      throw new AuthError(
        403,
        "STAFF_SSO_REQUIRED",
        "Gas City staff sign in with Gas City SSO — go to registry.gascity.com/staff.",
      );
    }
    return GASCITY_SSO_IDP;
  }

  if (verifiedBroker === "customer-sso") {
    const email = exactStringClaim(claims.email);
    if (!email) {
      throw new AuthError(
        401,
        "BAD_ID_TOKEN",
        "Sign-in identity is missing an email address.",
      );
    }
    if (claims.email_verified === true && hasGasCityStaffEmailShape(email)) {
      throw new AuthError(
        403,
        "STAFF_SSO_REQUIRED",
        "Gas City staff sign in with Gas City SSO — go to registry.gascity.com/staff.",
      );
    }
    return "customer-sso";
  }

  throw new AuthError(
    401,
    "BAD_ID_TOKEN",
    "Sign-in identity provider could not be verified.",
  );
}

function hasGasCityStaffEmailShape(email: string) {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domain === "gascity.com" || domain === "gascity.com.";
}

function isCanonicalGasCityStaffEmail(email: string) {
  const at = email.lastIndexOf("@");
  if (at <= 0 || /[\t\n\r ]/.test(email.slice(0, at))) return false;
  return email.slice(at + 1).toLowerCase() === "gascity.com";
}

function hostedDomainMatchesEmail(hostedDomainClaim: unknown, email: string) {
  if (hostedDomainClaim === undefined || hostedDomainClaim === null) return true;
  if (typeof hostedDomainClaim !== "string") return false;
  const hostedDomain = hostedDomainClaim.trim().toLowerCase();
  if (!hostedDomain) return true;
  return hostedDomain === email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function isCustomerSsoBroker(broker: string) {
  if (
    /^sso-org_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      broker,
    )
  ) {
    return true;
  }
  return /^sso-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(broker);
}

function classifyVerifiedBroker(broker: string): VerifiedBroker {
  if (broker === GITHUB_IDP || broker === GASCITY_SSO_IDP) return broker;
  if (isCustomerSsoBroker(broker)) return "customer-sso";
  throw new AuthError(
    401,
    "BAD_ID_TOKEN",
    "Sign-in identity provider could not be verified.",
  );
}

// Keycloak emits realm roles as { realm_access: { roles: string[] } }. Read it defensively:
// the claim is attacker-influenced shape-wise (it arrives in a token), so narrow every level.
function realmRoles(claims: JWTPayload): string[] {
  const realmAccess = claims.realm_access;
  if (!realmAccess || typeof realmAccess !== "object") return [];
  const roles = (realmAccess as { roles?: unknown }).roles;
  if (!Array.isArray(roles)) return [];
  return roles.filter((role): role is string => typeof role === "string");
}

function strictRealmRoles(claims: JWTPayload): string[] {
  const realmAccess = claims.realm_access;
  if (realmAccess === undefined || realmAccess === null) return [];
  if (typeof realmAccess !== "object" || Array.isArray(realmAccess)) {
    throw new AuthError(401, "BAD_ID_TOKEN", "Sign-in authorization claims are malformed.");
  }
  const roles = (realmAccess as { roles?: unknown }).roles;
  if (roles === undefined) return [];
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string")) {
    throw new AuthError(401, "BAD_ID_TOKEN", "Sign-in authorization claims are malformed.");
  }
  return roles;
}

function identityProfileFromVerifiedClaims(
  claims: JWTPayload,
  config: ServerConfig,
): IdentityClaims {
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

function exactStringClaim(value: unknown) {
  return typeof value === "string" && value !== "" && value.trim() === value
    ? value
    : undefined;
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
  // Browser-visible callback: under the apex the IdP must return to
  // https://works.gascity.com/registry/api/auth/callback (the edge strips
  // /registry so the server still routes /api/auth/callback at root). Must
  // byte-match the value sent on the authorize request and the token exchange.
  return `${config.appUrl}${config.mountBase}/api/auth/callback`;
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
