import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOidcIdentityWithAccounts } from "./auth";
import { loadConfig, type ServerConfig } from "./config";
import { createStore } from "./store";
import type { IdentityClaims } from "./types";

const originalIdentity: IdentityClaims = {
  subject: "customer-realm-subject",
  gasCityUserId: "customer-realm-subject",
  email: "member@example.com",
  handle: "member",
  displayName: "Registry Member",
  assertedOrgMember: true,
};

type RegistryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function resolverConfig(overrides: Partial<NonNullable<ServerConfig["accountsIdentityResolver"]>> = {}) {
  return {
    accountsIdentityResolver: {
      baseUrl: "http://accounts.accounts.svc.cluster.local",
      token: "resolver-test-token",
      timeoutMs: 3_000,
      ...overrides,
    },
  } as ServerConfig;
}

function response(body: unknown, init: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

describe("OIDC Accounts identity resolution", () => {
  test("maps a verified OIDC subject to the same Registry principal as its EIA subject", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-accounts-identity-"));
    const store = createStore(undefined, join(dir, "registry.local.json"));
    await store.init();
    try {
      const resolved = await resolveOidcIdentityWithAccounts(
        originalIdentity,
        resolverConfig(),
        async () => response({ user_id: "usr_accounts_stable" }, { status: 200 }),
      );
      const oidcUser = await store.ensureUser(resolved);
      const eiaUser = await store.getOrCreateUserForEiaSubject("usr_accounts_stable");

      expect(resolved).toEqual({ ...originalIdentity, gasCityUserId: "usr_accounts_stable" });
      expect(eiaUser?.id).toBe(oidcUser.id);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("derives the lookup only from the verified identity subject", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return response({ user_id: "usr_accounts_stable" }, { status: 200 });
    }) satisfies RegistryFetch;

    await resolveOidcIdentityWithAccounts(
      { ...originalIdentity, gasCityUserId: "untrusted-alternate-key" },
      resolverConfig(),
      fetcher,
    );

    expect(seenUrl).toBe(
      "http://accounts.accounts.svc.cluster.local/v0/resolve/registry-user",
    );
    expect(seenInit).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer resolver-test-token",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      keycloak_sub: "customer-realm-subject",
    });
  });

  test("preserves native-only Registry identity on an explicit Accounts unknown-subject response", async () => {
    const resolved = await resolveOidcIdentityWithAccounts(
      originalIdentity,
      resolverConfig(),
      async () => response({ error: "user not found" }, { status: 404 }),
    );

    expect(resolved).toEqual(originalIdentity);
  });

  test("does not call Accounts when the optional resolver is unconfigured", async () => {
    let calls = 0;
    const resolved = await resolveOidcIdentityWithAccounts(
      originalIdentity,
      {} as ServerConfig,
      async () => {
        calls += 1;
        throw new Error("must not call Accounts");
      },
    );

    expect(resolved).toEqual(originalIdentity);
    expect(calls).toBe(0);
  });

  test("fails closed on resolver auth failures, outages, and untyped 404 responses", async () => {
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const cases: Array<{ name: string; fetcher: RegistryFetch }> = [
        {
          name: "resolver credential rejected",
          fetcher: async () => response({ error: "unauthorized" }, { status: 401 }),
        },
        {
          name: "resolver outage",
          fetcher: async () => response({ error: "unavailable" }, { status: 503 }),
        },
        {
          name: "wrong endpoint 404",
          fetcher: async () => response({ error: "not found" }, { status: 404 }),
        },
        {
          name: "transport failure",
          fetcher: async () => {
            throw new Error("connection reset");
          },
        },
      ];

      for (const item of cases) {
        await expect(
          resolveOidcIdentityWithAccounts(originalIdentity, resolverConfig(), item.fetcher),
          item.name,
        ).rejects.toMatchObject({ status: 503, code: "IDENTITY_RESOLUTION_FAILED" });
      }
      const serializedLogs = JSON.stringify(log.mock.calls);
      expect(serializedLogs).toContain("upstream_status");
      expect(serializedLogs).not.toContain("resolver-test-token");
      expect(serializedLogs).not.toContain("customer-realm-subject");
      expect(serializedLogs).not.toContain("unauthorized");
    } finally {
      log.mockRestore();
    }
  });

  test("fails closed on malformed resolver success responses", async () => {
    for (const payload of [
      {},
      { user_id: 7 },
      { user_id: "" },
      { user_id: " usr_accounts_stable " },
      { user_id: "usr_accounts_stable", email: "unexpected@example.test" },
    ]) {
      await expect(
        resolveOidcIdentityWithAccounts(
          originalIdentity,
          resolverConfig(),
          async () => response(payload, { status: 200 }),
        ),
      ).rejects.toMatchObject({ status: 503, code: "IDENTITY_RESOLUTION_FAILED" });
    }
  });

  test("bounds the resolver request with the configured deadline", async () => {
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    }) satisfies RegistryFetch;

    await expect(
      resolveOidcIdentityWithAccounts(
        originalIdentity,
        resolverConfig({ timeoutMs: 5 }),
        fetcher,
      ),
    ).rejects.toMatchObject({ status: 503, code: "IDENTITY_RESOLUTION_FAILED" });
  });

  test("keeps the deadline active while the resolver response body is stalled", async () => {
    const encoder = new TextEncoder();
    const stalled = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"user_id":"usr_'));
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    await expect(
      resolveOidcIdentityWithAccounts(
        originalIdentity,
        resolverConfig({ timeoutMs: 5 }),
        async () => stalled,
      ),
    ).rejects.toMatchObject({ status: 503, code: "IDENTITY_RESOLUTION_FAILED" });
  });

  test("rejects complete resolver JSON when EOF arrives only through deadline cancellation", async () => {
    const encoder = new TextEncoder();
    const stalled = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"user_id":"usr_accounts_stable"}'));
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    await expect(
      resolveOidcIdentityWithAccounts(
        originalIdentity,
        resolverConfig({ timeoutMs: 5 }),
        async () => stalled,
      ),
    ).rejects.toMatchObject({ status: 503, code: "IDENTITY_RESOLUTION_FAILED" });
  });

  test("rejects an oversized resolver response", async () => {
    await expect(
      resolveOidcIdentityWithAccounts(
        originalIdentity,
        resolverConfig(),
        async () => response({ user_id: `usr_${"x".repeat(20_000)}` }, { status: 200 }),
      ),
    ).rejects.toMatchObject({ status: 503, code: "IDENTITY_RESOLUTION_FAILED" });
  });

  test("cancels a response body that has the wrong content type", async () => {
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const contentType of ["text/plain", "application/json-pwn"]) {
        let cancelled = false;
        const upstream = new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("not-json"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "Content-Type": contentType } },
        );

        await expect(
          resolveOidcIdentityWithAccounts(
            originalIdentity,
            resolverConfig({ timeoutMs: 20 }),
            async () => upstream,
          ),
        ).rejects.toMatchObject({ status: 503, code: "IDENTITY_RESOLUTION_FAILED" });
        expect(cancelled).toBe(true);
        expect(log.mock.lastCall?.[1]).toMatchObject({ reason: "content_type" });
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe("Accounts identity resolver configuration", () => {
  const oidcEnv = {
    APP_URL: "http://127.0.0.1:8080",
    OIDC_ISSUER: "https://auth.example.test/realms/customers",
    OIDC_CLIENT_ID: "registry",
    OIDC_CLIENT_SECRET: "client-secret",
  };

  test("loads the optional resolver only when base URL and credential are both present", () => {
    expect(
      loadConfig({
        ...oidcEnv,
        REGISTRY_ACCOUNTS_BASE_URL: "http://accounts.accounts.svc.cluster.local/",
        REGISTRY_ACCOUNTS_RESOLVER_TOKEN: "resolver-token",
      }).accountsIdentityResolver,
    ).toEqual({
      baseUrl: "http://accounts.accounts.svc.cluster.local",
      token: "resolver-token",
      timeoutMs: 3_000,
    });

    for (const partial of [
      { REGISTRY_ACCOUNTS_BASE_URL: "http://accounts.accounts.svc.cluster.local" },
      { REGISTRY_ACCOUNTS_RESOLVER_TOKEN: "resolver-token" },
    ]) {
      expect(() => loadConfig({ ...oidcEnv, ...partial })).toThrow(
        "REGISTRY_ACCOUNTS_BASE_URL and REGISTRY_ACCOUNTS_RESOLVER_TOKEN must be configured together",
      );
    }
  });

  test("rejects a non-positive or malformed resolver deadline", () => {
    for (const timeout of ["0", "-1", "1.5", "5ms", "not-a-number"]) {
      expect(() =>
        loadConfig({
          ...oidcEnv,
          REGISTRY_ACCOUNTS_BASE_URL: "http://accounts.accounts.svc.cluster.local",
          REGISTRY_ACCOUNTS_RESOLVER_TOKEN: "resolver-token",
          REGISTRY_ACCOUNTS_RESOLVE_TIMEOUT_MS: timeout,
        }),
      ).toThrow("REGISTRY_ACCOUNTS_RESOLVE_TIMEOUT_MS must be a positive integer");
    }
  });

  test("accepts only an absolute HTTP(S) origin as the Accounts base URL", () => {
    expect(
      loadConfig({
        ...oidcEnv,
        REGISTRY_ACCOUNTS_BASE_URL: "https://Accounts.Example.Test:8443/",
        REGISTRY_ACCOUNTS_RESOLVER_TOKEN: "resolver-token",
      }).accountsIdentityResolver?.baseUrl,
    ).toBe("https://accounts.example.test:8443");

    for (const baseUrl of [
      "accounts.accounts.svc.cluster.local",
      "ftp://accounts.example.test",
      "http://user:password@accounts.example.test",
      "http://accounts.example.test/v0",
      "http://accounts.example.test?target=elsewhere",
      "http://accounts.example.test#fragment",
    ]) {
      expect(() =>
        loadConfig({
          ...oidcEnv,
          REGISTRY_ACCOUNTS_BASE_URL: baseUrl,
          REGISTRY_ACCOUNTS_RESOLVER_TOKEN: "resolver-token",
        }),
      ).toThrow("REGISTRY_ACCOUNTS_BASE_URL must be an absolute HTTP(S) origin");
    }
  });

  test("refuses to send the Accounts bearer through an ambient proxy", () => {
    const proxied = {
      ...oidcEnv,
      REGISTRY_ACCOUNTS_BASE_URL: "http://accounts.accounts.svc.cluster.local",
      REGISTRY_ACCOUNTS_RESOLVER_TOKEN: "resolver-token",
      HTTPS_PROXY: "http://proxy.example.test:8080",
    };
    expect(() => loadConfig(proxied)).toThrow(
      "Accounts identity resolution requires no_proxy=* when proxy environment variables are set",
    );
    expect(loadConfig({ ...proxied, NO_PROXY: "*" }).accountsIdentityResolver).toBeDefined();
    expect(() => loadConfig({ ...proxied, NO_PROXY: "*", no_proxy: "example.test" })).toThrow(
      "Accounts identity resolution requires no_proxy=* when proxy environment variables are set",
    );
    expect(
      loadConfig({ ...proxied, NO_PROXY: "example.test", no_proxy: "*" }).accountsIdentityResolver,
    ).toBeDefined();
  });
});
