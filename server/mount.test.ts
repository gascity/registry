import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryFetchHandler } from "./app";
import { createStore } from "./store";
import type { ServerConfig } from "./config";
import { assertOrigin, cookiePath, safeRedirectPath } from "./http";

// The apex frames registry at works.gascity.com/registry/ (same origin); the edge
// strips /registry so the server still sees root paths, but the BROWSER-visible
// cookie Path + origin must be mount-aware.
const APEX: Partial<ServerConfig> = { mountBase: "/registry", appUrl: "https://works.gascity.com" };

function baseConfig(over: Partial<ServerConfig>): ServerConfig {
  return {
    port: 0,
    appUrl: "http://127.0.0.1:0",
    mountBase: "",
    sessionSecret: "mount-test-secret-value-thirty-two-ch",
    localDataPath: ".registry-data/mount-test.json",
    publishValidation: { gcBin: "gc", timeoutMs: 1_000 },
    isProduction: false,
    devAuthEnabled: false,
    publishAutoApprove: false,
    ...over,
  };
}

async function withHandler(
  over: Partial<ServerConfig>,
  fn: (handler: (req: Request) => Promise<Response>) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "regmount-"));
  const store = createStore(undefined, join(dir, "registry.local.json"));
  await store.init();
  try {
    await fn(createRegistryFetchHandler({ config: baseConfig(over), store }));
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("registry under the apex /registry mount", () => {
  test("cookiePath scopes to the mount ('/registry/' apex, '/' standalone)", () => {
    expect(cookiePath(baseConfig({ mountBase: "/registry" }))).toBe("/registry/");
    expect(cookiePath(baseConfig({ mountBase: "" }))).toBe("/");
  });

  test("safeRedirectPath rejects post-normalization open redirects and confines to the mount", () => {
    const apex = baseConfig(APEX);
    const std = baseConfig({ mountBase: "" });
    // The high-sev open redirect: "/..//evil" normalizes to "//evil" (cross-origin).
    for (const evil of ["/..//evil.com", "/.//evil.com", "/foo/..//evil.com"]) {
      expect(safeRedirectPath(apex, evil)).toBe("/registry/");
      expect(safeRedirectPath(std, evil)).toBe("/");
    }
    // Confine to the mount; default and out-of-mount paths land at the mount home.
    expect(safeRedirectPath(apex, "/registry/account")).toBe("/registry/account");
    expect(safeRedirectPath(apex, "/account")).toBe("/registry/");
    expect(safeRedirectPath(apex, null)).toBe("/registry/");
    // Standalone keeps a valid same-origin path and "/" home.
    expect(safeRedirectPath(std, "/account")).toBe("/account");
    expect(safeRedirectPath(std, null)).toBe("/");
  });

  test("assertOrigin accepts a same-origin POST and rejects a cross-origin one", () => {
    const config = baseConfig(APEX);
    const same = new Request("https://works.gascity.com/api/x", {
      method: "POST",
      headers: { origin: "https://works.gascity.com" },
    });
    expect(() => assertOrigin(same, config)).not.toThrow();
    const cross = new Request("https://works.gascity.com/api/x", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    expect(() => assertOrigin(cross, config)).toThrow();
  });

  test("session cookie set under the apex mount carries Path=/registry/ (shared-origin leak guard)", async () => {
    await withHandler({ ...APEX, devAuthEnabled: true }, async (handler) => {
      const res = await handler(
        new Request("https://works.gascity.com/api/dev/sign-in?handle=mountuser"),
      );
      const setCookie = res.headers.getSetCookie?.().join("\n") ?? res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("Path=/registry/");
    });
  });

  test("standalone session cookie carries Path=/ (degrade to identity)", async () => {
    await withHandler({ devAuthEnabled: true }, async (handler) => {
      const res = await handler(new Request("http://127.0.0.1/api/dev/sign-in?handle=stduser"));
      const setCookie = res.headers.getSetCookie?.().join("\n") ?? res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("Path=/");
      expect(setCookie).not.toContain("Path=/registry/");
    });
  });
});
