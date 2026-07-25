import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryFetchHandler } from "./app";
import { createStore } from "./store";
import { loadConfig, type ServerConfig } from "./config";

function baseConfig(over: Partial<ServerConfig>): ServerConfig {
  return {
    port: 0,
    appUrl: "http://127.0.0.1:0",
    mountBase: "",
    sessionSecret: "dev-session-test-secret-value-32chars",
    localDataPath: ".registry-data/dev-session-test.json",
    publishValidation: { gcBin: "gc", timeoutMs: 1_000 },
    isProduction: false,
    devAuthEnabled: false,
    publishAutoApprove: false,
    ...over,
  };
}

async function withStore(fn: (store: Awaited<ReturnType<typeof makeStore>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "regdev-"));
  const store = createStore(undefined, join(dir, "registry.local.json"));
  await store.init();
  try {
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
function makeStore() {
  return createStore(undefined, "");
}

describe("dev-session backdoor is dead in production", () => {
  test("loadConfig forces devAuthEnabled=false in production, even with REGISTRY_DEV_AUTH=1", () => {
    const cfg = loadConfig({
      NODE_ENV: "production",
      REGISTRY_DEV_AUTH: "1",
      SESSION_SECRET: "a-very-long-production-session-secret-value",
      DATABASE_URL: "postgres://user:pass@localhost:5432/registry",
      REGISTRY_AUTH_PROVIDER: "oidc",
      OIDC_ISSUER: "https://auth.gascity.com/realms/gasworks-customers",
      OIDC_CLIENT_ID: "registry",
      OIDC_CLIENT_SECRET: "shhh-oidc-secret",
    });
    expect(cfg.isProduction).toBe(true);
    expect(cfg.devAuthEnabled).toBe(false);
  });

  test("GET /api/dev/sign-in is 404 when dev auth is disabled (prod-like)", async () => {
    await withStore(async (store) => {
      const handler = createRegistryFetchHandler({
        config: baseConfig({ isProduction: true, devAuthEnabled: false }),
        store,
      });
      const res = await handler(
        new Request("http://127.0.0.1/api/dev/sign-in?handle=attacker&role=admin&orgMember=1"),
      );
      expect(res.status).toBe(404);
    });
  });

  test("GET /api/dev/sign-in still works when dev auth is explicitly enabled (local dev)", async () => {
    await withStore(async (store) => {
      const handler = createRegistryFetchHandler({
        config: baseConfig({ devAuthEnabled: true }),
        store,
      });
      const res = await handler(new Request("http://127.0.0.1/api/dev/sign-in?handle=local"));
      // createDevSession redirects with a session cookie — anything but 404 proves
      // the dev path is reachable when explicitly enabled.
      expect(res.status).not.toBe(404);
    });
  });

  test("POST /api/dev/seed-ownership is 404 when dev auth is disabled (prod-like)", async () => {
    await withStore(async (store) => {
      const handler = createRegistryFetchHandler({
        config: baseConfig({ isProduction: true, devAuthEnabled: false }),
        store,
      });
      const res = await handler(
        new Request("http://127.0.0.1/api/dev/seed-ownership", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl: "https://github.com/acme/pack" }),
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  test("POST /api/dev/seed-ownership requires a session even when dev auth is on", async () => {
    await withStore(async (store) => {
      const handler = createRegistryFetchHandler({
        config: baseConfig({ devAuthEnabled: true }),
        store,
      });
      const res = await handler(
        new Request("http://127.0.0.1/api/dev/seed-ownership", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl: "https://github.com/acme/pack" }),
        }),
      );
      expect(res.status).toBe(401);
    });
  });
});

describe("dev-auth is gated on more than NODE_ENV", () => {
  test("disabled on a public origin even without NODE_ENV=production", () => {
    const cfg = loadConfig({
      REGISTRY_DEV_AUTH: "1",
      APP_URL: "https://registry-staging.gascity.com",
    });
    expect(cfg.isProduction).toBe(false);
    expect(cfg.devAuthEnabled).toBe(false);
  });

  test("disabled when a Railway public domain is present", () => {
    const cfg = loadConfig({
      REGISTRY_DEV_AUTH: "1",
      RAILWAY_PUBLIC_DOMAIN: "registry-staging.up.railway.app",
    });
    expect(cfg.devAuthEnabled).toBe(false);
  });

  test("stays enabled for an explicitly loopback origin in local dev", () => {
    const cfg = loadConfig({
      REGISTRY_DEV_AUTH: "1",
      APP_URL: "http://127.0.0.1:5173",
    });
    expect(cfg.isProduction).toBe(false);
    expect(cfg.devAuthEnabled).toBe(true);
  });

  test("fails closed when APP_URL is unset (bare deploy inheriting loopback default)", () => {
    const cfg = loadConfig({ REGISTRY_DEV_AUTH: "1" });
    expect(cfg.isProduction).toBe(false);
    expect(cfg.devAuthEnabled).toBe(false);
  });

  test("disabled on the all-interfaces origin 0.0.0.0 (not loopback)", () => {
    const cfg = loadConfig({ REGISTRY_DEV_AUTH: "1", APP_URL: "http://0.0.0.0:8080" });
    expect(cfg.devAuthEnabled).toBe(false);
  });

  test("disabled on a known platform even with a loopback APP_URL", () => {
    const cfg = loadConfig({
      REGISTRY_DEV_AUTH: "1",
      APP_URL: "http://127.0.0.1:8080",
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
    });
    expect(cfg.devAuthEnabled).toBe(false);
  });

  test("production refuses to start without an auth provider", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        SESSION_SECRET: "a-very-long-production-session-secret-value",
        DATABASE_URL: "postgres://user:pass@localhost:5432/registry",
      }),
    ).toThrow(/auth provider/i);
  });
});
