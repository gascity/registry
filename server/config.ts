export type ServerConfig = {
  port: number;
  appUrl: string;
  // The mount prefix this deploy is framed under: "" standalone, "/registry"
  // under the apex (works.gascity.com/registry/). Used for cookie Path scoping
  // and the OIDC redirect_uri; appUrl stays a BARE ORIGIN.
  mountBase: string;
  sessionSecret: string;
  databaseUrl?: string;
  localDataPath: string;
  eia?: {
    issuer: string;
    audience: "registry";
    jwksUrl: string;
  };
  accountsIdentityResolver?: {
    baseUrl: string;
    token: string;
    timeoutMs: number;
  };
  authProvider?: "oidc" | "workos";
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    gasCityUserIdClaim: string;
    gasCityAccountIdClaim?: string;
    // kc_idp_hint pinned for the default product login (customers skip the IdP chooser and go
    // straight to this IdP) and for the /staff entry. Unset = show the chooser (legacy behavior).
    idpHint?: string;
    staffIdpHint?: string;
    // Gas City production requires a signed, per-session Keycloak broker-source claim. Generic
    // OIDC deployments default this off because they do not share that realm contract.
    enforceBrokerBoundary: boolean;
  };
  workos?: {
    apiBaseUrl: string;
    apiKey: string;
    clientId: string;
  };
  githubApp?: {
    appSlug: string;
    clientId: string;
    clientSecret: string;
    webhookSecret?: string;
  };
  publishValidation: {
    gcBin: string;
    timeoutMs: number;
  };
  isProduction: boolean;
  devAuthEnabled: boolean;
  // Arms unattended approval of repeat releases. FAIL-CLOSED and read as `=== true`, so anything
  // other than an explicit REGISTRY_PUBLISH_AUTO_APPROVE=1 leaves every release in the staff queue.
  // Required (not optional) on purpose: this removes a human from a security boundary, so a new
  // ServerConfig literal has to state its answer rather than inherit one.
  publishAutoApprove: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const port = Number.parseInt(env.PORT ?? "8080", 10);
  const isProduction = env.NODE_ENV === "production" || Boolean(env.RAILWAY_ENVIRONMENT);
  const appUrl = trimTrailingSlash(
    env.APP_URL ??
      (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "http://127.0.0.1:8080"),
  );
  // "" standalone, "/registry" under the apex mount. Dev fallback only — in a
  // built server it's overridden from the dist asset prefix (the single source of
  // truth, so the cookie Path can never disagree with the client). Normalize a
  // fat-fingered value missing its leading slash.
  let mountBase = trimTrailingSlash(env.REGISTRY_MOUNT_BASE?.trim() ?? "");
  if (mountBase && !mountBase.startsWith("/")) mountBase = `/${mountBase}`;
  const sessionSecret = env.SESSION_SECRET?.trim() || "dev-insecure-registry-session-secret";
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (isProduction && sessionSecret === "dev-insecure-registry-session-secret") {
    throw new Error("SESSION_SECRET must be set in production.");
  }
  if (isProduction && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters in production.");
  }
  if (isProduction && !databaseUrl) {
    throw new Error("DATABASE_URL must be set in production.");
  }
  const issuer = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim();
  const gasCityUserIdClaim = env.OIDC_GASCITY_USER_ID_CLAIM?.trim() || "sub";
  const gasCityAccountIdClaim = env.OIDC_GASCITY_ACCOUNT_ID_CLAIM?.trim() || undefined;
  const idpHint = env.OIDC_IDP_HINT?.trim() || undefined;
  const staffIdpHint = env.OIDC_STAFF_IDP_HINT?.trim() || undefined;
  const enforceBrokerBoundary = env.OIDC_ENFORCE_BROKER_BOUNDARY?.trim().toLowerCase() === "true";
  const workosApiKey = env.WORKOS_API_KEY?.trim();
  const workosClientId = env.WORKOS_CLIENT_ID?.trim();
  const workosApiBaseUrl = trimTrailingSlash(env.WORKOS_API_BASE_URL?.trim() || "https://api.workos.com");
  const githubAppSlug = env.GITHUB_APP_SLUG?.trim();
  const githubAppClientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const githubAppClientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const githubAppWebhookSecret = env.GITHUB_APP_WEBHOOK_SECRET?.trim();
  const eiaIssuer = env.REGISTRY_EIA_ISSUER?.trim();
  const eiaJwksUrl = env.REGISTRY_EIA_JWKS_URL?.trim();
  if (Boolean(eiaIssuer) !== Boolean(eiaJwksUrl)) {
    throw new Error("REGISTRY_EIA_ISSUER and REGISTRY_EIA_JWKS_URL must be configured together.");
  }
  const accountsBaseUrlRaw = env.REGISTRY_ACCOUNTS_BASE_URL?.trim();
  const accountsResolverToken = env.REGISTRY_ACCOUNTS_RESOLVER_TOKEN?.trim();
  if (Boolean(accountsBaseUrlRaw) !== Boolean(accountsResolverToken)) {
    throw new Error(
      "REGISTRY_ACCOUNTS_BASE_URL and REGISTRY_ACCOUNTS_RESOLVER_TOKEN must be configured together.",
    );
  }
  const accountsBaseUrl = accountsBaseUrlRaw
    ? parseAccountsBaseUrl(accountsBaseUrlRaw)
    : undefined;
  if (accountsBaseUrl && hasAmbientProxy(env) && effectiveNoProxy(env).trim() !== "*") {
    throw new Error(
      "Accounts identity resolution requires no_proxy=* when proxy environment variables are set.",
    );
  }
  const accountsResolveTimeoutRaw = env.REGISTRY_ACCOUNTS_RESOLVE_TIMEOUT_MS?.trim() || "3000";
  const accountsResolveTimeoutMs = Number(accountsResolveTimeoutRaw);
  if (
    accountsBaseUrl &&
    (!/^\d+$/.test(accountsResolveTimeoutRaw) ||
      !Number.isSafeInteger(accountsResolveTimeoutMs) ||
      accountsResolveTimeoutMs <= 0)
  ) {
    throw new Error("REGISTRY_ACCOUNTS_RESOLVE_TIMEOUT_MS must be a positive integer.");
  }
  const publishValidationTimeoutMs = Number.parseInt(
    env.REGISTRY_PUBLISH_VALIDATION_TIMEOUT_MS ?? "120000",
    10,
  );
  const requestedAuthProvider = parseAuthProvider(env.REGISTRY_AUTH_PROVIDER);
  const oidc =
    issuer && clientId && clientSecret
      ? {
          issuer: trimTrailingSlash(issuer),
          clientId,
          clientSecret,
          gasCityUserIdClaim,
          gasCityAccountIdClaim,
          idpHint,
          staffIdpHint,
          enforceBrokerBoundary,
        }
      : undefined;
  const workos =
    workosApiKey && workosClientId
      ? {
          apiBaseUrl: workosApiBaseUrl,
          apiKey: workosApiKey,
          clientId: workosClientId,
        }
      : undefined;
  const authProvider = requestedAuthProvider
    ? requestedAuthProvider === "workos" && workos
      ? "workos"
      : requestedAuthProvider === "oidc" && oidc
        ? "oidc"
        : undefined
    : workos
      ? "workos"
      : oidc
        ? "oidc"
        : undefined;
  const githubApp =
    githubAppSlug && githubAppClientId && githubAppClientSecret
      ? {
          appSlug: githubAppSlug,
          clientId: githubAppClientId,
          clientSecret: githubAppClientSecret,
          webhookSecret: githubAppWebhookSecret || undefined,
        }
      : undefined;

  if (isProduction && !authProvider) {
    throw new Error(
      "An auth provider must be configured in production. Set REGISTRY_AUTH_PROVIDER=oidc (or workos) with its credentials.",
    );
  }

  // The dev sign-in backdoor (/api/dev/sign-in) mints arbitrary roles, so it FAILS CLOSED:
  // treat the environment as deployed unless it positively looks local — an EXPLICITLY set
  // loopback APP_URL and no deploy signal. A bare/misconfigured deploy (APP_URL unset so it
  // defaults to loopback, a platform env var, or an all-interfaces/public origin) is treated
  // as deployed and the backdoor stays off, even if REGISTRY_DEV_AUTH=1 was copied over.
  // (.env.example ships REGISTRY_DEV_AUTH=0; the local dev scripts set it + a loopback APP_URL.)
  const devAuthRequested = env.REGISTRY_DEV_AUTH === "1";
  const appUrlProvided = Boolean(env.APP_URL?.trim());
  const looksDeployed =
    isProduction ||
    Boolean(env.RAILWAY_ENVIRONMENT) ||
    Boolean(env.RAILWAY_PUBLIC_DOMAIN) ||
    Boolean(env.KUBERNETES_SERVICE_HOST) ||
    Boolean(env.FLY_APP_NAME) ||
    Boolean(env.RENDER) ||
    Boolean(env.DYNO) ||
    !appUrlProvided ||
    !isLoopbackUrl(appUrl);
  if (devAuthRequested && looksDeployed) {
    console.warn(
      "[registry] REGISTRY_DEV_AUTH=1 ignored: the dev sign-in backdoor arms only for a local run with an explicitly loopback APP_URL.",
    );
  }

  return {
    port: Number.isFinite(port) && port > 0 ? port : 8080,
    appUrl,
    mountBase,
    sessionSecret,
    databaseUrl,
    localDataPath: env.REGISTRY_DATA_PATH?.trim() || ".registry-data/registry.local.json",
    eia:
      eiaIssuer && eiaJwksUrl
        ? {
            issuer: trimTrailingSlash(eiaIssuer),
            audience: "registry",
            jwksUrl: eiaJwksUrl,
          }
        : undefined,
    accountsIdentityResolver:
      accountsBaseUrl && accountsResolverToken
        ? {
            baseUrl: accountsBaseUrl,
            token: accountsResolverToken,
            timeoutMs: accountsResolveTimeoutMs,
          }
        : undefined,
    authProvider,
    oidc,
    workos,
    githubApp,
    publishValidation: {
      gcBin: env.REGISTRY_GC_BIN?.trim() || "gc",
      timeoutMs:
        Number.isFinite(publishValidationTimeoutMs) && publishValidationTimeoutMs > 0
          ? publishValidationTimeoutMs
          : 120_000,
    },
    isProduction,
    devAuthEnabled: devAuthRequested && !looksDeployed,
    // Opt-in by deliberate decision, never by deploy: an unset, empty, "0", "true" or "yes" value
    // all leave it off. Default-on would arm the approval boundary for every publisher on the next
    // release with no production observation of the decline-reason counts first.
    publishAutoApprove: env.REGISTRY_PUBLISH_AUTO_APPROVE === "1",
  };
}

function isLoopbackUrl(value: string) {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
    // 0.0.0.0 and :: are all-interfaces BIND addresses, not loopback — a host reachable
    // there is reachable publicly, so they must never count as local. Only 127.0.0.0/8,
    // ::1, and localhost are genuine loopback.
    return host === "localhost" || host === "::1" || host.startsWith("127.");
  } catch {
    return false;
  }
}

function parseAuthProvider(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "oidc" || normalized === "workos" ? normalized : undefined;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function parseAccountsBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidAccountsBaseUrl();
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw invalidAccountsBaseUrl();
  }
  return parsed.origin;
}

function invalidAccountsBaseUrl() {
  return new Error(
    "REGISTRY_ACCOUNTS_BASE_URL must be an absolute HTTP(S) origin without credentials, path, query, or fragment.",
  );
}

function hasAmbientProxy(env: Record<string, string | undefined>) {
  return [
    env.http_proxy,
    env.https_proxy,
    env.all_proxy,
    env.HTTP_PROXY,
    env.HTTPS_PROXY,
    env.ALL_PROXY,
  ].some((value) => Boolean(value?.trim()));
}

function effectiveNoProxy(env: Record<string, string | undefined>) {
  return env.no_proxy ?? env.NO_PROXY ?? "";
}
