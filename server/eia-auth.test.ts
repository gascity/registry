import { describe, expect, test } from "bun:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import {
  AuthError,
  getRequestApiTokenAuth,
  verifyRegistryEiaToken,
  type RegistryEiaPrincipal,
} from "./auth";
import { createRegistryFetchHandler } from "./app";
import { loadConfig, type ServerConfig } from "./config";
import type { ApiTokenAuthResult, RegistryStore, SessionUser } from "./types";

const issuer = "https://edge.gascity.internal";
const audience = "registry";
type EiaSignOverrides = {
  issuer?: string | null;
  audience?: string | null;
  issuedAt?: number | null;
  expiresAt?: number | null;
  notBefore?: number;
  subject?: string | null;
  subjectType?: unknown;
  scopes?: unknown;
  jti?: unknown;
  orgId?: unknown;
  kid?: string | null;
  typ?: string | null;
};

describe("Registry EIA verification", () => {
  test("accepts a current RS256 user assertion with registry:publish", async () => {
    const fixture = await eiaFixture();
    const token = await fixture.sign();

    await expect(verifyRegistryEiaToken(token, eiaConfig(), fixture.jwks)).resolves.toEqual({
      subject: "usr_registry_publisher",
      jti: "eia-test-jti",
      scopes: ["registry:publish"],
    });
  });

  test("rejects claims or signatures outside the Registry EIA contract", async () => {
    const fixture = await eiaFixture();
    const cases: Array<{ name: string; token: () => Promise<string> }> = [
      { name: "wrong issuer", token: () => fixture.sign({ issuer: "https://forged.invalid" }) },
      { name: "wrong audience", token: () => fixture.sign({ audience: "manifold" }) },
      { name: "expired", token: () => fixture.sign({ expiresAt: Math.floor(Date.now() / 1000) - 60 }) },
      { name: "not yet valid", token: () => fixture.sign({ notBefore: Math.floor(Date.now() / 1000) + 120 }) },
      { name: "missing subject", token: () => fixture.sign({ subject: null }) },
      { name: "empty subject", token: () => fixture.sign({ subject: "   " }) },
      { name: "padded subject", token: () => fixture.sign({ subject: " usr_registry_publisher " }) },
      { name: "service subject", token: () => fixture.sign({ subjectType: "service" }) },
      { name: "malformed scopes", token: () => fixture.sign({ scopes: "registry:publish" }) },
      { name: "mixed-type scopes", token: () => fixture.sign({ scopes: ["registry:publish", 7] }) },
      { name: "empty JWT ID", token: () => fixture.sign({ jti: "" }) },
      { name: "non-string JWT ID", token: () => fixture.sign({ jti: 7 }) },
      { name: "empty organization ID", token: () => fixture.sign({ orgId: "   " }) },
      { name: "non-string organization ID", token: () => fixture.sign({ orgId: 7 }) },
      { name: "unknown signing key", token: () => fixture.sign({ kid: "unknown-key" }) },
      { name: "missing signing key ID", token: () => fixture.sign({ kid: null }) },
      { name: "empty signing key ID", token: () => fixture.sign({ kid: "" }) },
      { name: "missing JWT type", token: () => fixture.sign({ typ: null }) },
      { name: "wrong JWT type", token: () => fixture.sign({ typ: "at+jwt" }) },
    ];

    for (const item of cases) {
      await expect(
        verifyRegistryEiaToken(await item.token(), eiaConfig(), fixture.jwks),
        item.name,
      ).rejects.toBeDefined();
    }
    await expect(verifyRegistryEiaToken("not-a-jwt", eiaConfig(), fixture.jwks)).rejects.toBeDefined();
  });

  test("rejects omission of every required EIA claim", async () => {
    const fixture = await eiaFixture();
    const cases: Array<{ name: string; token: () => Promise<string> }> = [
      { name: "issuer", token: () => fixture.sign({ issuer: null }) },
      { name: "audience", token: () => fixture.sign({ audience: null }) },
      { name: "subject", token: () => fixture.sign({ subject: null }) },
      { name: "issued at", token: () => fixture.sign({ issuedAt: null }) },
      { name: "expiry", token: () => fixture.sign({ expiresAt: null }) },
      { name: "JWT ID", token: () => fixture.sign({ jti: null }) },
      { name: "organization ID", token: () => fixture.sign({ orgId: null }) },
      { name: "subject type", token: () => fixture.sign({ subjectType: null }) },
      { name: "scopes", token: () => fixture.sign({ scopes: null }) },
    ];

    for (const item of cases) {
      await expect(
        verifyRegistryEiaToken(await item.token(), eiaConfig(), fixture.jwks),
        item.name,
      ).rejects.toBeDefined();
    }
  });

  test("accepts expiry and not-before timestamps inside the 30-second clock tolerance", async () => {
    const fixture = await eiaFixture();
    const now = Math.floor(Date.now() / 1000);

    await expect(
      verifyRegistryEiaToken(
        await fixture.sign({ expiresAt: now - 20 }),
        eiaConfig(),
        fixture.jwks,
      ),
    ).resolves.toMatchObject({ subject: "usr_registry_publisher" });
    await expect(
      verifyRegistryEiaToken(
        await fixture.sign({ notBefore: now + 20 }),
        eiaConfig(),
        fixture.jwks,
      ),
    ).resolves.toMatchObject({ subject: "usr_registry_publisher" });
  });

  test("verifies claim shape without authorizing the Registry publish scope", async () => {
    const fixture = await eiaFixture();

    await expect(
      verifyRegistryEiaToken(
        await fixture.sign({ scopes: ["registry:read"] }),
        eiaConfig(),
        fixture.jwks,
      ),
    ).resolves.toMatchObject({ scopes: ["registry:read"] });
  });

  test("pins the signing algorithm to RS256", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "ec-key";
    publicJwk.alg = "ES256";
    const token = await baseToken(new SignJWT(eiaClaims()), privateKey, "ec-key", "ES256");

    await expect(
      verifyRegistryEiaToken(token, eiaConfig(), createLocalJWKSet({ keys: [publicJwk] })),
    ).rejects.toBeDefined();
  });
});

