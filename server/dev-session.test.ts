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
        new Request("http://127.0.0.1/api/dev/sign-in?handle=attacker&role=admin"),
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
});
