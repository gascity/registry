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
  authProvider?: "oidc" | "workos";
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    gasCityUserIdClaim: string;
    gasCityAccountIdClaim?: string;
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
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const port = Number.parseInt(env.PORT ?? "8080", 10);
  const isProduction = env.NODE_ENV === "production" || Boolean(env.RAILWAY_ENVIRONMENT);
  const appUrl = trimTrailingSlash(
    env.APP_URL ??
      (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "http://127.0.0.1:8080"),
  );
  // "" standalone, "/registry" under the apex mount (set on the apex deploy only).
  const mountBase = trimTrailingSlash(env.REGISTRY_MOUNT_BASE?.trim() ?? "");
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
  const workosApiKey = env.WORKOS_API_KEY?.trim();
  const workosClientId = env.WORKOS_CLIENT_ID?.trim();
  const workosApiBaseUrl = trimTrailingSlash(env.WORKOS_API_BASE_URL?.trim() || "https://api.workos.com");
  const githubAppSlug = env.GITHUB_APP_SLUG?.trim();
  const githubAppClientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const githubAppClientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const githubAppWebhookSecret = env.GITHUB_APP_WEBHOOK_SECRET?.trim();
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

  return {
    port: Number.isFinite(port) && port > 0 ? port : 8080,
    appUrl,
    mountBase,
    sessionSecret,
    databaseUrl,
    localDataPath: env.REGISTRY_DATA_PATH?.trim() || ".registry-data/registry.local.json",
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
    devAuthEnabled: env.REGISTRY_DEV_AUTH === "1" && !isProduction,
  };
}

function parseAuthProvider(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "oidc" || normalized === "workos" ? normalized : undefined;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
