import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JWTPayload } from "jose";
import { identityFromClaims } from "./auth";
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
