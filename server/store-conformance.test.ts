// Conformance suite: runs IDENTICAL assertions against BOTH RegistryStore impls so the
// FileRegistryStore double can't silently diverge from the production PostgresRegistryStore
// (TESTING.md §6.3/§8 — "proven double"). The Postgres lane runs against a real container
// in CI (a fresh database per suite, exercising init()'s migrate-on-boot DDL every run).
//
// Covered surfaces: users/roles, sessions, api tokens, cli device codes, the publish-request
// lifecycle (create/validate/approve/reject incl. terminal-state guard), ownership, dedup,
// pack name claims (approve-time pin + init() backfill), and audit. NOT yet covered on both
// lanes (file-only today, tracked as follow-up): reviews, stars, profile edits, github
// publish imports, and expiry semantics — do not read this suite as
// proving those. Known observable divergence (dev-only, tracked): FileRegistryStore returns its
// internal user object from ensureUser/getSession, so file-mode /api/me carries extra internal
// fields (gascityUserId, orgMember, ...) that PostgresRegistryStore projects away via
// sessionUser(); prod (Postgres) never exposes them.
//
// REGISTRY_TEST_DATABASE_URL = admin URL the Postgres lane mints fresh databases from.
// REGISTRY_TEST_REQUIRE_POSTGRES=1 turns its absence into a hard failure — this is how the
// PR gate satisfies "no silent skip" (TESTING.md §6.7/§11): CI sets both; locally, absence
// prints one loud warning and simply omits the lane (never a silent green).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import postgres from "postgres";
import { CLI_DEVICE_CODE_TTL_MS, CLI_DEVICE_CODE_INTERVAL_SECONDS, generateCliDeviceCodePair } from "./cli-auth";
import { AUTO_APPROVED_STATUS_REASON } from "./publish";
import { StoreConflictError, StoreValidationError, createStore } from "./store";
import { createTestDatabase } from "./test-db";
import type {
  IdentityClaims,
  PackNameClaim,
  PublishApprovalDecision,
  PublishRegistryEntry,
  PublishRequestInput,
  PublishRequestRow,
  RegistryStore,
  VerifiedPackOwnershipInput,
} from "./types";

const pgUrl = process.env.REGISTRY_TEST_DATABASE_URL?.trim();
if (process.env.REGISTRY_TEST_REQUIRE_POSTGRES === "1" && !pgUrl) {
  throw new Error(
    "store-conformance: REGISTRY_TEST_REQUIRE_POSTGRES=1 but REGISTRY_TEST_DATABASE_URL is unset — the PR gate must provision Postgres (TESTING.md §6.7).",
  );
}
if (!pgUrl) {
  console.warn(
    "[store-conformance] REGISTRY_TEST_DATABASE_URL unset — SKIPPING the Postgres lane locally. CI runs it against a real container.",
  );
}

type Lane = {
  name: "file" | "postgres";
  make: () => Promise<{ store: RegistryStore; dbUrl?: string; cleanup: () => Promise<void> }>;
};