describe("Registry bearer dispatch", () => {
  test("uses gcr_ tokens only with the native token store", async () => {
    const user = testUser();
    const native: ApiTokenAuthResult = { tokenId: "tok_1", kind: "personal", user };
    let eiaCalls = 0;
    const store = authStore({ native });

    const auth = await getRequestApiTokenAuth(
      bearer("gcr_native"),
      store,
      config(),
      async () => {
        eiaCalls += 1;
        return { subject: "usr_wrong", jti: "wrong", scopes: ["registry:publish"] };
      },
    );

    expect(auth).toEqual(native);
    expect(eiaCalls).toBe(0);
    expect(store.calls).toEqual(["native:gcr_native"]);
  });

  test("uses native tokens with EIA disabled and never invokes EIA verification", async () => {
    const user = testUser();
    const native: ApiTokenAuthResult = { tokenId: "tok_1", kind: "personal", user };
    const store = authStore({ native });
    let eiaCalls = 0;

    await expect(
      getRequestApiTokenAuth(bearer("gcr_native"), store, configWithoutEia(), async () => {
        eiaCalls += 1;
        throw new Error("must not verify EIA");
      }),
    ).resolves.toEqual(native);
    expect(eiaCalls).toBe(0);
    expect(store.calls).toEqual(["native:gcr_native"]);
  });

  test("rejects non-native bearers with EIA disabled without invoking EIA verification", async () => {
    const store = authStore({});
    let eiaCalls = 0;

    await expect(
      getRequestApiTokenAuth(bearer("eyJ.registry-eia"), store, configWithoutEia(), async () => {
        eiaCalls += 1;
        throw new Error("must not verify EIA");
      }),
    ).rejects.toMatchObject({ status: 401, code: "INVALID_BEARER" });
    expect(eiaCalls).toBe(0);
    expect(store.calls).toEqual([]);
  });

  test("rejects a revoked native token without EIA or cookie fallback", async () => {
    let eiaCalls = 0;
    const store = authStore({ native: null });
    const request = new Request("https://registry.test/api/me", {
      headers: { Authorization: "Bearer gcr_revoked", Cookie: "registry_session=still-valid" },
    });

    await expect(
      getRequestApiTokenAuth(request, store, config(), async () => {
        eiaCalls += 1;
        return { subject: "usr_wrong", jti: "wrong", scopes: ["registry:publish"] };
      }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(eiaCalls).toBe(0);
    expect(store.calls).toEqual(["native:gcr_revoked"]);
  });

  test("uses non-gcr bearers only with the EIA verifier", async () => {
    const user = testUser();
    const store = authStore({ eiaUser: user });
    const seen: string[] = [];

    const auth = await getRequestApiTokenAuth(
      bearer("eyJ.registry-eia"),
      store,
      config(),
      async (token): Promise<RegistryEiaPrincipal> => {
        seen.push(token);
        return { subject: "usr_registry", jti: "eia_1", scopes: ["registry:publish"] };
      },
    );

    expect(auth).toEqual({ tokenId: "eia_1", kind: "sts_eia", user });
    expect(seen).toEqual(["eyJ.registry-eia"]);
    expect(store.calls).toEqual(["eia:usr_registry"]);
  });

  test("returns 403 for a valid EIA without registry:publish", async () => {
    const store = authStore({ eiaUser: testUser() });

    await expect(
      getRequestApiTokenAuth(bearer("eyJ.registry-eia"), store, config(), async () => ({
        subject: "usr_registry",
        jti: "eia_1",
        scopes: ["registry:read"],
      })),
    ).rejects.toMatchObject({ status: 403, code: "INSUFFICIENT_SCOPE" });
    expect(store.calls).toEqual([]);
  });

  test("returns 401 when a valid EIA subject cannot resolve to an active Registry user", async () => {
    const store = authStore({ eiaUser: null });

    await expect(
      getRequestApiTokenAuth(bearer("eyJ.registry-eia"), store, config(), async () => ({
        subject: "usr_registry",
        jti: "eia_1",
        scopes: ["registry:publish"],
      })),
    ).rejects.toMatchObject({ status: 401, code: "INVALID_BEARER" });
    expect(store.calls).toEqual(["eia:usr_registry"]);
  });

  test("rejects invalid EIA and malformed authorization without native or cookie fallback", async () => {
    const invalidEiaStore = authStore({});
    const request = new Request("https://registry.test/api/me", {
      headers: { Authorization: "Bearer forged.jwt", Cookie: "registry_session=still-valid" },
    });
    await expect(
      getRequestApiTokenAuth(request, invalidEiaStore, config(), async () => {
        throw new Error("bad signature");
      }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(invalidEiaStore.calls).toEqual([]);

    const malformedStore = authStore({});
    await expect(
      getRequestApiTokenAuth(
        new Request("https://registry.test/api/me", {
          headers: { Authorization: "Basic ignored", Cookie: "registry_session=still-valid" },
        }),
        malformedStore,
        config(),
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(malformedStore.calls).toEqual([]);
  });

  test("returns null only when no Authorization header is present", async () => {
    const store = authStore({});
    await expect(
      getRequestApiTokenAuth(new Request("https://registry.test/api/me"), store, config()),
    ).resolves.toBeNull();
    expect(store.calls).toEqual([]);
  });
});

describe("Registry app bearer precedence", () => {
  test("returns 403 for an authenticated EIA without Registry publish authorization", async () => {
    const store = appAuthStore();
    const handler = createRegistryFetchHandler({
      config: config(),
      store,
      verifyRegistryEiaToken: async () => ({
        subject: "usr_registry",
        jti: "eia_1",
        scopes: ["registry:read"],
      }),
    });

    const response = await handler(
      new Request("https://registry.test/api/me", {
        headers: {
          Authorization: "Bearer valid-but-under-scoped.jwt",
          Cookie: "registry_session=valid-cookie",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as unknown).toMatchObject({
      error: { code: "INSUFFICIENT_SCOPE" },
    });
    expect(store.calls).toEqual([]);
  });

  test("never falls back to a valid cookie for invalid Authorization credentials", async () => {
    const cases: Array<{
      name: string;
      authorization: string;
      verifyEia: NonNullable<
        Parameters<typeof createRegistryFetchHandler>[0]["verifyRegistryEiaToken"]
      >;
      expectedCalls: string[];
    }> = [
      {
        name: "revoked native token",
        authorization: "Bearer gcr_revoked",
        verifyEia: async () => {
          throw new Error("native credentials must not invoke EIA verification");
        },
        expectedCalls: ["native:gcr_revoked"],
      },
      {
        name: "forged EIA",
        authorization: "Bearer forged.jwt",
        verifyEia: async () => {
          throw new Error("bad signature");
        },
        expectedCalls: [],
      },
      {
        name: "malformed Authorization",
        authorization: "Basic ignored",
        verifyEia: async () => {
          throw new Error("malformed credentials must not invoke EIA verification");
        },
        expectedCalls: [],
      },
    ];

    for (const item of cases) {
      const store = appAuthStore();
      const handler = createRegistryFetchHandler({
        config: config(),
        store,
        verifyRegistryEiaToken: item.verifyEia,
      });
      const response = await handler(
        new Request("https://registry.test/api/me", {
          headers: {
            Authorization: item.authorization,
            Cookie: "registry_session=valid-cookie",
          },
        }),
      );

      expect(response.status, item.name).toBe(401);
      expect((await response.json()) as unknown, item.name).toMatchObject({
        error: { code: "INVALID_BEARER" },
      });
      expect(store.calls, item.name).toEqual(item.expectedCalls);
    }
  });
});

describe("Registry EIA configuration", () => {
  test("loads issuer, Registry audience, and JWKS URL together", () => {
    const loaded = loadConfig({
      APP_URL: "http://127.0.0.1:8080",
      REGISTRY_EIA_ISSUER: issuer,
      REGISTRY_EIA_JWKS_URL: "https://works.gascity.com/sts/v0/jwks/registry",
    });
    expect(loaded.eia).toEqual({
      issuer,
      audience,
      jwksUrl: "https://works.gascity.com/sts/v0/jwks/registry",
    });
  });

  test("rejects either partial EIA configuration", () => {
    const cases = [
      { REGISTRY_EIA_ISSUER: issuer },
      { REGISTRY_EIA_JWKS_URL: "https://works.gascity.com/sts/v0/jwks/registry" },
    ];
    for (const partial of cases) {
      expect(() => loadConfig({ APP_URL: "http://127.0.0.1:8080", ...partial })).toThrow(
        "REGISTRY_EIA_ISSUER and REGISTRY_EIA_JWKS_URL must be configured together",
      );
    }
  });
});

function eiaConfig(): NonNullable<ServerConfig["eia"]> {
  return {
    issuer,
    audience,
    jwksUrl: "https://works.gascity.com/sts/v0/jwks/registry",
  };
}

function config(): ServerConfig {
  return {
    port: 0,
    appUrl: "https://registry.test",
    mountBase: "",
    sessionSecret: "test-session-secret",
    localDataPath: ".registry-data/test.json",
    eia: eiaConfig(),
    publishValidation: { gcBin: "gc", timeoutMs: 1_000 },
    isProduction: false,
    devAuthEnabled: false,
  };
}

function configWithoutEia(): ServerConfig {
  const { eia: _eia, ...withoutEia } = config();
  return withoutEia;
}

function bearer(token: string) {
  return new Request("https://registry.test/api/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function testUser(): SessionUser {
  return {
    id: "user_1",
    handle: "publisher",
    displayName: "Publisher",
    role: "user",
    status: "active",
  };
}

function authStore(options: { native?: ApiTokenAuthResult | null; eiaUser?: SessionUser | null }) {
  const calls: string[] = [];
  const store = {
    calls,
    async getUserForApiToken(token: string) {
      calls.push(`native:${token}`);
      return options.native ?? null;
    },
    async getOrCreateUserForEiaSubject(subject: string) {
      calls.push(`eia:${subject}`);
      return options.eiaUser ?? null;
    },
  } as unknown as RegistryStore & { calls: string[] };
  return store;
}

function appAuthStore() {
  const store = authStore({ native: null });
  return Object.assign(store, {
    kind: "file" as const,
    async getSession(token: string) {
      store.calls.push(`session:${token}`);
      return {
        id: "session_1",
        user: testUser(),
        csrfToken: "csrf_1",
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
  });
}

async function eiaFixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "registry-key";
  publicJwk.alg = "RS256";
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  return {
    jwks,
    sign: async (overrides: EiaSignOverrides = {}) => {
      const claims = eiaClaims();
      const now = Math.floor(Date.now() / 1000);
      setOrDelete(claims, "iss", overrides.issuer, issuer);
      setOrDelete(claims, "aud", overrides.audience, audience);
      setOrDelete(claims, "iat", overrides.issuedAt, now);
      setOrDelete(claims, "exp", overrides.expiresAt, now + 60);
      setOrDelete(claims, "sub", overrides.subject, "usr_registry_publisher");
      setOrDelete(claims, "jti", overrides.jti, "eia-test-jti");
      setOrDelete(claims, "subject_type", overrides.subjectType, "user");
      setOrDelete(claims, "scopes", overrides.scopes, ["registry:publish"]);
      setOrDelete(claims, "org_id", overrides.orgId, "org_1");
      if (overrides.notBefore !== undefined) claims.nbf = overrides.notBefore;
      return await baseToken(new SignJWT(claims), privateKey, overrides.kid, "RS256", overrides.typ);
    },
  } satisfies {
    jwks: JWTVerifyGetKey;
    sign: (overrides?: EiaSignOverrides) => Promise<string>;
  };
}

function eiaClaims(): Record<string, unknown> {
  return {
    session_id: "ses_1",
    epoch: 1,
  };
}

function setOrDelete(
  claims: Record<string, unknown>,
  key: string,
  override: unknown,
  fallback: unknown,
) {
  if (override === null) {
    delete claims[key];
  } else {
    claims[key] = override === undefined ? fallback : override;
  }
}

async function baseToken(
  signer: SignJWT,
  privateKey: CryptoKey,
  kid: string | null | undefined,
  alg: "RS256" | "ES256",
  typ: string | null | undefined = "JWT",
) {
  const header: { alg: "RS256" | "ES256"; kid?: string; typ?: string } = { alg };
  if (kid !== null) header.kid = kid ?? "registry-key";
  if (typ !== null) header.typ = typ ?? "JWT";
  return await signer.setProtectedHeader(header).sign(privateKey);
}
