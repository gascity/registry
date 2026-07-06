// Conformance suite: runs IDENTICAL assertions against BOTH RegistryStore impls so the
// FileRegistryStore double can't silently diverge from the production PostgresRegistryStore
// (TESTING.md §6.3/§8 — "proven double"). The Postgres lane runs against a real container
// in CI (a fresh database per suite, exercising init()'s migrate-on-boot DDL every run).
//
// Covered surfaces: users/roles, sessions, api tokens, cli device codes, the publish-request
// lifecycle (create/validate/approve/reject incl. terminal-state guard), ownership, dedup, and
// audit. NOT yet covered on both lanes (file-only today, tracked as follow-up): reviews, stars,
// profile edits, github publish imports, and expiry semantics — do not read this suite as
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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { CLI_DEVICE_CODE_TTL_MS, CLI_DEVICE_CODE_INTERVAL_SECONDS, generateCliDeviceCodePair } from "./cli-auth";
import { StoreConflictError, StoreValidationError, createStore } from "./store";
import { createTestDatabase } from "./test-db";
import type {
  IdentityClaims,
  PublishRegistryEntry,
  PublishRequestInput,
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

    test("submitter-scoped dedup: idempotent re-submit, conflict on divergence, per-submitter", async () => {
      const a = await store.ensureUser(identity());
      const b = await store.ensureUser(identity());
      const name = uid("pack");

      const first = await store.createPublishRequest(a.id, publishInput(name), "web_session");
      const again = await store.createPublishRequest(a.id, publishInput(name), "web_session");
      expect(again.id).toBe(first.id); // idempotent for the same submitter + identical input

      // Same submitter, same name+version, different commit -> conflict.
      await expect(
        store.createPublishRequest(a.id, publishInput(name, { commit: "c".repeat(40) }), "web_session"),
      ).rejects.toBeInstanceOf(StoreConflictError);

      // A different submitter with identical input gets a distinct row.
      const other = await store.createPublishRequest(b.id, publishInput(name), "web_session");
      expect(other.id).not.toBe(first.id);
    });

    test("ownership: upsert, per-user/per-repo check, and revocation", async () => {
      const ownerUser = await store.ensureUser(identity());
      const stranger = await store.ensureUser(identity());
      const repoFull = `acme/${uid("repo")}`;
      const input = ownershipInput(repoFull);

      const ownership = await store.upsertVerifiedPackOwnership(ownerUser.id, input);
      expect(ownership.verificationStatus).toBe("verified");
      const fetched = await store.getPackOwnership(input.packKey, input.sourceUrl);
      expect(fetched?.verificationStatus).toBe("verified");

      expect(await store.hasVerifiedRepoOwnership(ownerUser.id, repoFull)).toBe(true);
      expect(await store.hasVerifiedRepoOwnership(stranger.id, repoFull)).toBe(false);

      const removed = await store.deletePackOwnershipsForGithubRepositoryIds(
        [input.githubRepositoryId],
        "conformance test",
      );
      expect(removed).toBe(1);
      expect(await store.hasVerifiedRepoOwnership(ownerUser.id, repoFull)).toBe(false);
    });

    // Documented divergence (store.ts): the file store keeps no audit_logs. This asserts the
    // Postgres audit trail — the ownership-override justification is a security/compliance record.
    if (lane.name === "postgres") {
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