const lanes: Lane[] = [
  {
    name: "file",
    make: async () => {
      const dir = await mkdtemp(join(tmpdir(), "registry-conformance-"));
      const store = createStore(undefined, join(dir, "registry.json"));
      await store.init();
      return {
        store,
        cleanup: async () => {
          await store.close();
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  },
  ...(pgUrl
    ? [
        {
          name: "postgres" as const,
          make: async () => {
            const db = await createTestDatabase(pgUrl);
            try {
              const store = createStore(db.url, undefined);
              await store.init(); // real migrate-on-boot DDL against a fresh database
              return {
                store,
                dbUrl: db.url,
                cleanup: async () => {
                  await store.close();
                  await db.drop();
                },
              };
            } catch (err) {
              // A migration failure is exactly what this lane exists to catch — drop the
              // orphaned database (and close the admin conn) so it surfaces the DDL error
              // cleanly instead of leaking a database + connection.
              await db.drop();
              throw err;
            }
          },
        },
      ]
    : []),
];

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
function identity(over: Partial<IdentityClaims> = {}): IdentityClaims {
  const h = uid("user");
  return {
    subject: `sub:${h}`,
    gasCityUserId: `gc:${h}`,
    handle: h,
    displayName: h,
    email: `${h}@dev.local`,
    ...over,
  };
}
function publishInput(name: string, over: Partial<PublishRequestInput> = {}): PublishRequestInput {
  return {
    repoUrl: "https://github.com/acme/registry-fixtures",
    commit: "a".repeat(40),
    packPath: `packs/${name}`,
    requestedName: name,
    requestedVersion: "0.1.0",
    requestedRef: "refs/heads/main",
    requestedDescription: `Release ${name}.`,
    ...over,
  };
}
function entry(name: string): PublishRegistryEntry {
  return {
    name,
    description: `${name} pack.`,
    source: `https://github.com/acme/registry-fixtures/tree/main/packs/${name}`,
    sourceKind: "git",
    release: {
      version: "0.1.0",
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      hash: `sha256:${"b".repeat(64)}`,
      description: `Release ${name}.`,
    },
  };
}
function ownershipInput(repoFull: string): VerifiedPackOwnershipInput {
  const [owner = "acme", name = "pack"] = repoFull.split("/");
  return {
    packKey: `${owner}--${name}`,
    sourceUrl: `https://github.com/${repoFull}/tree/main`,
    githubRepositoryId: `repo-${repoFull}`,
    githubRepositoryFullName: repoFull,
    githubRepositoryName: name,
    githubOwnerId: `owner-${owner}`,
    githubOwnerLogin: owner,
    githubOwnerType: "User",
    verificationMethod: "manual",
  };
}

type StoredEiaUser = {
  id: string;
  gascityUserId: string;
  status: "active" | "disabled";
};

type StoredIdentityUser = StoredEiaUser & { oidcSubject?: string };

async function disableUserForConformance(store: RegistryStore, dbUrl: string | undefined, userId: string) {
  if (store.kind === "file") {
    const users = (store as unknown as { users: Map<string, StoredEiaUser> }).users;
    const user = users.get(userId);
    if (!user) throw new Error(`File conformance user ${userId} not found.`);
    user.status = "disabled";
    return;
  }

  if (!dbUrl) throw new Error("Postgres conformance lane is missing its database URL.");
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const rows = await sql`UPDATE users SET status = 'disabled' WHERE id = ${userId} RETURNING id`;
    if (rows.length !== 1) throw new Error(`Postgres conformance user ${userId} not found.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Puts the store back in its pre-claim world (approved rows, no claims) so init()'s backfill
// has something to grandfather. The file lane has to persist the deletion too, because its
// init() re-reads state from disk.
async function dropNameClaimsForConformance(
  store: RegistryStore,
  dbUrl: string | undefined,
  names: string[],
) {
  if (store.kind === "file") {
    const internals = store as unknown as {
      nameClaims: Map<string, PackNameClaim>;
      save: () => Promise<void>;
    };
    for (const name of names) internals.nameClaims.delete(name);
    await internals.save();
    return;
  }

  if (!dbUrl) throw new Error("Postgres conformance lane is missing its database URL.");
  const sql = postgres(dbUrl, { max: 1 });
  try {
    await sql`DELETE FROM pack_name_claims WHERE name IN ${sql(names)}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function approvedPublishRequest(
  store: RegistryStore,
  adminId: string,
  submitterId: string,
  name: string,
  over: Partial<PublishRequestInput> = {},
  decision?: PublishApprovalDecision,
) {
  const created = await validatedPublishRequest(store, submitterId, name, over);
  return store.approvePublishRequest(adminId, created.id, decision);
}

// Approve a SECOND, differently-owned release of a name that is already claimed. Since the
// approve transaction re-checks the claim, the only way to reach that state is the documented
// staff re-pin — which is also the only way it happens in production. The backfill tests below use
// this purely to stand up two approved rows for one name; they drop the claims afterwards, so
// which repo the intermediate claim pointed at is irrelevant to what they assert.
const seedRepinDecision: PublishApprovalDecision = {
  namePinOverrideReason: "conformance: seeding a second approved release of this name",
};

// Approval is left to the caller so a test can approve requests in an order that differs from
// the order they were submitted in — which is the whole point of the pin-ordering cases.
async function validatedPublishRequest(
  store: RegistryStore,
  submitterId: string,
  name: string,
  over: Partial<PublishRequestInput> = {},
) {
  const created = await store.createPublishRequest(submitterId, publishInput(name, over), "web_session");
  await store.markPublishRequestValidated(created.id, entry(name));
  return created;
}

// Rewrites a stored request's id and pin-order timestamps in place. Needed to force an exact
// (reviewed_at, created_at) tie with chosen ids: request ids are random base64url, so a tie's
// winner is decided by the id tiebreak, and that is precisely where a locale-collated comparison
// diverges from a byte-wise one. Reaches past the public API on purpose — no supported call can
// manufacture a same-instant tie.
async function rewritePublishRequestForConformance(
  store: RegistryStore,
  dbUrl: string | undefined,
  currentId: string,
  patch: { id: string; createdAt: string; reviewedAt: string },
) {
  if (store.kind === "file") {
    const internals = store as unknown as {
      publishRequests: Map<string, PublishRequestRow>;
      save: () => Promise<void>;
    };
    const request = internals.publishRequests.get(currentId);
    if (!request) throw new Error(`File conformance publish request ${currentId} not found.`);
    internals.publishRequests.delete(currentId);
    internals.publishRequests.set(patch.id, {
      ...request,
      id: patch.id,
      createdAt: patch.createdAt,
      reviewedAt: patch.reviewedAt,
    });
    await internals.save();
    return;
  }

  if (!dbUrl) throw new Error("Postgres conformance lane is missing its database URL.");
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const rows = await sql`
      UPDATE pack_publish_requests
      SET id = ${patch.id},
          created_at = ${patch.createdAt}::text::timestamptz,
          reviewed_at = ${patch.reviewedAt}::text::timestamptz
      WHERE id = ${currentId}
      RETURNING id
    `;
    if (rows.length !== 1) throw new Error(`Postgres conformance publish request ${currentId} not found.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function storedUsersForEiaSubject(
  store: RegistryStore,
  dbUrl: string | undefined,
  subject: string,
): Promise<StoredEiaUser[]> {
  if (store.kind === "file") {
    const users = (store as unknown as { users: Map<string, StoredEiaUser> }).users;
    return [...users.values()]
      .filter((user) => user.gascityUserId === subject)
      .map(({ id, gascityUserId, status }) => ({ id, gascityUserId, status }));
  }

  if (!dbUrl) throw new Error("Postgres conformance lane is missing its database URL.");
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const rows = await sql`
      SELECT id, gascity_user_id, status FROM users WHERE gascity_user_id = ${subject}
    `;
    return rows.map((row) => ({
      id: String(row.id),
      gascityUserId: String(row.gascity_user_id),
      status: row.status === "disabled" ? "disabled" : "active",
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function storedUsersForIdentity(
  store: RegistryStore,
  dbUrl: string | undefined,
  oidcSubject: string,
  gascityUserId: string,
): Promise<StoredIdentityUser[]> {
  if (store.kind === "file") {
    const users = (
      store as unknown as { users: Map<string, StoredIdentityUser> }
    ).users;
    return [...users.values()]
      .filter(
        (user) => user.oidcSubject === oidcSubject || user.gascityUserId === gascityUserId,
      )
      .map(({ id, gascityUserId: stableId, oidcSubject: subject, status }) => ({
        id,
        gascityUserId: stableId,
        oidcSubject: subject,
        status,
      }));
  }

  if (!dbUrl) throw new Error("Postgres conformance lane is missing its database URL.");
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const rows = await sql`
      SELECT id, gascity_user_id, oidc_subject, status
      FROM users
      WHERE oidc_subject = ${oidcSubject} OR gascity_user_id = ${gascityUserId}
      ORDER BY id
    `;
    return rows.map((row) => ({
      id: String(row.id),
      gascityUserId: String(row.gascity_user_id),
      oidcSubject: row.oidc_subject ? String(row.oidc_subject) : undefined,
      status: row.status === "disabled" ? "disabled" : "active",
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

for (const lane of lanes) {
  describe(`RegistryStore conformance (${lane.name})`, () => {
    let store: RegistryStore;
    let dbUrl: string | undefined;
    let cleanup: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      ({ store, dbUrl, cleanup } = await lane.make());
    });
    afterAll(async () => {
      if (cleanup) await cleanup();
    });

    test("kind matches the backend", () => {
      expect(store.kind).toBe(lane.name);
    });

    test("ping resolves against a healthy store", async () => {
      await store.ping(); // file: no-op; postgres: real SELECT 1 against the CI container
    });

    test("ensureUser upserts on subject and elevates role promote-only", async () => {
      const id = identity({ displayName: "First" });
      const u1 = await store.ensureUser(id);
      expect(u1.role).toBe("user");
      expect(u1.displayName).toBe("First");
      // Re-login upserts on the same subject (same row id) but does NOT clobber the stored
      // profile — the display name is preserved so a token can't overwrite a user's edit
      // (updateUserProfile is the deliberate path).
      const u2 = await store.ensureUser({ ...id, displayName: "Ignored On Relogin" });
      expect(u2.id).toBe(u1.id);
      expect(u2.displayName).toBe("First");

      // assertedAdmin promotes to admin, and a later non-staff login (same subject) does
      // NOT downgrade — the elevation is promote-only.
      const staffId = identity({ assertedAdmin: true });
      const staff = await store.ensureUser(staffId);
      expect(staff.role).toBe("admin");
      const relogin = await store.ensureUser({ ...staffId, assertedAdmin: false });
      expect(relogin.id).toBe(staff.id);
      expect(relogin.role).toBe("admin");

      const moderated = await store.setUserRoleForDev(u1.id, "moderator");
      expect(moderated.role).toBe("moderator");
    });

    test("ensureUser live-syncs org membership; isOrgMember reflects the last login", async () => {
      const id = identity({ assertedOrgMember: true });
      const member = await store.ensureUser(id);
      expect(await store.isOrgMember(member.id)).toBe(true);
      expect(member.role).toBe("user"); // publisher entitlement only — never a role elevation

      // De-provision on the UPDATE path (true -> false): losing the realm role clears it.
      await store.ensureUser({ ...id, assertedOrgMember: false });
      expect(await store.isOrgMember(member.id)).toBe(false);

      // Re-provision on the UPDATE path (false -> true): a plain user who later joins @gascity.
      const joiner = identity();
      const joinerUser = await store.ensureUser(joiner);
      expect(await store.isOrgMember(joinerUser.id)).toBe(false);
      await store.ensureUser({ ...joiner, assertedOrgMember: true });
      expect(await store.isOrgMember(joinerUser.id)).toBe(true);

      // A plain user is never an org member.
      const outsider = await store.ensureUser(identity());
      expect(await store.isOrgMember(outsider.id)).toBe(false);
    });

    test("EIA first use preserves existing account state and creates only missing users", async () => {
      const existingIdentity = identity({
        displayName: "Kept Profile",
        assertedOrgMember: true,
      });
      const existing = await store.ensureUser(existingIdentity);
      await store.setUserRoleForDev(existing.id, "moderator");

      const resolved = await store.getOrCreateUserForEiaSubject(existingIdentity.gasCityUserId);
      expect(resolved).toMatchObject({
        id: existing.id,
        displayName: "Kept Profile",
        role: "moderator",
        status: "active",
      });
      expect(await store.isOrgMember(existing.id)).toBe(true);

      const newSubject = `usr_${uid("eia")}`;
      const created = await store.getOrCreateUserForEiaSubject(newSubject);
      expect(created).toMatchObject({ role: "user", status: "active" });
      expect(created?.id).toBeTruthy();
      expect(await store.isOrgMember(created!.id)).toBe(false);
      expect((await store.getOrCreateUserForEiaSubject(newSubject))?.id).toBe(created?.id);

      const distinctSubject = `usr_${uid("eia-distinct")}`;
      const distinct = await store.getOrCreateUserForEiaSubject(distinctSubject);
      expect(distinct?.id).toBeTruthy();
      expect(distinct!.id).not.toBe(created!.id);

      const concurrentSubject = `usr_${uid("eia-race")}`;
      const concurrent = await Promise.all([
        store.getOrCreateUserForEiaSubject(concurrentSubject),
        store.getOrCreateUserForEiaSubject(concurrentSubject),
      ]);
      expect(concurrent[0]).not.toBeNull();
      expect(concurrent[1]).not.toBeNull();
      expect(concurrent[0]!.id.length).toBeGreaterThan(0);
      expect(concurrent[1]!.id).toBe(concurrent[0]!.id);

      const disabledIdentity = identity({ displayName: "Disabled Profile" });
      const disabled = await store.ensureUser(disabledIdentity);
      await disableUserForConformance(store, dbUrl, disabled.id);

      expect(await store.getOrCreateUserForEiaSubject(disabledIdentity.gasCityUserId)).toBeNull();
      expect(await storedUsersForEiaSubject(store, dbUrl, disabledIdentity.gasCityUserId)).toEqual([
        {
          id: disabled.id,
          gascityUserId: disabledIdentity.gasCityUserId,
          status: "disabled",
        },
      ]);
    });

    test("resolved OIDC migrates a preexisting native user in place and converges with EIA", async () => {
      const nativeSubject = `sub:${uid("native")}`;
      const stableId = `usr_${uid("stable")}`;
      const nativeIdentity = identity({
        subject: nativeSubject,
        gasCityUserId: nativeSubject,
        displayName: "Native Profile",
      });
      const nativeUser = await store.ensureUser(nativeIdentity);

      const resolvedUser = await store.ensureUser({ ...nativeIdentity, gasCityUserId: stableId });
      const eiaUser = await store.getOrCreateUserForEiaSubject(stableId);

      expect(resolvedUser.id).toBe(nativeUser.id);
      expect(eiaUser?.id).toBe(nativeUser.id);
      expect(await storedUsersForIdentity(store, dbUrl, nativeSubject, stableId)).toEqual([
        {
          id: nativeUser.id,
          gascityUserId: stableId,
          oidcSubject: nativeSubject,
          status: "active",
        },
      ]);
    });

    test("resolved OIDC fails closed without corrupting preexisting split principals", async () => {
      const nativeSubject = `sub:${uid("split-native")}`;
      const stableId = `usr_${uid("split-stable")}`;
      const nativeIdentity = identity({ subject: nativeSubject, gasCityUserId: nativeSubject });
      const nativeUser = await store.ensureUser(nativeIdentity);
      const eiaUser = await store.getOrCreateUserForEiaSubject(stableId);
      expect(eiaUser).not.toBeNull();
      await store.createApiToken(nativeUser.id, { label: "native-state" });
      await store.createApiToken(eiaUser!.id, { label: "eia-state" });

      const log = spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          store.ensureUser({ ...nativeIdentity, gasCityUserId: stableId }),
        ).rejects.toBeInstanceOf(StoreConflictError);
        expect(log).toHaveBeenCalledWith("[registry] identity convergence conflict");
        expect(JSON.stringify(log.mock.calls)).not.toContain(nativeSubject);
        expect(JSON.stringify(log.mock.calls)).not.toContain(stableId);
      } finally {
        log.mockRestore();
      }

      expect(await storedUsersForIdentity(store, dbUrl, nativeSubject, stableId)).toHaveLength(2);
      expect(await store.listApiTokens(nativeUser.id)).toHaveLength(1);
      expect(await store.listApiTokens(eiaUser!.id)).toHaveLength(1);
    });

    test("native fallback cannot replace an established Accounts stable identity", async () => {
      const nativeSubject = `sub:${uid("fallback-native")}`;
      const stableId = `usr_${uid("fallback-stable")}`;
      const nativeIdentity = identity({ subject: nativeSubject, gasCityUserId: nativeSubject });
      const nativeUser = await store.ensureUser(nativeIdentity);
      await store.ensureUser({ ...nativeIdentity, gasCityUserId: stableId });

      const [fallbackUser, eiaUser, resolvedUser] = await Promise.all([
        store.ensureUser(nativeIdentity),
        store.getOrCreateUserForEiaSubject(stableId),
        store.ensureUser({ ...nativeIdentity, gasCityUserId: stableId }),
      ]);

      expect(fallbackUser.id).toBe(nativeUser.id);
      expect(eiaUser?.id).toBe(nativeUser.id);
      expect(resolvedUser.id).toBe(nativeUser.id);
      expect(await storedUsersForIdentity(store, dbUrl, nativeSubject, stableId)).toEqual([
        {
          id: nativeUser.id,
          gascityUserId: stableId,
          oidcSubject: nativeSubject,
          status: "active",
        },
      ]);
    });

    test("sessions round-trip and destroy", async () => {
      const user = await store.ensureUser(identity());
      const created = await store.createSession(user.id);
      expect(created.token.length).toBeGreaterThan(10);
      expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now());
      const rec = await store.getSession(created.token);
      expect(rec?.user.id).toBe(user.id);
      expect(rec?.csrfToken).toBe(created.csrfToken);
      await store.destroySession(created.token);
      expect(await store.getSession(created.token)).toBeNull();
    });

    test("api tokens create, authenticate, list, revoke", async () => {
      const user = await store.ensureUser(identity());
      const created = await store.createApiToken(user.id, { label: "conformance token" });
      expect(created.token.startsWith("gcr_")).toBe(true);
      const auth = await store.getUserForApiToken(created.token);
      expect(auth?.user.id).toBe(user.id);
      const list = await store.listApiTokens(user.id);
      expect(list.some((t) => t.label === "conformance token")).toBe(true);
      await store.revokeApiToken(user.id, created.id);
      expect(await store.getUserForApiToken(created.token)).toBeNull();
    });

    test("cli device codes approve (mint one token) and deny (mint none)", async () => {
      const user = await store.ensureUser(identity());

      const approvedPair = generateCliDeviceCodePair();
      await store.createCliDeviceCode({
        deviceCode: approvedPair.deviceCode,
        userCode: approvedPair.userCode,
        expiresAt: new Date(Date.now() + CLI_DEVICE_CODE_TTL_MS),
        intervalSeconds: CLI_DEVICE_CODE_INTERVAL_SECONDS,
      });
      expect((await store.pollCliDeviceCode(approvedPair.deviceCode)).status).toBe("pending");
      await store.approveCliDeviceCode(user.id, approvedPair.userCode);
      const polled = await store.pollCliDeviceCode(approvedPair.deviceCode);
      expect(polled.status).toBe("approved");
      if (polled.status !== "approved") throw new Error("unreachable");
      expect((await store.getUserForApiToken(polled.token.token))?.user.id).toBe(user.id);
      // Single-use: a second poll after consumption returns expired and mints NO new token
      // (guards the device-code replay path — the pg store enforces it via consumed_at IS NULL).
      expect((await store.pollCliDeviceCode(approvedPair.deviceCode)).status).toBe("expired");

      const deniedPair = generateCliDeviceCodePair();
      await store.createCliDeviceCode({
        deviceCode: deniedPair.deviceCode,
        userCode: deniedPair.userCode,
        expiresAt: new Date(Date.now() + CLI_DEVICE_CODE_TTL_MS),
        intervalSeconds: CLI_DEVICE_CODE_INTERVAL_SECONDS,
      });
      await store.denyCliDeviceCode(user.id, deniedPair.userCode);
      expect((await store.pollCliDeviceCode(deniedPair.deviceCode)).status).toBe("denied");
    });

    // Both impls normalize through normalizePublishRequestInput, so the name grammar is a store
    // invariant on both lanes and not just a route check: `requested_name` is otherwise unbounded
    // text, and one approved over-long name makes `gc` reject the entire catalog.
    test("publish create refuses a pack name no registry client could parse", async () => {
      const submitter = await store.ensureUser(identity());
      await expect(
        store.createPublishRequest(submitter.id, publishInput(`acme/${"a".repeat(65)}`), "web_session"),
      ).rejects.toThrow(/64 characters/);
      await expect(
        store.createPublishRequest(submitter.id, publishInput("acme/twin--team"), "web_session"),
      ).rejects.toThrow(/consecutive dashes/);
      // The cap is per segment, not on the whole name: 64 + 64 is a legal scoped name.
      const maxLength = `acme/${"a".repeat(64)}`;
      const created = await store.createPublishRequest(submitter.id, publishInput(maxLength), "web_session");
      expect(created.requestedName).toBe(maxLength);
    });

    test("publish lifecycle: create -> validated -> approved is observable served state", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = uid("pack");

      const created = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      expect(created.status).toBe("pending_validation");
      expect(created.submissionMethod).toBe("web_session");

      const validated = await store.markPublishRequestValidated(created.id, entry(name));
      expect(validated.status).toBe("pending_review");
      expect(validated.registryEntry?.release.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

      const approved = await store.approvePublishRequest(admin.id, created.id);
      expect(approved.status).toBe("approved");
      expect(approved.reviewedBy?.id).toBe(admin.id);
      expect(approved.reviewedAt).toBeTruthy();

      expect((await store.listApprovedPublishRequests()).some((r) => r.id === created.id)).toBe(true);
      expect((await store.listAccountPublishRequests(submitter.id)).some((r) => r.id === created.id)).toBe(true);
      expect((await store.listPublishRequests()).some((r) => r.id === created.id)).toBe(true);
    });

    test("publish comments and versioned read acknowledgements stay store-parity safe", async () => {
      const submitter = await store.ensureUser(identity());
      const staff = await store.ensureUser(identity({ assertedAdmin: true }));
      const request = await validatedPublishRequest(store, submitter.id, uid("feedback"));

      const staffComment = await store.addPublishRequestComment({
        publishRequestId: request.id,
        actorUserId: staff.id,
        authorRole: "registry",
        actionRequiredBy: "submitter",
        body: "  Please clarify the runtime requirement.  ",
      });
      expect(staffComment.body).toBe("Please clarify the runtime requirement.");
      const unread = await store.getPublishRequest(request.id);
      expect(unread?.actionRequiredBy).toBe("submitter");
      expect(unread?.submitterUnreadAt).toBeTruthy();
      expect((await store.listPublishRequestComments(request.id)).map(({ body }) => body))
        .toEqual(["Please clarify the runtime requirement."]);

      await store.markPublishRequestRead(submitter.id, request.id, "2000-01-01T00:00:00.000Z");
      expect((await store.getPublishRequest(request.id))?.submitterUnreadAt).toBe(unread?.submitterUnreadAt);
      await store.markPublishRequestRead(submitter.id, request.id, unread!.submitterUnreadAt!);
      expect((await store.getPublishRequest(request.id))?.submitterUnreadAt).toBeNull();

      await store.addPublishRequestComment({
        publishRequestId: request.id,
        actorUserId: submitter.id,
        authorRole: "submitter",
        actionRequiredBy: "registry",
        body: "The README now explains it.",
      });
      expect((await store.getPublishRequest(request.id))?.actionRequiredBy).toBe("registry");
      expect((await store.listPublishRequestComments(request.id)).map(({ body }) => body))
        .toEqual(["Please clarify the runtime requirement.", "The README now explains it."]);

      await expect(store.addPublishRequestComment({
        publishRequestId: request.id,
        actorUserId: submitter.id,
        authorRole: "submitter",
        actionRequiredBy: "registry",
        body: "😀".repeat(4_001),
      })).rejects.toBeInstanceOf(StoreValidationError);
      await store.rejectPublishRequest(staff.id, request.id, "not ready");
      await expect(store.addPublishRequestComment({
        publishRequestId: request.id,
        actorUserId: submitter.id,
        authorRole: "submitter",
        actionRequiredBy: "registry",
        body: "reply",
      })).rejects.toMatchObject({ code: "REQUEST_TERMINAL", status: 409 });
    });

    test("staff status changes notify once and advance the unread version", async () => {
      const submitter = await store.ensureUser(identity());
      const name = uid("feedback-status");
      const request = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      const failed = await store.markPublishRequestValidationFailed(
        request.id,
        "missing runtime requirement",
        { notifySubmitter: true },
      );
      const firstVersion = failed.submitterUnreadAt!;
      await store.markPublishRequestRead(submitter.id, request.id, firstVersion);
      const repeated = await store.markPublishRequestValidationFailed(
        request.id,
        "missing runtime requirement",
        { notifySubmitter: true },
      );
      expect(repeated.submitterUnreadAt).toBeNull();

      const validated = await store.markPublishRequestValidated(request.id, entry(name), {
        notifySubmitter: true,
      });
      expect(validated.submitterUnreadAt).toBeTruthy();
      expect(validated.submitterUnreadAt! > firstVersion).toBe(true);
    });

    test("publish lifecycle: reject terminates with a reason and never serves", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = uid("pack");
      const created = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      await store.markPublishRequestValidated(created.id, entry(name));
      const rejected = await store.rejectPublishRequest(admin.id, created.id, "conformance reject reason");
      expect(rejected.status).toBe("rejected");
      expect(rejected.statusReason).toContain("conformance reject reason");
      expect(rejected.reviewedBy?.id).toBe(admin.id);
      expect((await store.listApprovedPublishRequests()).some((r) => r.id === created.id)).toBe(false);
      // Terminal: a rejected request can never be approved into the served catalog.
      await expect(
        store.approvePublishRequest(admin.id, created.id, { ownershipOverrideReason: "x" }),
      ).rejects.toBeInstanceOf(StoreValidationError);
    });

    test("publish lifecycle: withdraw takes down an approved publish and is terminal", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = uid("pack");
      const created = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      await store.markPublishRequestValidated(created.id, entry(name));
      await store.approvePublishRequest(admin.id, created.id);
      expect((await store.listApprovedPublishRequests()).some((r) => r.id === created.id)).toBe(true);

      const withdrawn = await store.withdrawPublishRequest(admin.id, created.id, "conformance takedown reason");
      expect(withdrawn.status).toBe("withdrawn");
      expect(withdrawn.statusReason).toContain("conformance takedown reason");
      expect(withdrawn.reviewedBy?.id).toBe(admin.id);
      expect(withdrawn.reviewedAt).toBeTruthy();
      // registryEntry is intentionally retained (takedown evidence + version-conflict-guard input).
      expect(withdrawn.registryEntry?.name).toBe(name);

      // No longer served; surfaced in the scoped withdrawn lookup; still visible on the admin + account lists.
      expect((await store.listApprovedPublishRequests()).some((r) => r.id === created.id)).toBe(false);
      expect(
        (await store.listWithdrawnPublishRequestsForVersion(name, "0.1.0")).some((r) => r.id === created.id),
      ).toBe(true);
      expect((await store.listPublishRequests()).some((r) => r.id === created.id)).toBe(true);

      // Terminal: a withdrawn request cannot be re-approved, re-validated, or rejected.
      await expect(store.approvePublishRequest(admin.id, created.id)).rejects.toBeInstanceOf(StoreValidationError);
      await expect(store.markPublishRequestValidated(created.id, entry(name))).rejects.toBeInstanceOf(StoreValidationError);
      await expect(store.rejectPublishRequest(admin.id, created.id, "x")).rejects.toBeInstanceOf(StoreValidationError);
    });

    test("withdraw only applies to approved requests; approved is immune to reject/re-validate", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = uid("pack");
      const created = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      // pending_validation cannot be withdrawn.
      await expect(store.withdrawPublishRequest(admin.id, created.id, "x")).rejects.toBeInstanceOf(StoreValidationError);
      await store.markPublishRequestValidated(created.id, entry(name));
      // pending_review cannot be withdrawn either (only approved).
      await expect(store.withdrawPublishRequest(admin.id, created.id, "x")).rejects.toBeInstanceOf(StoreValidationError);

      await store.approvePublishRequest(admin.id, created.id);
      // An approved (served) publish cannot be rejected or re-validated out from under itself —
      // takedown is withdraw-only, so the served state and its audit trail stay honest.
      await expect(store.rejectPublishRequest(admin.id, created.id, "x")).rejects.toBeInstanceOf(StoreValidationError);
      await expect(store.markPublishRequestValidated(created.id, entry(name))).rejects.toBeInstanceOf(StoreValidationError);
      await expect(store.markPublishRequestValidationFailed(created.id, "x")).rejects.toBeInstanceOf(StoreValidationError);
      expect((await store.listApprovedPublishRequests()).some((r) => r.id === created.id)).toBe(true);
    });

    test("a withdrawn name@version can be re-submitted and reinstated (dedup ignores withdrawn)", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = uid("pack");
      const first = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      await store.markPublishRequestValidated(first.id, entry(name));
      await store.approvePublishRequest(admin.id, first.id);
      await store.withdrawPublishRequest(admin.id, first.id, "takedown");

      // A withdrawn row must not block a fresh submission of the same name@version — otherwise the
      // takedown is permanent and un-reinstatable. Re-submitting yields a NEW pending request.
      const reinstated = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      expect(reinstated.id).not.toBe(first.id);
      expect(reinstated.status).toBe("pending_validation");
      await store.markPublishRequestValidated(reinstated.id, entry(name));
      expect((await store.approvePublishRequest(admin.id, reinstated.id)).status).toBe("approved");
      expect((await store.listApprovedPublishRequests()).some((r) => r.id === reinstated.id)).toBe(true);
      // The original withdrawn row stays terminal.
      expect(
        (await store.listWithdrawnPublishRequestsForVersion(name, "0.1.0")).some((r) => r.id === first.id),
      ).toBe(true);
    });

    test("re-validating a validation_failed request clears the stale failure reason (both lanes)", async () => {
      const submitter = await store.ensureUser(identity());
      const name = uid("pack");
      const created = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      const failed = await store.markPublishRequestValidationFailed(created.id, "hash mismatch");
      expect(failed.status).toBe("validation_failed");
      expect(failed.statusReason).toContain("hash mismatch");
      // The submitter fixes the repo and re-runs validate: the pending_review row must NOT carry the
      // stale failure reason (PG previously left status_reason set while File cleared it).
      const revalidated = await store.markPublishRequestValidated(created.id, entry(name));
      expect(revalidated.status).toBe("pending_review");
      expect(revalidated.statusReason).toBeUndefined();
    });

    test("validation failure records the error and clears the entry", async () => {
      const submitter = await store.ensureUser(identity());
      const name = uid("pack");
      const created = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      const failed = await store.markPublishRequestValidationFailed(created.id, "hash mismatch");
      expect(failed.status).toBe("validation_failed");
      expect(failed.statusReason).toContain("hash mismatch");
      expect(failed.registryEntry).toBeUndefined();
    });

    test("submitter-scoped dedup: idempotent re-submit, supersede on divergence, per-submitter", async () => {
      const a = await store.ensureUser(identity());
      const b = await store.ensureUser(identity());
      const name = uid("pack");

      const first = await store.createPublishRequest(a.id, publishInput(name), "web_session");
      const again = await store.createPublishRequest(a.id, publishInput(name), "web_session");
      expect(again.id).toBe(first.id); // idempotent for the same submitter + identical input

      // Same submitter, same name+version, different commit -> the submitter's own pending row is
      // superseded and a fresh one lands. Previously a hard 409 with no way out.
      const corrected = await store.createPublishRequest(
        a.id,
        publishInput(name, { commit: "c".repeat(40) }),
        "web_session",
      );
      expect(corrected.id).not.toBe(first.id);
      expect(corrected.status).toBe("pending_validation");

      // A different submitter with identical input gets a distinct row.
      const other = await store.createPublishRequest(b.id, publishInput(name), "web_session");
      expect(other.id).not.toBe(first.id);
    });

    // (d) Self-supersede. Each case names the mutation it kills, because the whole point of this
    // block is that a submitter can correct a mistake without a staff round-trip while an
    // already-SERVED release still cannot be swapped under a version clients have pinned.
    test("supersede: a divergent resubmit closes the submitter's own pending_review row", async () => {
      const submitter = await store.ensureUser(identity());
      const name = uid("pack");
      const first = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      await store.markPublishRequestValidated(first.id, entry(name));
      expect((await store.getPublishRequest(first.id))?.status).toBe("pending_review");

      const second = await store.createPublishRequest(
        submitter.id,
        publishInput(name, { commit: "c".repeat(40) }),
        "web_session",
      );
      expect(second.id).not.toBe(first.id);

      const closed = await store.getPublishRequest(first.id);
      expect(closed?.status).toBe("rejected");
      // Names the superseder, so status_reason alone answers "replaced by what?" on all three
      // status surfaces without a new PublishRequestStatus.
      expect(closed?.statusReason).toContain(second.id);
      // No staff member rejected this: reporting one would be a false audit trail.
      expect(closed?.reviewedBy).toBeUndefined();
    });

    test("supersede: a validation_failed row can be corrected and resubmitted", async () => {
      // The sharpest half of (d): validation_failed is inside the dedup's blocking set, so before
      // this a submitter whose validation failed could not fix the commit and resubmit AT ALL.
      const submitter = await store.ensureUser(identity());
      const name = uid("pack");
      const first = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      await store.markPublishRequestValidationFailed(first.id, "hash mismatch");
      expect((await store.getPublishRequest(first.id))?.status).toBe("validation_failed");

      const second = await store.createPublishRequest(
        submitter.id,
        publishInput(name, { commit: "c".repeat(40) }),
        "web_session",
      );
      expect(second.id).not.toBe(first.id);
      const closed = await store.getPublishRequest(first.id);
      expect(closed?.status).toBe("rejected");
      expect(closed?.statusReason).toContain(second.id);
    });

    test("supersede: an APPROVED release is never superseded", async () => {
      // Widening supersede past isPreApprovalStatus would be an unaudited content swap on bits
      // pinned clients are already fetching.
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ handle: uid("admin") }));
      const name = uid("pack");
      const first = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      await store.markPublishRequestValidated(first.id, entry(name));
      const approved = await store.approvePublishRequest(admin.id, first.id);
      expect(approved.status).toBe("approved");

      await expect(
        store.createPublishRequest(
          submitter.id,
          publishInput(name, { commit: "c".repeat(40) }),
          "web_session",
        ),
      ).rejects.toBeInstanceOf(StoreConflictError);
      const untouched = await store.getPublishRequest(first.id);
      expect(untouched?.status).toBe("approved");
      expect(untouched?.statusReason).toBeUndefined();
    });

    test("supersede: a superseded row is never a withdrawn row", async () => {
      // Implementing supersede as `withdrawn` would feed H4's lineage filter (same submitter), so
      // the submitter's own replacement would 409 PUBLISH_VERSION_WITHDRAWN — a self-DoS that burns
      // the version permanently — and would hand any user a way to mint withdrawn rows at will.
      const submitter = await store.ensureUser(identity());
      const name = uid("pack");
      const first = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      await store.markPublishRequestValidated(first.id, entry(name));
      const second = await store.createPublishRequest(
        submitter.id,
        publishInput(name, { commit: "c".repeat(40) }),
        "web_session",
      );
      expect(second.id).not.toBe(first.id);
      const withdrawn = await store.listWithdrawnPublishRequestsForVersion(name, "0.1.0");
      expect(withdrawn.map((row) => row.id)).not.toContain(first.id);
      expect(withdrawn).toHaveLength(0);
    });

    test("supersede: an identical resubmit still replays, and another submitter's row is untouched", async () => {
      const submitter = await store.ensureUser(identity());
      const other = await store.ensureUser(identity());
      const name = uid("pack");
      const first = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      await store.markPublishRequestValidated(first.id, entry(name));

      // A CI retry must not churn a new row per attempt.
      const replay = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      expect(replay.id).toBe(first.id);
      expect(replay.status).toBe("pending_review");

      // Cross-submitter: the dedup (and therefore the supersede) is submitter-scoped, so a
      // stranger's divergent submission of the same name+version cannot close somebody else's row.
      const foreign = await store.createPublishRequest(
        other.id,
        publishInput(name, { commit: "c".repeat(40) }),
        "web_session",
      );
      expect(foreign.id).not.toBe(first.id);
      expect((await store.getPublishRequest(first.id))?.status).toBe("pending_review");
    });

    test("supersede: a resubmit that changes only the ref lands the new ref", async () => {
      // isSamePublishRequest used to ignore requestedRef/requestedDescription, so this returned the
      // STALE row and silently dropped the correction — which makes "fix the ref and retry"
      // impossible even with supersede shipping.
      const submitter = await store.ensureUser(identity());
      const name = uid("pack");
      const first = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      expect(first.requestedRef).toBe("refs/heads/main");

      const retagged = await store.createPublishRequest(
        submitter.id,
        publishInput(name, { requestedRef: "refs/tags/v0.1.0" }),
        "web_session",
      );
      expect(retagged.id).not.toBe(first.id);
      expect(retagged.requestedRef).toBe("refs/tags/v0.1.0");
      expect((await store.getPublishRequest(first.id))?.status).toBe("rejected");
    });

    // The description half of the same dedup key, which the ref case above cannot cover: drop it
    // from isSamePublishRequest and this resubmit returns the STALE row, so the correction is
    // silently discarded — and requestedDescription is what becomes the published catalog
    // description (server/publish-validation.ts), so the wrong text ships under the right version.
    test("supersede: a resubmit that changes only the description lands the new description", async () => {
      const submitter = await store.ensureUser(identity());
      const name = uid("pack");
      const first = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
      const edited = await store.createPublishRequest(
        submitter.id,
        publishInput(name, { requestedDescription: "Corrected release notes." }),
        "web_session",
      );
      expect(edited.id).not.toBe(first.id);
      expect(edited.requestedDescription).toBe("Corrected release notes.");
      expect((await store.getPublishRequest(first.id))?.status).toBe("rejected");
    });

    // (a) Unattended approval plumbing. Nothing here decides WHETHER a release may auto-approve —
    // that predicate lives in app.ts — but every one of these is a store behaviour the predicate
    // depends on, so each case names the mutation it kills.
    test("auto-approve: the approval is recorded with no reviewer and a visible reason", async () => {
      // Mutation killed: reusing approvePublishRequest(submitterId, ...) — an audit trail and a
      // reviewed_by field claiming the publisher approved their own release, and an auto-approval
      // indistinguishable from a staff one in every surface staff actually look at.
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = uid("pack");

      const first = await approvedPublishRequest(store, admin.id, submitter.id, name);
      expect(first.reviewedBy?.id).toBe(admin.id);
      // The staff path keeps blanking status_reason: the auto reason must not leak onto it.
      expect(first.statusReason).toBeUndefined();

      const repeat = await validatedPublishRequest(store, submitter.id, name, {
        requestedVersion: "0.2.0",
      });
      const auto = await store.autoApprovePublishRequest(repeat.id, {
        ownershipBasis: "repo_proven",
        autoApprove: { precedentRequestId: first.id, ref: "refs/tags/v0.2.0", eventName: "push" },
      });
      expect(auto.status).toBe("approved");
      expect(auto.reviewedBy).toBeUndefined();
      expect(auto.reviewedAt).toBeTruthy();
      expect(auto.statusReason).toBe(AUTO_APPROVED_STATUS_REASON);
      // It is really served, not just marked.
      expect((await store.listApprovedPublishRequests()).some((r) => r.id === repeat.id)).toBe(true);
      // Re-read: the reason and the NULL reviewer survive a round trip, which is what the three
      // status surfaces and /api/admin/publish-requests actually read.
      const reread = await store.getPublishRequest(repeat.id);
      expect(reread?.statusReason).toBe(AUTO_APPROVED_STATUS_REASON);
      expect(reread?.reviewedBy).toBeUndefined();
      // The claim was matched, not re-minted or moved.
      const claim = await store.getPackNameClaim(name);
      expect(claim?.sourceRequestId).toBe(first.id);
    });

    test("auto-approve: getServedPublishPrecedent tracks the newest SERVED release", async () => {
      // Mutations killed: returning any/oldest approved row (a publisher could revert an
      // established name to a stale packPath unattended), and ignoring status (which would break
      // the per-pack kill switch — withdraw everything and the next release must face a human).
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = uid("pack");
      expect(await store.getServedPublishPrecedent(name)).toBeNull();

      const first = await approvedPublishRequest(store, admin.id, submitter.id, name, {
        packPath: "packs/original",
      });
      expect((await store.getServedPublishPrecedent(name))?.id).toBe(first.id);

      const second = await approvedPublishRequest(store, admin.id, submitter.id, name, {
        requestedVersion: "0.2.0",
        packPath: "packs/moved",
      });
      const newest = await store.getServedPublishPrecedent(name);
      expect(newest?.id).toBe(second.id);
      expect(newest?.packPath).toBe("packs/moved");

      // A withdrawn release is not a precedent; the older one becomes current again.
      await store.withdrawPublishRequest(admin.id, second.id, "conformance takedown");
      expect((await store.getServedPublishPrecedent(name))?.id).toBe(first.id);
      // Whole-pack takedown: no precedent at all, even though the name claim survives.
      await store.withdrawPublishRequest(admin.id, first.id, "conformance takedown");
      expect(await store.getServedPublishPrecedent(name)).toBeNull();
      expect(await store.getPackNameClaim(name)).not.toBeNull();
      // Another name's releases never answer for this one.
      expect(await store.getServedPublishPrecedent(uid("pack"))).toBeNull();
    });

    // The precedent decides which pack_path a repeat release is held to, so a coin flip here means a
    // staff-approved monorepo move silently reverts to the stale directory on a fast machine and
    // works on a slow one. Ordering by SUBMISSION made it exactly that: two releases created in the
    // same millisecond fall through to a byte-wise compare of random ids. Approval order is both
    // deterministic here and the semantically right answer — a human blessing the move is what
    // establishes the new path.
    test("auto-approve: the precedent follows APPROVAL order, not submission order", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = `${uid("scope")}/${uid("pack")}`;

      const older = await validatedPublishRequest(store, submitter.id, name, {
        packPath: "packs/original",
      });
      const newer = await validatedPublishRequest(store, submitter.id, name, {
        requestedVersion: "0.2.0",
        packPath: "packs/moved",
      });
      // Approve the original path, then seed its stored approval timestamp ahead of both wall
      // clocks. This makes the regression deterministic in BOTH lanes: merely stamping `now()`
      // on the later approval would leave the older row as the apparent precedent.
      await store.approvePublishRequest(admin.id, older.id);
      const priorApproval = "2099-02-01T00:00:00.000Z";
      await rewritePublishRequestForConformance(store, dbUrl, older.id, {
        id: older.id,
        createdAt: older.createdAt,
        reviewedAt: priorApproval,
      });

      // Approve the MOVE second, which is what a legitimate monorepo move looks like. Freezing the
      // file clock also directly covers the millisecond tie that exposed the CI flake.
      if (store.kind === "file") setSystemTime(new Date("2026-02-02T00:00:00.000Z"));
      try {
        await store.approvePublishRequest(admin.id, newer.id);
      } finally {
        if (store.kind === "file") setSystemTime();
      }

      const reread = await store.getPublishRequest(newer.id);
      expect(Date.parse(reread!.reviewedAt!)).toBeGreaterThan(Date.parse(priorApproval));
      const precedent = await store.getServedPublishPrecedent(name);
      expect(precedent?.id).toBe(newer.id);
      expect(precedent?.packPath).toBe("packs/moved");
    });

    test("auto-approve: listStaffRefusedPublishRequestsForName spans every version", async () => {
      // Mutation killed: scoping it to one version, which collapses the takedown clause into H4 —
      // a takedown of 1.0.0 for malware would then stop nothing but a re-publish of 1.0.0.
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = uid("pack");
      const other = uid("pack");

      const takenDown = await approvedPublishRequest(store, admin.id, submitter.id, name);
      await store.withdrawPublishRequest(admin.id, takenDown.id, "conformance takedown");
      const laterVersion = await approvedPublishRequest(store, admin.id, submitter.id, name, {
        requestedVersion: "0.2.0",
      });
      await store.withdrawPublishRequest(admin.id, laterVersion.id, "conformance takedown");
      const served = await approvedPublishRequest(store, admin.id, submitter.id, name, {
        requestedVersion: "0.3.0",
      });
      const otherName = await approvedPublishRequest(store, admin.id, submitter.id, other);
      await store.withdrawPublishRequest(admin.id, otherName.id, "conformance takedown");

      const rows = await store.listStaffRefusedPublishRequestsForName(name);
      expect(rows.map((row) => row.id).sort()).toEqual([takenDown.id, laterVersion.id].sort());
      // Not scoped to one version...
      expect(rows.map((row) => row.requestedVersion).sort()).toEqual(["0.1.0", "0.2.0"]);
      // ...and not scoped past the name, or leaking a still-served row.
      expect(rows.some((row) => row.id === served.id)).toBe(false);
      expect(rows.some((row) => row.id === otherName.id)).toBe(false);
    });

    test("auto-approve: a staff reject is a refusal, a supersede is not", async () => {
      // Mutation killed: dropping `rejected` from the lookup, which makes a staff reject durable for
      // NOTHING (the dedup excludes rejected rows, so the refused release re-publishes itself as a
      // fresh pending_validation row). And the opposite mutation: dropping the reviewer test, which
      // would quarantine every name whose owner ever corrected a pending submission, because the
      // supersede CAS also writes `rejected`.
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = uid("pack");

      const humanRefused = await validatedPublishRequest(store, submitter.id, name, {
        requestedVersion: "0.4.0",
      });
      const rejected = await store.rejectPublishRequest(admin.id, humanRefused.id, "exfiltrates secrets");
      expect(rejected.status).toBe("rejected");
      expect(rejected.reviewedBy?.id).toBe(admin.id);

      // A divergent resubmit of a still-pending release: the predecessor is closed as `rejected` by
      // the supersede CAS, with nobody recorded as having reviewed it.
      const draft = await validatedPublishRequest(store, submitter.id, name, {
        requestedVersion: "0.5.0",
      });
      await store.createPublishRequest(
        submitter.id,
        publishInput(name, { requestedVersion: "0.5.0", commit: "c".repeat(40) }),
        "web_session",
      );
      const superseded = await store.getPublishRequest(draft.id);
      expect(superseded?.status).toBe("rejected");
      expect(superseded?.reviewedBy).toBeUndefined();

      const rows = await store.listStaffRefusedPublishRequestsForName(name);
      expect(rows.map((row) => row.id)).toEqual([humanRefused.id]);
    });

    if (lane.name === "postgres") {
      test("auto-approve: the audit row is attributable to nobody and marked auto", async () => {
        const submitter = await store.ensureUser(identity());
        const admin = await store.ensureUser(identity({ assertedAdmin: true }));
        const name = uid("pack");
        const first = await approvedPublishRequest(store, admin.id, submitter.id, name);
        const repeat = await validatedPublishRequest(store, submitter.id, name, {
          requestedVersion: "0.2.0",
        });
        await store.autoApprovePublishRequest(repeat.id, {
          ownershipBasis: "repo_proven",
          autoApprove: { precedentRequestId: first.id, ref: "refs/tags/v0.2.0", eventName: "push" },
        });

        const sql = postgres(dbUrl!, { max: 1 });
        try {
          const rows = await sql`
            SELECT actor_user_id, metadata FROM audit_logs
            WHERE target_id = ${repeat.id} AND action = 'publish_request.approve'`;
          expect(rows).toHaveLength(1);
          // NULL, not the submitter: nobody approved this. Same shape auditSystem already writes.
          expect(rows[0]!.actor_user_id).toBeNull();
          expect(rows[0]!.metadata.approvalMode).toBe("auto");
          expect(rows[0]!.metadata.autoApprovedFromRequestId).toBe(first.id);
          // Recorded, never gated on: an available signal that would be indefensible to discard.
          expect(rows[0]!.metadata.oidcRef).toBe("refs/tags/v0.2.0");
          expect(rows[0]!.metadata.oidcEventName).toBe("push");
          // The shared approval body still records everything a staff approval records.
          expect(rows[0]!.metadata.ownershipBasis).toBe("repo_proven");
          expect(rows[0]!.metadata.namePin).toBe("matched");
          expect(rows[0]!.metadata.requestedVersion).toBe("0.2.0");

          // And the staff approval of the FIRST release is still attributable to the human, with no
          // auto marker anywhere on it.
          const staffRows = await sql`
            SELECT actor_user_id, metadata FROM audit_logs
            WHERE target_id = ${first.id} AND action = 'publish_request.approve'`;
          expect(staffRows).toHaveLength(1);
          expect(staffRows[0]!.actor_user_id).toBe(admin.id);
          expect(staffRows[0]!.metadata.approvalMode).toBeUndefined();
          expect(staffRows[0]!.metadata.autoApprovedFromRequestId).toBeUndefined();
        } finally {
          await sql.end();
        }
      });
    }

    test("ownership: upsert, per-user/per-repo check, and revocation", async () => {
      const ownerUser = await store.ensureUser(identity());
      const stranger = await store.ensureUser(identity());
      const repoFull = `acme/${uid("repo")}`;
      const input = ownershipInput(repoFull);

      const ownership = await store.upsertVerifiedPackOwnership(ownerUser.id, input);
      expect(ownership.verificationStatus).toBe("verified");
      const fetched = await store.getPackOwnership(input.packKey);
      expect(fetched?.verificationStatus).toBe("verified");

      // Returns the numeric id that was PROVEN, not just a yes — the merge gate compares it against
      // the id a name claim is pinned to, because the full name this row was found by is mutable.
      expect(await store.verifiedRepoOwnershipRepositoryId(ownerUser.id, repoFull)).toBe(
        input.githubRepositoryId,
      );
      expect(await store.verifiedRepoOwnershipRepositoryId(ownerUser.id, repoFull.toUpperCase())).toBe(
        input.githubRepositoryId,
      );
      expect(await store.verifiedRepoOwnershipRepositoryId(stranger.id, repoFull)).toBeNull();

      const removed = await store.deletePackOwnershipsForGithubRepositoryIds(
        [input.githubRepositoryId],
        "conformance test",
      );
      expect(removed).toBe(1);
      expect(await store.verifiedRepoOwnershipRepositoryId(ownerUser.id, repoFull)).toBeNull();
    });

    // (c) The row is keyed by pack_key alone and its source_url is a descriptive column that MOVES.
    // A direct pack's catalog `source` is frozen at its earliest approved release, so withdrawing
    // that release re-creates the pack at a different commit; the old write-time pin then refused
    // re-verification forever ("Pack ownership source does not match the catalog") even though the
    // ON CONFLICT clause right below it was written to perform exactly that update.
    test("ownership: re-verification follows the catalog when a pack's source moves", async () => {
      const ownerUser = await store.ensureUser(identity());
      const repoFull = `acme/${uid("repo")}`;
      const input = ownershipInput(repoFull);
      const movedSourceUrl = `https://github.com/${repoFull}/tree/${"d".repeat(40)}/packs/thing`;

      await store.upsertVerifiedPackOwnership(ownerUser.id, input);
      const moved = await store.upsertVerifiedPackOwnership(ownerUser.id, {
        ...input,
        sourceUrl: movedSourceUrl,
      });
      expect(moved.sourceUrl).toBe(movedSourceUrl);

      // And the read is keyed by pack_key alone, so the caller does not have to know the new URL to
      // find the live row — the badge lookup used to require exact source_url equality, which is why
      // the badge silently vanished with nobody re-verifying.
      const fetched = await store.getPackOwnership(input.packKey);
      expect(fetched?.sourceUrl).toBe(movedSourceUrl);
      expect(fetched?.verificationStatus).toBe("verified");
      expect(await store.verifiedRepoOwnershipRepositoryId(ownerUser.id, repoFull)).toBe(
        input.githubRepositoryId,
      );
    });

    test("publish requests round-trip the server-derived github source ids, including NULL", async () => {
      const submitter = await store.ensureUser(identity());

      const stamped = await store.createPublishRequest(
        submitter.id,
        publishInput(uid("pack")),
        "github_actions_oidc",
        { githubRepositoryId: "repo_777", githubOwnerId: "owner_777" },
      );
      expect(stamped.sourceGithubRepositoryId).toBe("repo_777");
      expect(stamped.sourceGithubOwnerId).toBe("owner_777");
      expect(await store.getPublishRequest(stamped.id)).toMatchObject({
        sourceGithubRepositoryId: "repo_777",
        sourceGithubOwnerId: "owner_777",
      });
      expect(
        (await store.listAccountPublishRequests(submitter.id)).find((r) => r.id === stamped.id),
      ).toMatchObject({ sourceGithubRepositoryId: "repo_777", sourceGithubOwnerId: "owner_777" });

      // A GitHub import proves the repository id but not always the owner id — half-stamped
      // rows must round-trip as half-stamped, not as an empty string.
      const partial = await store.createPublishRequest(
        submitter.id,
        publishInput(uid("pack")),
        "github_import",
        { githubRepositoryId: "repo_778" },
      );
      expect(partial.sourceGithubRepositoryId).toBe("repo_778");
      expect(partial.sourceGithubOwnerId).toBeUndefined();

      // Claim-only paths pass no identity at all: both columns stay NULL and read back undefined.
      const unstamped = await store.createPublishRequest(submitter.id, publishInput(uid("pack")), "web_session");
      expect(unstamped.sourceGithubRepositoryId).toBeUndefined();
      expect(unstamped.sourceGithubOwnerId).toBeUndefined();
      const rereadUnstamped = await store.getPublishRequest(unstamped.id);
      expect(rereadUnstamped?.sourceGithubRepositoryId).toBeUndefined();
      expect(rereadUnstamped?.sourceGithubOwnerId).toBeUndefined();
    });

    // The batch read the catalog render depends on (server/aggregate.ts's claim precedence). It
    // runs on every /catalog.json + /registry.toml request, so it has to answer many names in ONE
    // round trip rather than degrade into a query per approved pack — and both lanes have to agree
    // on order, deduplication and what an unclaimed name looks like, or the file double would
    // "prove" behaviour Postgres does not have.
    test("name claims: many names resolve in one read, deduplicated, unclaimed names omitted", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const scope = uid("scope");
      const first = `${scope}/aaa-${uid("pack")}`;
      const second = `${scope}/zzz-${uid("pack")}`;
      const unclaimed = `${scope}/never-${uid("pack")}`;
      await approvedPublishRequest(store, admin.id, submitter.id, first);
      const secondRequest = await approvedPublishRequest(store, admin.id, submitter.id, second);

      expect(await store.listPackNameClaims([])).toEqual([]);
      expect(await store.listPackNameClaims([unclaimed])).toEqual([]);

      // Ordered by name (byte-wise on both lanes), one row per distinct name however often it is
      // asked for, and the unclaimed name simply absent — never a null placeholder.
      const batch = await store.listPackNameClaims([second, unclaimed, first, first]);
      expect(batch.map((claim) => claim.name)).toEqual([first, second]);
      // ...and byte-identical to what the single-name read returns for each of them.
      expect(batch).toEqual([
        (await store.getPackNameClaim(first))!,
        (await store.getPackNameClaim(second))!,
      ]);

      // A released claim disappears from the batch read too (the takedown path staff use to hand
      // a name back to ingest, which is what makes claim precedence reversible).
      await store.withdrawPublishRequest(admin.id, secondRequest.id, "handing the name back", {
        releaseNameClaim: true,
      });
      expect((await store.listPackNameClaims([first, second])).map((claim) => claim.name)).toEqual([first]);
    });

    test("catalog attribution: stable owner ids grant live trust; login-only and id-less claims never do", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const ownership = ownershipInput("acme/registry-fixtures");
      await store.upsertVerifiedPackOwnership(submitter.id, ownership);

      async function approveWithIdentity(
        name: string,
        sourceIdentity?: { githubRepositoryId: string; githubOwnerId: string },
      ) {
        const request = await store.createPublishRequest(
          submitter.id,
          publishInput(name),
          sourceIdentity ? "github_actions_oidc" : "web_session",
          sourceIdentity,
        );
        await store.markPublishRequestValidated(request.id, entry(name));
        await store.approvePublishRequest(admin.id, request.id);
      }

      const stable = `acme/${uid("stable")}`;
      const reusedLogin = `acme/${uid("reused")}`;
      const idless = `acme/${uid("legacy")}`;
      await approveWithIdentity(stable, {
        githubRepositoryId: ownership.githubRepositoryId,
        githubOwnerId: ownership.githubOwnerId,
      });
      await approveWithIdentity(reusedLogin, {
        githubRepositoryId: "repo-reused-login",
        githubOwnerId: "owner-not-acme",
      });
      await approveWithIdentity(idless);

      const before = await store.listCatalogPublisherAttributions([
        reusedLogin,
        stable,
        idless,
        stable,
        "acme/unclaimed",
      ]);
      expect(before.map((row) => row.name)).toEqual(
        [stable, reusedLogin, idless].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
      expect(before.find((row) => row.name === stable)).toEqual({
        name: stable,
        publisher: "acme",
        trusted: false,
      });
      expect(before.find((row) => row.name === reusedLogin)).toEqual({
        name: reusedLogin,
        publisher: "acme",
        trusted: false,
      });
      expect(before.find((row) => row.name === idless)).toEqual({
        name: idless,
        publisher: "acme",
        trusted: false,
      });

      const promoted = await store.setPublisherTrustByGithubOwnerId(
        ownership.githubOwnerId,
        true,
        {
          operator: "registry-test",
          reason: "conformance promotion",
        },
      );
      expect(promoted).toMatchObject({
        githubOwnerId: ownership.githubOwnerId,
        trusted: true,
      });

      const afterPromotion = await store.listCatalogPublisherAttributions([
        stable,
        reusedLogin,
        idless,
      ]);
      expect(afterPromotion.find((row) => row.name === stable)?.trusted).toBe(true);
      expect(afterPromotion.find((row) => row.name === reusedLogin)?.trusted).toBe(false);
      expect(afterPromotion.find((row) => row.name === idless)?.trusted).toBe(false);

      await store.setPublisherTrustByGithubOwnerId(ownership.githubOwnerId, false, {
        operator: "registry-test",
        reason: "conformance rollback",
      });
      expect(
        (await store.listCatalogPublisherAttributions([stable]))[0]?.trusted,
      ).toBe(false);

      await expect(
        store.setPublisherTrustByGithubOwnerId(ownership.githubOwnerId, true, {
          operator: "registry-test",
          reason: " ",
        }),
      ).rejects.toBeInstanceOf(StoreValidationError);
      await expect(
        store.setPublisherTrustByGithubOwnerId("owner-missing", true, {
          operator: "registry-test",
          reason: "must not create trust by typo",
        }),
      ).rejects.toBeInstanceOf(StoreValidationError);
    });

    test("name claims: the first approve pins the name, and a later approve never re-points it", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const scope = uid("scope");
      const name = `${scope}/${uid("pack")}`;
      expect(await store.getPackNameClaim(name)).toBeNull();

      // An approve that cannot happen must not leave a claim behind — the pin and the status
      // flip are one atomic step.
      const unvalidated = await store.createPublishRequest(
        submitter.id,
        publishInput(name, { requestedVersion: "0.0.1" }),
        "web_session",
      );
      await expect(store.approvePublishRequest(admin.id, unvalidated.id)).rejects.toBeInstanceOf(StoreValidationError);
      expect(await store.getPackNameClaim(name)).toBeNull();

      const first = await store.createPublishRequest(
        submitter.id,
        publishInput(name),
        "github_actions_oidc",
        { githubRepositoryId: "repo_claim", githubOwnerId: "owner_claim" },
      );
      await store.markPublishRequestValidated(first.id, entry(name));
      await store.approvePublishRequest(admin.id, first.id);

      const claim = await store.getPackNameClaim(name);
      expect(claim).toMatchObject({
        name,
        scope,
        repoFullName: "acme/registry-fixtures",
        githubOwnerLogin: "acme",
        githubRepositoryId: "repo_claim",
        githubOwnerId: "owner_claim",
        claimedByUserId: submitter.id,
        sourceRequestId: first.id,
      });
      expect(Date.parse(claim!.createdAt)).toBeGreaterThan(0);
      expect(Date.parse(claim!.updatedAt)).toBeGreaterThan(0);

      // A later release from the SAME repo (a teammate, even) is recorded as a match and leaves the
      // binding untouched: the claim pins a repository, not a person.
      const teammate = await store.ensureUser(identity());
      const sameRepo = await store.createPublishRequest(
        teammate.id,
        publishInput(name, { requestedVersion: "0.2.0" }),
        "github_actions_oidc",
        { githubRepositoryId: "repo_claim", githubOwnerId: "owner_claim" },
      );
      await store.markPublishRequestValidated(sameRepo.id, entry(name));
      expect((await store.approvePublishRequest(admin.id, sameRepo.id)).status).toBe("approved");
      expect(await store.getPackNameClaim(name)).toEqual(claim);

      // Another submitter publishing the same name from a DIFFERENT repo is REFUSED by the approve
      // transaction itself, not merely recorded as a match. The merge gate refuses this first in
      // normal operation, but the gate's claim read is not serialized against this transaction —
      // two approvals racing on one name both pass the gate, and without this re-check the loser
      // merges anyway and its audit row claims namePin "matched" for a binding it does not hold.
      // Reverting the re-check alone leaves every API-level test green, so this is the only place
      // it can be killed.
      const stranger = await store.ensureUser(identity());
      const second = await store.createPublishRequest(
        stranger.id,
        publishInput(name, { repoUrl: "https://github.com/stranger/fork" }),
        "web_session",
      );
      await store.markPublishRequestValidated(second.id, entry(name));
      await expect(store.approvePublishRequest(admin.id, second.id)).rejects.toBeInstanceOf(
        StoreConflictError,
      );
      // Refused atomically: the claim did not move AND the request was not served. (A file-lane
      // regression that mutated before checking would leave this row approved.)
      expect(await store.getPackNameClaim(name)).toEqual(claim);
      expect((await store.getPublishRequest(second.id))?.status).toBe("pending_review");

      // ...and staff can still authorize it explicitly, which is the re-pin path.
      expect(
        (await store.approvePublishRequest(admin.id, second.id, { namePinOverrideReason: "ticket #9" }))
          .status,
      ).toBe("approved");
      expect(await store.getPackNameClaim(name)).toMatchObject({
        repoFullName: "stranger/fork",
        sourceRequestId: second.id,
      });

      // A name nobody has published is unclaimed.
      expect(await store.getPackNameClaim(uid("unpublished"))).toBeNull();
    });

    test("init() backfills one claim per approved name from its FIRST-APPROVED request", async () => {
      const firstSubmitter = await store.ensureUser(identity());
      const laterSubmitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const scope = uid("scope");
      const scoped = `${scope}/${uid("pack")}`;
      // Shaped like the live community pack this backfill has to grandfather: bare name,
      // published from a repo whose name matches it.
      const bare = uid("cacc-twin-team");

      const earliest = await approvedPublishRequest(store, admin.id, firstSubmitter.id, scoped, {
        repoUrl: "https://github.com/acme/first-owner",
      });
      await Bun.sleep(2); // distinct created_at, so "earliest" is unambiguous on both lanes
      const later = await approvedPublishRequest(
        store,
        admin.id,
        laterSubmitter.id,
        scoped,
        { repoUrl: "https://github.com/stranger/later-fork" },
        // seedRepinDecision: the approve transaction now refuses a second, differently-owned
        // release of a claimed name. The claim is dropped below before init() runs, so what it
        // pointed at in between is not what this test measures.
        seedRepinDecision,
      );
      const legacy = await approvedPublishRequest(store, admin.id, firstSubmitter.id, bare, {
        repoUrl: "https://github.com/wespd/cacc-twin-team",
      });
      expect(later.status).toBe("approved");

      await dropNameClaimsForConformance(store, dbUrl, [scoped, bare]);
      expect(await store.getPackNameClaim(scoped)).toBeNull();
      expect(await store.getPackNameClaim(bare)).toBeNull();

      await store.init();

      // The earliest approved request wins the name — the later fork gets nothing.
      const scopedClaim = await store.getPackNameClaim(scoped);
      expect(scopedClaim).toMatchObject({
        name: scoped,
        scope,
        repoFullName: "acme/first-owner",
        githubOwnerLogin: "acme",
        claimedByUserId: firstSubmitter.id,
        sourceRequestId: earliest.id,
      });
      const bareClaim = await store.getPackNameClaim(bare);
      expect(bareClaim).toMatchObject({
        name: bare,
        repoFullName: "wespd/cacc-twin-team",
        githubOwnerLogin: "wespd",
        claimedByUserId: firstSubmitter.id,
        sourceRequestId: legacy.id,
      });
      expect(bareClaim!.scope).toBeUndefined(); // a bare name has no scope segment

      // Idempotent: booting again re-derives nothing and rewrites nothing.
      await store.init();
      expect(await store.getPackNameClaim(scoped)).toEqual(scopedClaim);
      expect(await store.getPackNameClaim(bare)).toEqual(bareClaim);
    });

    // The backfill has to pin by the SAME rule approvePublishRequest applies at runtime (first
    // approval mints the claim). If it pinned by submission time instead, then for a pair whose
    // submission and approval orders disagree the two rules pick different owners — so which one
    // the claim froze would depend on the day the migration ran. The claim is never re-pointed,
    // so that is permanent.
    test("init() pins by approval order, not submission order, when the two disagree", async () => {
      const earlySubmitter = await store.ensureUser(identity());
      const lateSubmitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = `${uid("scope")}/${uid("pack")}`;

      // Submitted first, approved second.
      const submittedFirst = await validatedPublishRequest(store, earlySubmitter.id, name, {
        repoUrl: "https://github.com/stranger/opportunist",
      });
      await Bun.sleep(2);
      const submittedSecond = await validatedPublishRequest(store, lateSubmitter.id, name, {
        repoUrl: "https://github.com/acme/real-owner",
      });

      // ...but approved FIRST, so it is the request that earned the name. The second approve needs
      // the seeding re-pin authorization (see seedRepinDecision): it is a differently-owned release
      // of a now-claimed name, which a plain approve refuses. Both claims are dropped below, so the
      // only thing this test reads back is what init() derives from the two APPROVED rows.
      await store.approvePublishRequest(admin.id, submittedSecond.id);
      await Bun.sleep(2);
      await store.approvePublishRequest(admin.id, submittedFirst.id, seedRepinDecision);

      await dropNameClaimsForConformance(store, dbUrl, [name]);
      await store.init();

      expect(await store.getPackNameClaim(name)).toMatchObject({
        name,
        repoFullName: "acme/real-owner",
        githubOwnerLogin: "acme",
        claimedByUserId: lateSubmitter.id,
        sourceRequestId: submittedSecond.id,
      });
    });

    // Guards the id tiebreak's comparison rule. Request ids are random base64url, so they contain
    // both cases: byte order puts every uppercase letter before every lowercase one, while a
    // locale collation interleaves them case-insensitively. On an exact timestamp tie the two
    // rules therefore hand the name to DIFFERENT repos. Postgres compares COLLATE "C" and the file
    // store compares code units so they agree; without both, the lanes silently diverge here.
    test("init() breaks an exact pin-order tie byte-wise, identically on both lanes", async () => {
      const upperSubmitter = await store.ensureUser(identity());
      const lowerSubmitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = `${uid("scope")}/${uid("pack")}`;

      const upper = await approvedPublishRequest(store, admin.id, upperSubmitter.id, name, {
        repoUrl: "https://github.com/acme/upper-id",
      });
      const lower = await approvedPublishRequest(
        store,
        admin.id,
        lowerSubmitter.id,
        name,
        { repoUrl: "https://github.com/stranger/lower-id" },
        seedRepinDecision, // see above: a plain approve refuses a differently-owned second release
      );

      // Identical instants; ids chosen so byte order ("B" = 0x42 < "a" = 0x61) and a case-folding
      // locale collation ("a" before "B") disagree about the winner.
      const tie = "2026-01-01T00:00:00.000Z";
      const upperId = `prq_B${uid("tie")}`;
      const lowerId = `prq_a${uid("tie")}`;
      await rewritePublishRequestForConformance(store, dbUrl, upper.id, {
        id: upperId,
        createdAt: tie,
        reviewedAt: tie,
      });
      await rewritePublishRequestForConformance(store, dbUrl, lower.id, {
        id: lowerId,
        createdAt: tie,
        reviewedAt: tie,
      });

      await dropNameClaimsForConformance(store, dbUrl, [name]);
      await store.init();

      // Byte order wins: the uppercase id, regardless of the server's locale.
      expect(await store.getPackNameClaim(name)).toMatchObject({
        name,
        repoFullName: "acme/upper-id",
        sourceRequestId: upperId,
      });
    });

    // The re-pin is the audited repo-migration path. It has to be opt-in per approval: if a plain
    // approve could move a claim, the merge gate's whole name pin would be advisory.
    test("an approve re-points a name claim ONLY with an explicit re-pin authorization", async () => {
      const first = await store.ensureUser(identity());
      const migrated = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = `${uid("scope")}/${uid("pack")}`;

      const original = await approvedPublishRequest(store, admin.id, first.id, name, {
        repoUrl: "https://github.com/acme/original-repo",
      });
      const claim = await store.getPackNameClaim(name);
      expect(claim).toMatchObject({ repoFullName: "acme/original-repo", sourceRequestId: original.id });

      // A plain approve of the same name from another repo is refused inside the approve
      // transaction and changes nothing: not the claim, and not the request's status.
      const unauthorized = await validatedPublishRequest(store, migrated.id, name, {
        repoUrl: "https://github.com/acme/new-repo",
        requestedVersion: "0.2.0",
      });
      await expect(store.approvePublishRequest(admin.id, unauthorized.id)).rejects.toBeInstanceOf(
        StoreConflictError,
      );
      expect(await store.getPackNameClaim(name)).toEqual(claim);
      expect((await store.getPublishRequest(unauthorized.id))?.status).toBe("pending_review");

      await Bun.sleep(2); // so an updatedAt bump is observable on both lanes
      const authorized = await validatedPublishRequest(store, migrated.id, name, {
        repoUrl: "https://github.com/acme/new-repo",
        requestedVersion: "0.3.0",
      });
      await store.approvePublishRequest(admin.id, authorized.id, {
        namePinOverrideReason: "repo migrated to acme/new-repo",
      });

      const repinned = await store.getPackNameClaim(name);
      expect(repinned).toMatchObject({
        name,
        repoFullName: "acme/new-repo",
        githubOwnerLogin: "acme",
        claimedByUserId: migrated.id,
        sourceRequestId: authorized.id,
      });
      // The claim's identity is the NAME, so its createdAt is when the name was first claimed —
      // a re-pin moves the binding, it does not mint a new claim.
      expect(repinned!.createdAt).toBe(claim!.createdAt);
      expect(Date.parse(repinned!.updatedAt)).toBeGreaterThan(Date.parse(claim!.updatedAt));

      // A re-pin authorization on a name that has NO claim yet still just mints one.
      const fresh = `${uid("scope")}/${uid("pack")}`;
      const minted = await validatedPublishRequest(store, first.id, fresh);
      await store.approvePublishRequest(admin.id, minted.id, { namePinOverrideReason: "not needed" });
      expect(await store.getPackNameClaim(fresh)).toMatchObject({ sourceRequestId: minted.id });
    });

    test("withdraw releases the name claim only when asked", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const kept = `${uid("scope")}/${uid("pack")}`;
      const freed = `${uid("scope")}/${uid("pack")}`;

      // A content takedown must NOT unclaim the name: the repo that owns it still owns it, and
      // an unclaimed name is open to whoever asks next.
      const keptRequest = await approvedPublishRequest(store, admin.id, submitter.id, kept);
      await store.withdrawPublishRequest(admin.id, keptRequest.id, "takedown: content");
      expect(await store.getPackNameClaim(kept)).toMatchObject({ name: kept });

      const freedRequest = await approvedPublishRequest(store, admin.id, submitter.id, freed);
      expect(await store.getPackNameClaim(freed)).not.toBeNull();
      await store.withdrawPublishRequest(admin.id, freedRequest.id, "takedown: squat", {
        releaseNameClaim: true,
      });
      expect(await store.getPackNameClaim(freed)).toBeNull();

      // The release is part of the takedown, not a substitute for it.
      expect((await store.getPublishRequest(freedRequest.id))?.status).toBe("withdrawn");
      // A failed withdraw releases nothing: the row is already terminal, so neither effect applies.
      await expect(
        store.withdrawPublishRequest(admin.id, keptRequest.id, "again", { releaseNameClaim: true }),
      ).rejects.toBeInstanceOf(StoreValidationError);
      expect(await store.getPackNameClaim(kept)).toMatchObject({ name: kept });
    });

    // A release has to SURVIVE the next boot. init()'s grandfather backfill re-mints a claim for
    // any name that still has an approved request, so releasing a name while a sibling release is
    // still served would silently revert on restart — pinned to the FIRST-approved repo, with no
    // audit row for the reversion. That would restore a squatter's binding and undo the staff
    // decision this lever exists to make, which is why the release is refused instead.
    test("a released name claim survives init(); releasing is refused while a sibling release is served", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = `${uid("scope")}/${uid("pack")}`;

      const first = await approvedPublishRequest(store, admin.id, submitter.id, name);
      const second = await approvedPublishRequest(store, admin.id, submitter.id, name, {
        requestedVersion: "0.2.0",
      });

      // Two approved releases: releasing now would leave a live, served name unclaimed AND be
      // undone by the next backfill.
      await expect(
        store.withdrawPublishRequest(admin.id, second.id, "takedown", { releaseNameClaim: true }),
      ).rejects.toBeInstanceOf(StoreValidationError);
      // Refused BEFORE anything mutated — the request is still served, not taken down and then failed.
      expect((await store.getPublishRequest(second.id))?.status).toBe("approved");
      expect(await store.getPackNameClaim(name)).not.toBeNull();

      // Take the sibling down without releasing, leaving exactly one approved release...
      await store.withdrawPublishRequest(admin.id, second.id, "takedown: content");
      // ...now the release is legal, and it must stick across a reboot.
      await store.withdrawPublishRequest(admin.id, first.id, "takedown: squat", {
        releaseNameClaim: true,
      });
      expect(await store.getPackNameClaim(name)).toBeNull();
      await store.init();
      expect(await store.getPackNameClaim(name)).toBeNull();
    });

    // Releasing a BARE name's claim can only ever cause harm: bare names are reserved, so nothing
    // can mint a bare claim afterwards and the name becomes permanently unpublishable.
    test("releasing an unscoped name's claim is refused outright", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const bare = uid("legacy");

      const request = await approvedPublishRequest(store, admin.id, submitter.id, bare);
      await expect(
        store.withdrawPublishRequest(admin.id, request.id, "takedown", { releaseNameClaim: true }),
      ).rejects.toBeInstanceOf(StoreValidationError);
      expect((await store.getPublishRequest(request.id))?.status).toBe("approved");
      expect(await store.getPackNameClaim(bare)).toMatchObject({ name: bare });

      // Without the flag the takedown works normally and the claim is retained.
      await store.withdrawPublishRequest(admin.id, request.id, "takedown");
      expect(await store.getPackNameClaim(bare)).toMatchObject({ name: bare });
    });

    // ENRICHMENT. A claim minted by a claim-only publish knows no rename-stable ids, so it can only
    // be matched by repo full name — which a repo RENAME breaks, 409ing the real owner. A later
    // repo-proven release of the SAME claim teaches it the ids it lacked. Monotonic: the claim goes
    // from admitting "any repo currently named F" to admitting "numeric repo I owned by O", so the
    // admitted set only ever shrinks.
    test("a matched repo-proven approve fills a claim's NULL github ids", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = `${uid("scope")}/${uid("pack")}`;

      // Claim-only first release: no ids at all.
      const claimOnly = await approvedPublishRequest(store, admin.id, submitter.id, name);
      const before = await store.getPackNameClaim(name);
      expect(before?.githubRepositoryId).toBeUndefined();
      expect(before?.githubOwnerId).toBeUndefined();
      expect(claimOnly.status).toBe("approved");
      await Bun.sleep(2); // so an updatedAt bump is observable on both lanes

      // A repo-proven release from the SAME repo matches on the full name, and teaches the ids.
      const proven = await store.createPublishRequest(
        submitter.id,
        publishInput(name, { requestedVersion: "0.2.0" }),
        "github_actions_oidc",
        { githubRepositoryId: "repo_enrich", githubOwnerId: "owner_enrich" },
      );
      await store.markPublishRequestValidated(proven.id, entry(name));
      expect((await store.approvePublishRequest(admin.id, proven.id)).status).toBe("approved");

      const after = await store.getPackNameClaim(name);
      expect(after).toMatchObject({
        githubRepositoryId: "repo_enrich",
        githubOwnerId: "owner_enrich",
      });
      // Enrichment refines the binding; it does not move it. Everything else is byte-identical,
      // including which request earned the name.
      expect(after?.repoFullName).toBe(before?.repoFullName);
      expect(after?.claimedByUserId).toBe(before?.claimedByUserId);
      expect(after?.sourceRequestId).toBe(claimOnly.id);
      expect(after?.createdAt).toBe(before?.createdAt);
      expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(before!.updatedAt));
    });

    // Trust-model condition (2), in the direction that actually bites. For a request that MATCHED,
    // any id the claim already knows and the request also proves is necessarily equal — so the real
    // hazard is not overwriting, it is ERASING an id the claim knows and the request does not. A
    // naive "write both ids from the request" enrichment would blank the repository id here and
    // demote the claim back to a full-name match, undoing the very hardening this exists for.
    test("enrichment fills only the NULL id and never erases the known one", async () => {
      const submitter = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = `${uid("scope")}/${uid("pack")}`;

      // A half-stamped claim: repository id known, owner id NULL (the github_import shape before
      // the owner id was captured).
      const half = await store.createPublishRequest(
        submitter.id,
        publishInput(name),
        "github_import",
        { githubRepositoryId: "repo_half" },
      );
      await store.markPublishRequestValidated(half.id, entry(name));
      await store.approvePublishRequest(admin.id, half.id);
      expect(await store.getPackNameClaim(name)).toMatchObject({ githubRepositoryId: "repo_half" });
      expect((await store.getPackNameClaim(name))?.githubOwnerId).toBeUndefined();

      // A request proving the OWNER id but not the repository id. It matches (owner login, then repo
      // full name), so it may fill the owner id — and must leave the repository id alone.
      const ownerOnly = await store.createPublishRequest(
        submitter.id,
        publishInput(name, { requestedVersion: "0.2.0" }),
        "github_actions_oidc",
        { githubOwnerId: "owner_half" },
      );
      await store.markPublishRequestValidated(ownerOnly.id, entry(name));
      await store.approvePublishRequest(admin.id, ownerOnly.id);

      expect(await store.getPackNameClaim(name)).toMatchObject({
        githubRepositoryId: "repo_half",
        githubOwnerId: "owner_half",
      });
    });

    // Trust-model condition (1): enrichment never participates in an admission decision. A request
    // the claim does NOT admit must teach it nothing — otherwise whoever turns up rewrites the pin
    // to point at themselves, which is a direct H2 takeover. Structurally guaranteed by placing the
    // enrichment inside the `matched` branch, after the refusal; asserted here because the
    // consequence of getting it wrong is a namespace takeover, not a bug.
    test("a refused approve teaches the claim nothing", async () => {
      const holder = await store.ensureUser(identity());
      const attacker = await store.ensureUser(identity());
      const admin = await store.ensureUser(identity({ assertedAdmin: true }));
      const name = `${uid("scope")}/${uid("pack")}`;

      await approvedPublishRequest(store, admin.id, holder.id, name, {
        repoUrl: "https://github.com/acme/enrich-holder",
      });
      const before = await store.getPackNameClaim(name);
      expect(before?.githubRepositoryId).toBeUndefined();
      expect(before?.githubOwnerId).toBeUndefined();

      // Fully repo-proven, for a DIFFERENT repo. Repo proof is not name ownership.
      const hostile = await store.createPublishRequest(
        attacker.id,
        publishInput(name, {
          repoUrl: "https://github.com/acme/enrich-attacker",
          requestedVersion: "0.2.0",
        }),
        "github_actions_oidc",
        { githubRepositoryId: "repo_attacker", githubOwnerId: "owner_attacker" },
      );
      await store.markPublishRequestValidated(hostile.id, entry(name));
      await expect(store.approvePublishRequest(admin.id, hostile.id)).rejects.toBeInstanceOf(
        StoreConflictError,
      );
      // Not merely "the claim did not move" — it learned nothing at all, so it did not become
      // matchable by the attacker's ids on some later approve either.
      expect(await store.getPackNameClaim(name)).toEqual(before);
    });

    // Documented divergence (store.ts): the file store keeps no audit_logs. This asserts the
    // Postgres audit trail — the ownership-override justification is a security/compliance record.
    if (lane.name === "postgres") {
      test("publisher trust promotion and rollback are fully auditable", async () => {
        const submitter = await store.ensureUser(identity());
        const ownership = ownershipInput("acme/trust-audit");
        await store.upsertVerifiedPackOwnership(submitter.id, ownership);

        const promoted = await store.setPublisherTrustByGithubOwnerId(
          ownership.githubOwnerId,
          true,
          {
            operator: "registry-operator",
            reason: "publisher review approved",
          },
        );
        await store.setPublisherTrustByGithubOwnerId(
          ownership.githubOwnerId,
          false,
          {
            operator: "registry-operator",
            reason: "emergency trust rollback",
          },
        );

        const sql = postgres(dbUrl!, { max: 1 });
        try {
          const rows = await sql`
            SELECT actor_user_id, target_type, target_id, metadata
            FROM audit_logs
            WHERE action = 'publisher.trust.update'
              AND target_id = ${promoted.id}
              AND metadata->>'operator' = 'registry-operator'
          `;
          expect(rows).toHaveLength(2);
          for (const row of rows) {
            expect(row.actor_user_id).toBeNull();
            expect(row.target_type).toBe("publisher");
            expect(row.metadata.operator).toBe("registry-operator");
            expect(row.metadata.githubOwnerId).toBe(ownership.githubOwnerId);
          }
          expect(
            rows.find((row) => row.metadata.trusted === true)?.metadata,
          ).toMatchObject({
            reason: "publisher review approved",
            previousTrusted: false,
            trusted: true,
          });
          expect(
            rows.find((row) => row.metadata.trusted === false)?.metadata,
          ).toMatchObject({
            reason: "emergency trust rollback",
            previousTrusted: true,
            trusted: false,
          });
        } finally {
          await sql.end();
        }
      });

      test("audit_logs record create, approve(override), reject and withdraw", async () => {
        const submitter = await store.ensureUser(identity());
        const admin = await store.ensureUser(identity({ assertedAdmin: true }));

        const approvedName = uid("pack");
        const approvedReq = await store.createPublishRequest(submitter.id, publishInput(approvedName), "web_session");
        await store.markPublishRequestValidated(approvedReq.id, entry(approvedName));
        await store.approvePublishRequest(admin.id, approvedReq.id, {
          ownershipOverrideReason: "conformance override justification",
          ownershipBasis: "override",
        });
        // Take it down — the withdraw is itself an audited moderation action.
        await store.withdrawPublishRequest(admin.id, approvedReq.id, "conformance takedown");

        const rejectedName = uid("pack");
        const rejectedReq = await store.createPublishRequest(submitter.id, publishInput(rejectedName), "web_session");
        await store.markPublishRequestValidated(rejectedReq.id, entry(rejectedName));
        await store.rejectPublishRequest(admin.id, rejectedReq.id, "conformance rejection");

        const sql = postgres(dbUrl!, { max: 1 });
        try {
          const approveRows = await sql`
            SELECT actor_user_id, metadata FROM audit_logs
            WHERE target_id = ${approvedReq.id} AND action = 'publish_request.approve'`;
          expect(approveRows).toHaveLength(1);
          expect(approveRows[0]!.actor_user_id).toBe(admin.id); // accountability: the approving staff
          expect(approveRows[0]!.metadata.ownershipOverrideReason).toBe("conformance override justification");
          expect(approveRows[0]!.metadata.ownershipBasis).toBe("override"); // approval basis is recorded

          const createRows = await sql`
            SELECT actor_user_id FROM audit_logs
            WHERE target_id = ${approvedReq.id} AND action = 'publish_request.create'`;
          expect(createRows).toHaveLength(1);
          expect(createRows[0]!.actor_user_id).toBe(submitter.id);

          const rejectRows = await sql`
            SELECT actor_user_id, metadata FROM audit_logs
            WHERE target_id = ${rejectedReq.id} AND action = 'publish_request.reject'`;
          expect(rejectRows).toHaveLength(1);
          expect(rejectRows[0]!.actor_user_id).toBe(admin.id);
          expect(String(rejectRows[0]!.metadata.reason)).toContain("conformance rejection");

          const withdrawRows = await sql`
            SELECT actor_user_id, metadata FROM audit_logs
            WHERE target_id = ${approvedReq.id} AND action = 'publish_request.withdraw'`;
          expect(withdrawRows).toHaveLength(1);
          expect(withdrawRows[0]!.actor_user_id).toBe(admin.id); // accountability: the withdrawing staff
          expect(String(withdrawRows[0]!.metadata.reason)).toContain("conformance takedown");
          // The approve audit row remains — withdraw appends, never erases the approval record.
          expect(approveRows).toHaveLength(1);
        } finally {
          await sql.end();
        }
      });

      test("audit_logs record a supersede as its own action, not as a staff rejection", async () => {
        // The row lands in `rejected`, so without a distinct action + a NULL-reviewer trail the
        // audit would read as though staff turned the submission down.
        const submitter = await store.ensureUser(identity());
        const name = uid("pack");
        const first = await store.createPublishRequest(submitter.id, publishInput(name), "web_session");
        await store.markPublishRequestValidated(first.id, entry(name));
        const second = await store.createPublishRequest(
          submitter.id,
          publishInput(name, { commit: "c".repeat(40) }),
          "web_session",
        );

        const sql = postgres(dbUrl!, { max: 1 });
        try {
          const rows = await sql`
            SELECT actor_user_id, metadata FROM audit_logs
            WHERE target_id = ${first.id} AND action = 'publish_request.supersede'`;
          expect(rows).toHaveLength(1);
          expect(rows[0]!.actor_user_id).toBe(submitter.id);
          expect(rows[0]!.metadata.supersededBy).toBe(second.id);
          expect(rows[0]!.metadata.previousStatus).toBe("pending_review");
          // No staff reject was recorded, and the new row's create audit points back at what it replaced.
          const rejects = await sql`
            SELECT 1 FROM audit_logs WHERE target_id = ${first.id} AND action = 'publish_request.reject'`;
          expect(rejects).toHaveLength(0);
          const creates = await sql`
            SELECT metadata FROM audit_logs
            WHERE target_id = ${second.id} AND action = 'publish_request.create'`;
          expect(creates).toHaveLength(1);
          expect(creates[0]!.metadata.supersededRequestId).toBe(first.id);
        } finally {
          await sql.end();
        }
      });

      test("the approve audit records how the name was pinned (created, then matched)", async () => {
        const submitter = await store.ensureUser(identity());
        const stranger = await store.ensureUser(identity());
        const admin = await store.ensureUser(identity({ assertedAdmin: true }));
        const name = uid("pack");

        const first = await approvedPublishRequest(store, admin.id, submitter.id, name);
        // "matched" is the same-REPO case (the claim pins a repository, not a person), so the
        // second release comes from the same repo as a different submitter. A differently-owned
        // repo would be refused by the approve transaction's claim re-check, not recorded as
        // matched — that case is covered by the re-pin audit test below.
        const second = await approvedPublishRequest(store, admin.id, stranger.id, name);

        const sql = postgres(dbUrl!, { max: 1 });
        try {
          const rows = await sql`
            SELECT target_id, metadata FROM audit_logs
            WHERE action = 'publish_request.approve' AND target_id IN ${sql([first.id, second.id])}`;
          expect(rows).toHaveLength(2);
          expect(rows.find((row) => row.target_id === first.id)!.metadata.namePin).toBe("created");
          expect(rows.find((row) => row.target_id === second.id)!.metadata.namePin).toBe("matched");
        } finally {
          await sql.end();
        }
      });

      // A re-pin hands a name to a different repo, so the audit row has to be reconstructable on
      // its own: the justification plus both ends of the move.
      test("the approve audit reconstructs a re-pin from where to where", async () => {
        const original = await store.ensureUser(identity());
        const migrated = await store.ensureUser(identity());
        const admin = await store.ensureUser(identity({ assertedAdmin: true }));
        const name = `${uid("scope")}/${uid("pack")}`;

        const before = await approvedPublishRequest(store, admin.id, original.id, name, {
          repoUrl: "https://github.com/acme/audited-old",
        });
        const after = await validatedPublishRequest(store, migrated.id, name, {
          repoUrl: "https://github.com/acme/audited-new",
          requestedVersion: "0.2.0",
        });
        await store.approvePublishRequest(admin.id, after.id, {
          namePinOverrideReason: "migration ticket #4212",
        });

        const sql = postgres(dbUrl!, { max: 1 });
        try {
          const [row] = await sql`
            SELECT metadata FROM audit_logs
            WHERE action = 'publish_request.approve' AND target_id = ${after.id}`;
          expect(row!.metadata.namePin).toBe("repinned");
          expect(row!.metadata.namePinOverrideReason).toBe("migration ticket #4212");
          expect(row!.metadata.namePinFrom).toMatchObject({
            repoFullName: "acme/audited-old",
            githubOwnerLogin: "acme",
            claimedByUserId: original.id,
            sourceRequestId: before.id,
          });
          expect(row!.metadata.namePinTo).toMatchObject({
            repoFullName: "acme/audited-new",
            claimedByUserId: migrated.id,
            sourceRequestId: after.id,
          });
        } finally {
          await sql.end();
        }
      });

      test("the withdraw audit records a released name claim (and nothing when none was released)", async () => {
        const submitter = await store.ensureUser(identity());
        const admin = await store.ensureUser(identity({ assertedAdmin: true }));
        const freed = `${uid("scope")}/${uid("pack")}`;
        const kept = `${uid("scope")}/${uid("pack")}`;

        const freedRequest = await approvedPublishRequest(store, admin.id, submitter.id, freed, {
          repoUrl: "https://github.com/acme/released-repo",
        });
        await store.withdrawPublishRequest(admin.id, freedRequest.id, "takedown: squat", {
          releaseNameClaim: true,
        });
        const keptRequest = await approvedPublishRequest(store, admin.id, submitter.id, kept);
        await store.withdrawPublishRequest(admin.id, keptRequest.id, "takedown: content");

        const sql = postgres(dbUrl!, { max: 1 });
        try {
          const [releasedRow] = await sql`
            SELECT metadata FROM audit_logs
            WHERE action = 'publish_request.withdraw' AND target_id = ${freedRequest.id}`;
          // The claim row is gone, so this is the only surviving record of who held the name.
          expect(releasedRow!.metadata.releasedNameClaim).toMatchObject({
            name: freed,
            repoFullName: "acme/released-repo",
            claimedByUserId: submitter.id,
            sourceRequestId: freedRequest.id,
          });
          const [keptRow] = await sql`
            SELECT metadata FROM audit_logs
            WHERE action = 'publish_request.withdraw' AND target_id = ${keptRequest.id}`;
          expect(keptRow!.metadata.releasedNameClaim ?? null).toBeNull();
        } finally {
          await sql.end();
        }
      });

      // Enrichment is a binding change, so it has to be reconstructable from the audit alone.
      // A separate key, not a fourth namePin value: it refines "matched" rather than replacing it.
      test("the approve audit records which NULL ids an enrichment filled, and nothing when none did", async () => {
        const submitter = await store.ensureUser(identity());
        const admin = await store.ensureUser(identity({ assertedAdmin: true }));
        const name = `${uid("scope")}/${uid("pack")}`;

        const claimOnly = await approvedPublishRequest(store, admin.id, submitter.id, name);
        const enriching = await store.createPublishRequest(
          submitter.id,
          publishInput(name, { requestedVersion: "0.2.0" }),
          "github_actions_oidc",
          { githubRepositoryId: "repo_audited", githubOwnerId: "owner_audited" },
        );
        await store.markPublishRequestValidated(enriching.id, entry(name));
        await store.approvePublishRequest(admin.id, enriching.id);
        // A third release from the same repo with the same ids has nothing left to teach.
        const inert = await store.createPublishRequest(
          submitter.id,
          publishInput(name, { requestedVersion: "0.3.0" }),
          "github_actions_oidc",
          { githubRepositoryId: "repo_audited", githubOwnerId: "owner_audited" },
        );
        await store.markPublishRequestValidated(inert.id, entry(name));
        await store.approvePublishRequest(admin.id, inert.id);

        const sql = postgres(dbUrl!, { max: 1 });
        try {
          const rows = await sql`
            SELECT target_id, metadata FROM audit_logs
            WHERE action = 'publish_request.approve'
              AND target_id IN ${sql([claimOnly.id, enriching.id, inert.id])}`;
          const metadataFor = (id: string) => rows.find((row) => row.target_id === id)!.metadata;
          // Minting a claim is not an enrichment.
          expect(metadataFor(claimOnly.id).namePin).toBe("created");
          expect(metadataFor(claimOnly.id).nameClaimEnriched ?? null).toBeNull();
          // The enrichment: still "matched", plus exactly what it filled.
          expect(metadataFor(enriching.id).namePin).toBe("matched");
          expect(metadataFor(enriching.id).nameClaimEnriched).toEqual({
            githubRepositoryId: "repo_audited",
            githubOwnerId: "owner_audited",
          });
          // Nothing to fill -> no key at all, so the audit never implies a write that did not happen.
          expect(metadataFor(inert.id).namePin).toBe("matched");
          expect(metadataFor(inert.id).nameClaimEnriched ?? null).toBeNull();
        } finally {
          await sql.end();
        }
      });

      // F7. approve(Y) and withdraw(X, releaseNameClaim) race on ONE name. Both transactions read
      // pack_name_claims and then write it, and under READ COMMITTED neither sees the other's
      // uncommitted status flip — so without the per-name advisory lock the interleaving
      //
      //   T1 approve locks the claim row -> T2's survivor check sees no survivor -> T2 blocks on
      //   the row lock -> T1 commits (approved, "matched") -> T2 deletes the claim and commits
      //
      // leaves Y approved and SERVED with no claim at all, and T1's audit row describing a pin
      // that no longer exists. A row lock cannot fix it (and cannot even apply when the claim row
      // does not exist yet). Both orderings are legal; what must never happen is "served with no
      // claim". Fired repeatedly because a lost race is a scheduling accident, not a certainty.
      test("concurrent approve and claim-releasing withdraw on one name never leave a served release unclaimed", async () => {
        const holder = await store.ensureUser(identity());
        const next = await store.ensureUser(identity());
        const admin = await store.ensureUser(identity({ assertedAdmin: true }));

        for (let attempt = 0; attempt < 8; attempt += 1) {
          const name = `${uid("scope")}/${uid("pack")}`;
          // X is served and holds the claim; Y is validated and awaiting approval from a DIFFERENT
          // repo, so it can only be approved with a re-pin authorization — which is exactly the
          // shape that produced a bogus "repinned" audit row against a deleted claim.
          const served = await approvedPublishRequest(store, admin.id, holder.id, name, {
            repoUrl: "https://github.com/acme/racing-holder",
          });
          const pending = await validatedPublishRequest(store, next.id, name, {
            repoUrl: "https://github.com/acme/racing-next",
            requestedVersion: "0.2.0",
          });

          const [approveResult, withdrawResult] = await Promise.allSettled([
            store.approvePublishRequest(admin.id, pending.id, {
              namePinOverrideReason: `race attempt ${attempt}`,
            }),
            store.withdrawPublishRequest(admin.id, served.id, "takedown: race", {
              releaseNameClaim: true,
            }),
          ]);

          const claim = await store.getPackNameClaim(name);
          const approvedNow =
            (await store.getPublishRequest(pending.id))?.status === "approved";
          // The invariant: a name that is currently served must have a claim, and that claim must
          // point at the repo of the release serving it.
          if (approvedNow) {
            expect(claim, `attempt ${attempt}: approved but unclaimed`).not.toBeNull();
            expect(claim?.repoFullName).toBe("acme/racing-next");
            // Then the release had to lose — either refused outright, or (withdraw-first) it freed
            // the claim before the approve re-minted it.
            if (withdrawResult.status === "fulfilled") {
              expect(claim?.sourceRequestId).toBe(pending.id);
            }
          } else {
            // The approve lost. Whatever the withdraw did, no half state: either the claim is gone
            // (release succeeded) or it still points at the original holder (release refused).
            expect(approveResult.status).toBe("rejected");
            if (claim) expect(claim.repoFullName).toBe("acme/racing-holder");
          }

          // And the audit trail cannot describe a move it did not make: a "repinned" row must
          // carry both ends of the move, and no approve row may exist for a request that is not
          // approved.
          const sql = postgres(dbUrl!, { max: 1 });
          try {
            const rows = await sql`
              SELECT metadata FROM audit_logs
              WHERE action = 'publish_request.approve' AND target_id = ${pending.id}`;
            expect(rows.length, `attempt ${attempt}: approve audit rows`).toBe(approvedNow ? 1 : 0);
            for (const row of rows) {
              if (row.metadata.namePin === "repinned") {
                expect(row.metadata.namePinFrom, `attempt ${attempt}`).toBeTruthy();
                expect(row.metadata.namePinTo, `attempt ${attempt}`).toBeTruthy();
              }
            }
          } finally {
            await sql.end();
          }
        }
      });
    }
  });
}

