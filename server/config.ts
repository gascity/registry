export type ServerConfig = {
  port: number;
  appUrl: string;
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
  isProduction: boolean;
  devAuthEnabled: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const port = Number.parseInt(env.PORT ?? "8080", 10);
  const appUrl = trimTrailingSlash(
    env.APP_URL ??
      (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "http://127.0.0.1:8080"),
  );
  const sessionSecret = env.SESSION_SECRET?.trim() || "dev-insecure-registry-session-secret";
  const issuer = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim();
  const gasCityUserIdClaim = env.OIDC_GASCITY_USER_ID_CLAIM?.trim() || "sub";
  const gasCityAccountIdClaim = env.OIDC_GASCITY_ACCOUNT_ID_CLAIM?.trim() || undefined;
  const workosApiKey = env.WORKOS_API_KEY?.trim();
  const workosClientId = env.WORKOS_CLIENT_ID?.trim();
  const workosApiBaseUrl = trimTrailingSlash(env.WORKOS_API_BASE_URL?.trim() || "https://api.workos.com");
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

  return {
    port: Number.isFinite(port) && port > 0 ? port : 8080,
    appUrl,
    sessionSecret,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    localDataPath: env.REGISTRY_DATA_PATH?.trim() || ".registry-data/registry.local.json",
    authProvider,
    oidc,
    workos,
    isProduction: env.NODE_ENV === "production" || Boolean(env.RAILWAY_ENVIRONMENT),
    devAuthEnabled: env.REGISTRY_DEV_AUTH === "1" && env.NODE_ENV !== "production",
  };
}

function parseAuthProvider(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "oidc" || normalized === "workos" ? normalized : undefined;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
