import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JWTPayload } from "jose";
import { identityFromClaims, identityFromOidcTokenResponse } from "./auth";
import { createStore } from "./store";
import type { ServerConfig } from "./config";
import type { IdentityClaims } from "./types";

// identityFromClaims only reads config.oidc; a minimal cast keeps the test focused.
const oidcConfig = {
  oidc: {
    issuer: "https://auth.gascity.com/realms/gasworks-customers",
    clientId: "registry",
    clientSecret: "x",
    gasCityUserIdClaim: "sub",
  },
} as unknown as ServerConfig;

async function withStore(fn: (store: ReturnType<typeof createStore>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "regstaff-"));
  const store = createStore(undefined, join(dir, "registry.local.json"));
  await store.init();
  try {
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function identity(over: Partial<IdentityClaims> & { subject: string }): IdentityClaims {
  return {
    gasCityUserId: over.subject,
    email: `${over.subject}@example.com`,
    handle: over.subject,
    displayName: over.subject,
    ...over,
  };
}

describe("identityFromClaims derives assertedAdmin from realm_access.roles", () => {
  test("registry-staff role present -> assertedAdmin true", () => {
    const claims = {
      sub: "staff-1",
      email: "jules@gascity.com",
      realm_access: { roles: ["default-roles", "registry-staff"] },
    } as unknown as JWTPayload;
    expect(identityFromClaims(claims, oidcConfig).assertedAdmin).toBe(true);
  });

  test("no registry-staff role -> assertedAdmin false", () => {
    const claims = {
      sub: "ext-1",
      email: "someone@github.io",
      realm_access: { roles: ["default-roles"] },
    } as unknown as JWTPayload;
    expect(identityFromClaims(claims, oidcConfig).assertedAdmin).toBe(false);
  });

  test("no realm_access at all -> assertedAdmin false", () => {
    const claims = { sub: "ext-2", email: "x@github.io" } as unknown as JWTPayload;
    expect(identityFromClaims(claims, oidcConfig).assertedAdmin).toBe(false);
  });

  test("malformed realm_access shapes are not trusted (defensive)", () => {
    // roles is not an array; realm_access is a string; roles holds a non-string posing as the role.
    for (const realm_access of [
      { roles: "registry-staff" },
      "registry-staff",
      { roles: [{ toString: () => "registry-staff" }] },
      null,
    ]) {
      const claims = { sub: "atk", realm_access } as unknown as JWTPayload;
      expect(identityFromClaims(claims, oidcConfig).assertedAdmin).toBe(false);
    }
  });
});

describe("identityFromClaims derives assertedOrgMember from the registry-member realm role", () => {
  test("registry-member role present -> assertedOrgMember true", () => {
    const claims = {
      sub: "member-1",
      email: "dev@gascity.com",
      realm_access: { roles: ["default-roles", "registry-member"] },
    } as unknown as JWTPayload;
    expect(identityFromClaims(claims, oidcConfig).assertedOrgMember).toBe(true);
  });

  test("no registry-member role -> assertedOrgMember false", () => {
    const claims = { sub: "ext-1", realm_access: { roles: ["default-roles"] } } as unknown as JWTPayload;
    expect(identityFromClaims(claims, oidcConfig).assertedOrgMember).toBe(false);
  });

  test("no realm_access at all -> assertedOrgMember false", () => {
    const claims = { sub: "ext-2" } as unknown as JWTPayload;
    expect(identityFromClaims(claims, oidcConfig).assertedOrgMember).toBe(false);
  });

  test("registry-member and registry-staff are independent rails", () => {
    const member = { sub: "m", realm_access: { roles: ["registry-member"] } } as unknown as JWTPayload;
    expect(identityFromClaims(member, oidcConfig)).toMatchObject({
      assertedOrgMember: true,
      assertedAdmin: false,
    });
    const staff = { sub: "s", realm_access: { roles: ["registry-staff"] } } as unknown as JWTPayload;
    expect(identityFromClaims(staff, oidcConfig)).toMatchObject({
      assertedOrgMember: false,
      assertedAdmin: true,
    });
  });

  test("malformed realm_access shapes are not trusted (defensive)", () => {
    for (const realm_access of [{ roles: "registry-member" }, "registry-member", null]) {
      const claims = { sub: "atk", realm_access } as unknown as JWTPayload;
      expect(identityFromClaims(claims, oidcConfig).assertedOrgMember).toBe(false);
    }
  });
});

describe("identityFromOidcTokenResponse recomputes authz from the VERIFIED id_token only", () => {
  test("an unsigned userinfo response cannot assert staff or org membership (spoof defense)", () => {
    // The verified id_token carries NEITHER privileged role; the (unsigned) userinfo tries to
    // inject BOTH. Authorization must be recomputed from the id_token alone -> both false.
    const claims = {
      sub: "victim",
      email: "victim@example.com",
      email_verified: true,
      idp_connection: "github",
      realm_access: { roles: ["default-roles"] },
    } as unknown as JWTPayload;
    const userInfo = {
      realm_access: { roles: ["registry-staff", "registry-member"] },
    } as unknown as JWTPayload;
    const identity = identityFromOidcTokenResponse(claims, userInfo, oidcConfig);
    expect(identity.assertedAdmin).toBe(false);
    expect(identity.assertedOrgMember).toBe(false);
  });

  test("roles in the verified id_token DO grant, while userinfo still enriches profile fields", () => {
    const claims = {
      sub: "staffer",
      email: "staffer@gascity.com",
      idp_connection: "gascity-sso",
      realm_access: { roles: ["registry-staff", "registry-member"] },
    } as unknown as JWTPayload;
    const userInfo = { name: "Display From Userinfo" } as unknown as JWTPayload;
    const identity = identityFromOidcTokenResponse(claims, userInfo, oidcConfig);
    expect(identity.assertedAdmin).toBe(true);
    expect(identity.assertedOrgMember).toBe(true);
    expect(identity.displayName).toBe("Display From Userinfo"); // profile merge still works
  });
});

describe("identityFromOidcTokenResponse enforces the verified broker boundary", () => {
  test("an external customer authenticated by GitHub is admitted", () => {
    const claims = {
      sub: "customer-1",
      email: "customer@example.com",
      email_verified: true,
      idp_connection: "github",
      realm_access: { roles: ["default-roles"] },
    } as unknown as JWTPayload;

    expect(identityFromOidcTokenResponse(claims, {}, oidcConfig)).toMatchObject({
      email: "customer@example.com",
      assertedAdmin: false,
    });
  });

  test("a Gas City email authenticated by GitHub is denied even if a staff role persisted", () => {
    const claims = {
      sub: "staff-via-github",
      email: "Staff@GasCity.COM.",
      email_verified: true,
      idp_connection: "github",
      realm_access: { roles: ["registry-staff"] },
    } as unknown as JWTPayload;

    expect(() => identityFromOidcTokenResponse(claims, {}, oidcConfig)).toThrow(
      "Gas City staff sign in with Gas City SSO",
    );
  });

  test("Gas City staff authenticated by SSO with the verified role are admitted", () => {
    const claims = {
      sub: "staff-via-sso",
      email: "staff@gascity.com",
      idp_connection: "gascity-sso",
      realm_access: { roles: ["registry-staff"] },
    } as unknown as JWTPayload;

    expect(identityFromOidcTokenResponse(claims, {}, oidcConfig).assertedAdmin).toBe(true);
  });

  test("the staff broker fails closed when its verified token lacks the staff role", () => {
    const claims = {
      sub: "not-staff",
      email: "someone@example.com",
      idp_connection: "gascity-sso",
      realm_access: { roles: [] },
    } as unknown as JWTPayload;

    expect(() => identityFromOidcTokenResponse(claims, {}, oidcConfig)).toThrow(
      "Gas City staff sign in with Gas City SSO",
    );
  });

  test("missing or unknown verified broker claims fail closed", () => {
    for (const idp_connection of [undefined, "attacker-idp", 42]) {
      const claims = {
        sub: "ambiguous-source",
        email: "customer@example.com",
        ...(idp_connection === undefined ? {} : { idp_connection }),
      } as unknown as JWTPayload;

      expect(() => identityFromOidcTokenResponse(claims, {}, oidcConfig)).toThrow(
        "Sign-in identity provider could not be verified",
      );
    }
  });

  test("a GitHub token without a verified email fails closed", () => {
    const claims = {
      sub: "missing-email",
      email_verified: true,
      idp_connection: "github",
    } as unknown as JWTPayload;

    expect(() => identityFromOidcTokenResponse(claims, {}, oidcConfig)).toThrow(
      "Sign-in identity is missing a verified email address",
    );
  });

  test("a GitHub token with an unverified email fails closed", () => {
    for (const email_verified of [undefined, false, "true"]) {
      const claims = {
        sub: "unverified-email",
        email: "customer@example.com",
        idp_connection: "github",
        ...(email_verified === undefined ? {} : { email_verified }),
      } as unknown as JWTPayload;

      expect(() => identityFromOidcTokenResponse(claims, {}, oidcConfig)).toThrow(
        "Sign-in identity is missing a verified email address",
      );
    }
  });

  test("userinfo cannot forge the broker or hide a verified GitHub staff email", () => {
    const missingSource = {
      sub: "userinfo-source-spoof",
      email: "customer@example.com",
    } as unknown as JWTPayload;
    expect(() =>
      identityFromOidcTokenResponse(
        missingSource,
        { idp_connection: "github" } as unknown as JWTPayload,
        oidcConfig,
      ),
    ).toThrow("Sign-in identity provider could not be verified");

    const verifiedStaffEmail = {
      sub: "userinfo-email-spoof",
      email: "staff@gascity.com",
      email_verified: true,
      idp_connection: "github",
    } as unknown as JWTPayload;
    expect(() =>
      identityFromOidcTokenResponse(
        verifiedStaffEmail,
        { email: "customer@example.com" } as unknown as JWTPayload,
        oidcConfig,
      ),
    ).toThrow("Gas City staff sign in with Gas City SSO");
  });
});

describe("ensureUser staff elevation is promote-only", () => {
  test("new staff login (assertedAdmin) creates an admin", async () => {
    await withStore(async (store) => {
      const user = await store.ensureUser(identity({ subject: "staff-new", assertedAdmin: true }));
      expect(user.role).toBe("admin");
    });
  });

  test("new external login (no assertion) creates a plain user", async () => {
    await withStore(async (store) => {
      const user = await store.ensureUser(identity({ subject: "ext-new" }));
      expect(user.role).toBe("user");
    });
  });

  test("an existing default user is promoted to admin on a staff login", async () => {
    await withStore(async (store) => {
      const first = await store.ensureUser(identity({ subject: "promote-me" }));
      expect(first.role).toBe("user");
      const second = await store.ensureUser(identity({ subject: "promote-me", assertedAdmin: true }));
      expect(second.role).toBe("admin");
    });
  });

  test("a manual admin is never downgraded when the claim is absent", async () => {
    await withStore(async (store) => {
      const u = await store.ensureUser(identity({ subject: "manual-admin" }));
      await store.setUserRoleForDev(u.id, "admin");
      const again = await store.ensureUser(identity({ subject: "manual-admin" })); // no assertion
      expect(again.role).toBe("admin");
    });
  });

  test("a deliberate moderator is preserved, not overridden to admin, on a staff login", async () => {
    await withStore(async (store) => {
      const u = await store.ensureUser(identity({ subject: "mod" }));
      await store.setUserRoleForDev(u.id, "moderator");
      const again = await store.ensureUser(identity({ subject: "mod", assertedAdmin: true }));
      expect(again.role).toBe("moderator");
    });
  });

  test("staff elevation is idempotent for an existing admin", async () => {
    await withStore(async (store) => {
      await store.ensureUser(identity({ subject: "admin-again", assertedAdmin: true }));
      const again = await store.ensureUser(identity({ subject: "admin-again", assertedAdmin: true }));
      expect(again.role).toBe("admin");
    });
  });
});
