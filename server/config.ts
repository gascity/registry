export type ServerConfig = {
  port: number;
  appUrl: string;
  sessionSecret: string;
  databaseUrl?: string;
  localDataPath: string;
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    gasCityUserIdClaim: string;
    gasCityAccountIdClaim?: string;
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

  return {
    port: Number.isFinite(port) && port > 0 ? port : 8080,
    appUrl,
    sessionSecret,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    localDataPath: env.REGISTRY_DATA_PATH?.trim() || ".registry-data/registry.local.json",
    oidc,
    isProduction: env.NODE_ENV === "production" || Boolean(env.RAILWAY_ENVIRONMENT),
    devAuthEnabled: env.REGISTRY_DEV_AUTH === "1" && env.NODE_ENV !== "production",
  };
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
