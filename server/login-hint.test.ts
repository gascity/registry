import { afterEach, describe, expect, test } from "bun:test";
import { startLogin } from "./auth";
import type { ServerConfig } from "./config";

const discovery = {
  authorization_endpoint: "https://auth.example.test/realms/r/protocol/openid-connect/auth",
  token_endpoint: "https://auth.example.test/realms/r/protocol/openid-connect/token",
  jwks_uri: "https://auth.example.test/realms/r/protocol/openid-connect/certs",
  userinfo_endpoint: "https://auth.example.test/realms/r/protocol/openid-connect/userinfo",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function cfg(over: Partial<NonNullable<ServerConfig["oidc"]>>): ServerConfig {
  // Unique issuer per call so getDiscovery's per-issuer cache never bleeds between cases.
  const issuer = `https://auth.example.test/realms/${Math.random().toString(36).slice(2)}`;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(discovery), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return {
    port: 0,
    appUrl: "https://registry.gascity.com",
    mountBase: "",
    sessionSecret: "login-hint-test-secret-value-32chars!",
    localDataPath: "",
    publishValidation: { gcBin: "gc", timeoutMs: 1000 },
    isProduction: true,
    devAuthEnabled: false,
    authProvider: "oidc",
    oidc: {
      issuer,
      clientId: "registry",
      clientSecret: "s",
      gasCityUserIdClaim: "sub",
      ...over,
    },
  } as ServerConfig;
}

async function hintFor(req: string, config: ServerConfig, opts?: { staff?: boolean }) {
  const res = await startLogin(new Request(req), config, opts);
  const loc = res.headers.get("location");
  expect(loc).toBeTruthy();
  return new URL(loc!).searchParams.get("kc_idp_hint");
}

describe("login kc_idp_hint routing", () => {
  test("default product login pins the customer IdP (straight to GitHub)", async () => {
    expect(
      await hintFor("https://registry.gascity.com/api/auth/login", cfg({ idpHint: "github", staffIdpHint: "gascity-sso" })),
    ).toBe("github");
  });

  test("/staff pins the staff IdP (straight to SSO)", async () => {
    expect(
      await hintFor("https://registry.gascity.com/staff", cfg({ idpHint: "github", staffIdpHint: "gascity-sso" }), { staff: true }),
    ).toBe("gascity-sso");
  });

  test("?idp=staff also pins the staff IdP", async () => {
    expect(
      await hintFor("https://registry.gascity.com/api/auth/login?idp=staff", cfg({ idpHint: "github", staffIdpHint: "gascity-sso" })),
    ).toBe("gascity-sso");
  });

  test("no hints configured => no kc_idp_hint (legacy chooser preserved)", async () => {
    expect(await hintFor("https://registry.gascity.com/api/auth/login", cfg({}))).toBeNull();
    // staff request with no staffIdpHint configured also falls through to the chooser
    expect(await hintFor("https://registry.gascity.com/staff", cfg({}), { staff: true })).toBeNull();
  });
});