// A separate Postgres-only test proving the migrate-on-boot retrofit works on a LEGACY users
// table (existing rows, no org_member column). The conformance lanes only ever boot a fresh DB
// whose CREATE TABLE already has the column, so the ALTER's real upgrade branch is unproven there.
if (pgUrl) {
  describe("Postgres migrate-on-boot retrofits org_member on a legacy users table", () => {
    test("existing rows backfill to org_member=false (fail-closed)", async () => {
      const db = await createTestDatabase(pgUrl);
      const sql = postgres(db.url, { max: 1, onnotice: () => {} });
      try {
        // Pre-org_member shape with a row already present.
        await sql`CREATE TABLE users (
          id text PRIMARY KEY,
          gascity_user_id text NOT NULL,
          handle text NOT NULL,
          display_name text NOT NULL,
          role text NOT NULL DEFAULT 'user',
          status text NOT NULL DEFAULT 'active',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )`;
        await sql`INSERT INTO users (id, gascity_user_id, handle, display_name)
                  VALUES ('legacy-1', 'gc:legacy', 'legacy', 'Legacy User')`;

        const store = createStore(db.url, undefined);
        await store.init(); // runs ALTER TABLE users ADD COLUMN IF NOT EXISTS org_member ...
        try {
          // The pre-existing row backfills to false — fail-closed, no accidental entitlement.
          expect(await store.isOrgMember("legacy-1")).toBe(false);
        } finally {
          await store.close();
        }
      } finally {
        await sql.end();
        await db.drop();
      }
    });
  });

}
