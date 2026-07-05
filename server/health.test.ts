import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createRegistryFetchHandler } from "./app";
import { createStore } from "./store";
import type { ServerConfig } from "./config";
import type { RegistryStore } from "./types";

function config(): ServerConfig {
  return {
    port: 0,
    appUrl: "http://127.0.0.1:0",
    mountBase: "",
    sessionSecret: "x".repeat(32),
    localDataPath: "",
    publishValidation: { gcBin: "gc", timeoutMs: 1000 },
    isProduction: false,
    devAuthEnabled: false,
  } as ServerConfig;
}

async function withStore(fn: (store: RegistryStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "registry-health-"));
  const store = createStore(undefined, join(dir, "registry.local.json"));
  await store.init();
  try {
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("/health readiness probe", () => {
  test("a healthy store -> 200 with store kind", async () => {
    await withStore(async (store) => {
      const handler = createRegistryFetchHandler({ config: config(), store });
      const res = await handler(new Request("http://127.0.0.1/health"));
      expect(res.status).toBe(200);
      expect((await res.json()) as { status: string; store: string }).toMatchObject({
        status: "ok",
        store: "file",
      });
    });
  });

  test("a store whose ping fails -> 503 degraded (a DB-down instance can't pass its healthcheck)", async () => {
    await withStore(async (store) => {
      store.ping = async () => {
        throw new Error("db down");
      };
      const handler = createRegistryFetchHandler({ config: config(), store });
      const res = await handler(new Request("http://127.0.0.1/health"));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { status: string }).status).toBe("degraded");
    });
  });

  test("the result is cached across immediate requests (pings once)", async () => {
    await withStore(async (store) => {
      let pings = 0;
      store.ping = async () => {
        pings += 1;
      };
      const handler = createRegistryFetchHandler({ config: config(), store });
      await handler(new Request("http://127.0.0.1/health"));
      await handler(new Request("http://127.0.0.1/health"));
      expect(pings).toBe(1);
    });
  });
});
