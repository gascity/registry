import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import { createRegistryFetchHandler } from "./app";
import { validatePublishRequestForRegistry } from "./publish-validation";
import postgres from "postgres";
import { createStore } from "./store";
import { createTestDatabase } from "./test-db";
import type { ServerConfig } from "./config";
import type { GitHubActionsIdentity } from "./github-actions";
import type {
  GitHubPublishCandidate,
  GitHubPublishImportCreateInput,
  PublishRequestInput,
  PublishRequestRow,
  PublishSourceIdentity,
  PublishSubmissionMethod,
} from "./types";

// Mirror the conformance suite's no-silent-skip gate so this file also fails loudly if the CI
// step keeps REQUIRE_POSTGRES=1 but loses the URL (which would revert every harness to file).
if (process.env.REGISTRY_TEST_REQUIRE_POSTGRES === "1" && !process.env.REGISTRY_TEST_DATABASE_URL) {
  throw new Error(
    "publish-integration: REGISTRY_TEST_REQUIRE_POSTGRES=1 but REGISTRY_TEST_DATABASE_URL is unset.",
  );
}

const owner = "acme";
const repo = "registry-fixtures";
const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// A second commit, for the cases that need two releases whose bits genuinely differ (the
// withdrawn-version guard compares commit + hash + ref).
const secondCommit = "cccccccccccccccccccccccccccccccccccccccc";
const repoUrl = `https://github.com/${owner}/${repo}`;
// Module-scoped so every bearer publish in the file gets its own client address (see
// nextMachineClient) — the rate-limit buckets live in module state and outlive a harness.
let machineCount = 0;

describe("local registry publish integration", () => {
  test("accepts a locally created pack through every supported publish method", async () => {
    const harness = await createPublishHarness();
    try {
      const website = await harness.publicClient.text("/publish");
      expect(website).toContain("Registry integration shell");

      const submitter = await harness.signIn("publisher");
      const admin = await harness.signIn("admin", "admin");

      // Repo-proven paths: the submitter demonstrated control of the source repo at
      // submit time (GitHub Actions OIDC / GitHub import) — the merge gate approves
      // them with no override.
      const repoProven: PublishRequestRow[] = [
        await harness.publishWithGitHubActionsToken(
          await harness.createPack("github-actions", "0.1.0"),
        ),
        await harness.publishWithGitHubImport(
          submitter,
          await harness.createPack("github-import", "0.1.0"),
        ),
      ];
      expect(repoProven.map((request) => request.submissionMethod)).toEqual([
        "github_actions_oidc",
        "github_import",
      ]);

      // Claim-only paths: the submitter merely asserts a repo URL + pack name with no
      // proof of ownership — the merge gate blocks approval unless overridden.
      const claimOnly: PublishRequestRow[] = [
        await harness.publishWithSession(submitter, await harness.createPack("web-session", "0.1.0")),
        await harness.publishWithPersonalToken(
          submitter,
          await harness.createPack("personal-token", "0.1.0"),
        ),
        await harness.publishWithCliBrowserToken(
          submitter,
          await harness.createPack("cli-browser", "0.1.0"),
        ),
        await harness.publishWithCliDeviceToken(
          submitter,
          await harness.createPack("cli-device", "0.1.0"),
        ),
        await harness.publishWithEiaToken(await harness.createPack("sts-eia", "0.1.0")),
      ];
      expect(claimOnly.map((request) => request.submissionMethod)).toEqual([
        "web_session",
        "api_token",
        "api_token",
        "api_token",
        "api_token",
      ]);

      const allSubmitted = [...repoProven, ...claimOnly];
      for (const request of allSubmitted) {
        expect(request.status).toBe("pending_review");
        expect(request.registryEntry?.release.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      }

      // Repo-proven approve straight through.
      for (const request of repoProven) {
        await harness.approve(admin, request.id);
      }

      // Claim-only is rejected without an override, then approved with an audited reason.
      for (const request of claimOnly) {
        await harness.approveExpectingOwnershipError(admin, request.id);
        await harness.approve(admin, request.id, `Verified ${request.requestedName} ownership out of band.`);
      }

      const registryToml = await harness.publicClient.text("/registry.toml");
      const catalog = await harness.publicClient.json<{
        pack_count: number;
        packs: Array<{ name: string; latest: string; registry: string }>;
      }>("/catalog.json");

      expect(catalog.pack_count).toBe(allSubmitted.length);
      for (const request of allSubmitted) {
        expect(registryToml).toContain(`name = "${request.requestedName}"`);
        expect(catalog.packs).toContainEqual(
          expect.objectContaining({
            name: request.requestedName,
            latest: request.requestedVersion,
            registry: "direct",
          }),
        );
      }
    } finally {
      await harness.close();
    }
  });

  test("approves a claim-only publish when the submitter has verified repo ownership", async () => {
    const harness = await createPublishHarness();
    try {
      const submitter = await harness.signIn("repo-owner");
      const admin = await harness.signIn("admin", "admin");

      // Seed a verified pack-ownership record binding the submitter (as a publisher
      // member) to the source repo — exactly what the GitHub App ownership-claim flow
      // writes. The pack key + claim sourceUrl differ from the publish's commit-bearing
      // sourceUrl on purpose: the gate matches on repo identity, not the release URL.
      await harness.store.upsertVerifiedPackOwnership(submitter.userId, {
        packKey: "acme--registry-fixtures-claimed",
        sourceUrl: `${repoUrl}/tree/main`,
        githubRepositoryId: "repo_123",
        githubRepositoryFullName: `${owner}/${repo}`,
        githubRepositoryName: repo,
        githubOwnerId: "owner_123",
        githubOwnerLogin: owner,
        githubOwnerType: "Organization",
        verificationMethod: "github_app_user_token",
      });

      const request = await harness.publishWithPersonalToken(
        submitter,
        await harness.createPack("verified-owner-cli", "0.1.0"),
      );
      expect(request.submissionMethod).toBe("api_token");

      // No override needed: verified repo ownership authorizes the claim-only publish.
      const approved = await harness.approve(admin, request.id);
      expect(approved.status).toBe("approved");
    } finally {
      await harness.close();
    }
  });

  test("a foreign claim-only submission does not capture the repo owner's publish slot", async () => {
    const harness = await createPublishHarness();
    try {
      const attacker = await harness.signIn("squatter");
      const repoOwner = await harness.signIn("publisher");
      const admin = await harness.signIn("admin", "admin");

      const pack = await harness.createPack("contested", "0.1.0");

      // Attacker plants a validated claim-only request for the same name+version at the
      // real repo+commit (validation only reads the public pack.toml, so this succeeds).
      const planted = await harness.publishWithPersonalToken(attacker, pack);
      expect(planted.submissionMethod).toBe("api_token");

      // The owner publishes the identical artifact via GitHub import. Submitter-scoped
      // dedup gives them their OWN repo-proven row instead of collapsing onto the
      // attacker's claim-only row (which would downgrade the method + poison attribution).
      const owned = await harness.publishWithGitHubImport(repoOwner, pack);
      expect(owned.id).not.toBe(planted.id);
      expect(owned.submissionMethod).toBe("github_import");
      expect(owned.submittedBy.id).toBe(repoOwner.userId);

      // The owner's repo-proven publish approves with no override; the attacker's planted
      // claim-only row is still gated.
      await harness.approve(admin, owned.id);
      await harness.approveExpectingOwnershipError(admin, planted.id);
    } finally {
      await harness.close();
    }
  });

  test("does not let a non-member borrow another publisher's verified ownership", async () => {
    const harness = await createPublishHarness();
    try {
      const repoOwner = await harness.signIn("real-owner");
      const stranger = await harness.signIn("stranger");
      const admin = await harness.signIn("admin", "admin");

      // real-owner proves ownership of the repo...
      await harness.store.upsertVerifiedPackOwnership(repoOwner.userId, {
        packKey: "acme--registry-fixtures-owned",
        sourceUrl: `${repoUrl}/tree/main`,
        githubRepositoryId: "repo_123",
        githubRepositoryFullName: `${owner}/${repo}`,
        githubRepositoryName: repo,
        githubOwnerId: "owner_123",
        githubOwnerLogin: owner,
        githubOwnerType: "Organization",
        verificationMethod: "github_app_user_token",
      });

      // ...but a stranger who merely points at the same public repo URL is NOT a member
      // of that publisher, so the ownership escape hatch must not apply.
      const request = await harness.publishWithPersonalToken(
        stranger,
        await harness.createPack("stranger-cli", "0.1.0"),
      );
      await harness.approveExpectingOwnershipError(admin, request.id);
    } finally {
      await harness.close();
    }
  });

  test("approves an org member's claim-only publish without ownership or override, until de-provisioned", async () => {
    const harness = await createPublishHarness();
    try {
      const member = await harness.signIn("gascity-dev", undefined, { orgMember: true });
      const admin = await harness.signIn("admin", "admin");

      // Claim-only (personal token), no pack_ownerships row, no override -> approvable purely
      // because the submitter is a verified org member.
      const request = await harness.publishWithPersonalToken(member, await harness.createPack("org-member-cli", "0.1.0"));
      expect(request.submissionMethod).toBe("api_token");
      expect((await harness.approve(admin, request.id)).status).toBe("approved");

      // On the real-Postgres lane, prove the gate -> decision -> approve -> audit thread: the
      // approval basis is attributed to org membership (not dropped or mislabeled).
      if (harness.dbUrl) {
        const sql = postgres(harness.dbUrl, { max: 1, onnotice: () => {} });
        try {
          const rows = await sql`
            SELECT metadata FROM audit_logs
            WHERE target_id = ${request.id} AND action = 'publish_request.approve'`;
          expect(rows[0]?.metadata.ownershipBasis).toBe("org_member");
        } finally {
          await sql.end();
        }
      }

      // De-provision: the same user re-logs in WITHOUT the realm role (live-synced to false),
      // and a fresh claim-only publish is gated again (approve reads the submitter's live flag).
      await harness.signIn("gascity-dev");
      const afterLeaving = await harness.publishWithPersonalToken(
        member,
        await harness.createPack("org-member-left", "0.1.0"),
      );
      await harness.approveExpectingOwnershipError(admin, afterLeaving.id);
    } finally {
      await harness.close();
    }
  });

  test("org membership grants publishing only: staff routes still 403 for a plain user and an org member", async () => {
    const harness = await createPublishHarness();
    try {
      const plain = await harness.signIn("plain-user");
      const orgOnly = await harness.signIn("org-only", undefined, { orgMember: true });
      for (const client of [plain, orgOnly]) {
        const res = await client.request("/api/admin/publish-requests", { csrfToken: client.csrfToken });
        expect(res.status).toBe(403);
        // FORBIDDEN (from requireRegistryStaff), not BAD_CSRF — proves the deny is the staff
        // boundary, so this can't pass green if an org member started reaching admin routes.
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
      }
    } finally {
      await harness.close();
    }
  });

  test("staff withdraw takes an approved publish off the served catalog; the name@version can be reinstated", async () => {
    const harness = await createPublishHarness();
    try {
      const submitter = await harness.signIn("withdraw-publisher", undefined, { orgMember: true });
      const admin = await harness.signIn("admin", "admin");

      const pack = await harness.createPack("withdraw-me", "1.0.0");
      const request = await harness.publishWithSession(submitter, pack);
      expect((await harness.approve(admin, request.id)).status).toBe("approved");

      // Approved publish is live in both served artifacts.
      const asServed = async () => ({
        toml: await harness.publicClient.text("/registry.toml"),
        catalog: await harness.publicClient.json<{ packs: Array<{ name: string; registry: string }> }>(
          "/catalog.json",
        ),
      });
      let served = await asServed();
      expect(served.toml).toContain(`name = "${request.requestedName}"`);
      expect(served.catalog.packs).toContainEqual(
        expect.objectContaining({ name: request.requestedName, registry: "direct" }),
      );

      // The submitter owns the request but is not staff: withdraw is a staff-only takedown.
      const forbidden = await submitter.request(`/api/publish-requests/${request.id}/withdraw`, {
        method: "POST",
        csrfToken: submitter.csrfToken,
        body: { reason: "not allowed" },
      });
      expect(forbidden.status).toBe(403);
      expect(((await forbidden.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");

      // Staff takedown flips the row terminal and drops it from the runtime catalog immediately.
      const withdrawn = await harness.withdraw(admin, request.id, "takedown: DMCA notice #42");
      expect(withdrawn.status).toBe("withdrawn");
      expect(withdrawn.statusReason).toContain("DMCA notice #42");

      served = await asServed();
      expect(served.toml).not.toContain(`name = "${request.requestedName}"`);
      expect(served.catalog.packs.some((p) => p.name === request.requestedName)).toBe(false);

      // A withdrawn (terminal) request can't be resurrected via re-validation, even by its owner.
      const revalidate = await submitter.request(`/api/publish-requests/${request.id}/validate`, {
        method: "POST",
        csrfToken: submitter.csrfToken,
      });
      expect(revalidate.status).toBe(409);
      expect(((await revalidate.json()) as { error: { code: string } }).error.code).toBe("PUBLISH_STATE_TERMINAL");

      // Reinstatement: re-submitting the identical name@version is a fresh request (dedup ignores
      // withdrawn), and once approved the pack is served again.
      const reinstated = await harness.publishWithSession(submitter, pack);
      expect(reinstated.id).not.toBe(request.id);
      expect((await harness.approve(admin, reinstated.id)).status).toBe("approved");

      served = await asServed();
      expect(served.toml).toContain(`name = "${request.requestedName}"`);
      expect(served.catalog.packs).toContainEqual(
        expect.objectContaining({ name: request.requestedName, registry: "direct" }),
      );
    } finally {
      await harness.close();
    }
  });

  test("withdraw blocks re-publishing the same name@version with DIFFERENT provenance", async () => {
    const harness = await createPublishHarness();
    try {
      const submitter = await harness.signIn("swap-publisher", undefined, { orgMember: true });
      const admin = await harness.signIn("admin", "admin");

      // Original release is pinned to an immutable tag ref.
      const pack: TestPack = { ...(await harness.createPack("swap", "1.0.0")), requestedRef: "refs/tags/v1.0.0" };
      const request = await harness.publishWithSession(submitter, pack);
      expect((await harness.approve(admin, request.id)).status).toBe("approved");
      await harness.withdraw(admin, request.id, "takedown: bad provenance");

      // Re-publish the SAME name@version+commit+hash but swapping the immutable tag for a MUTABLE
      // branch ref. Dedup ignores the withdrawn row, so this validates into a fresh pending request...
      const swapped: TestPack = { ...pack, requestedRef: "refs/heads/main" };
      const resubmitted = await harness.publishWithSession(submitter, swapped);
      expect(resubmitted.id).not.toBe(request.id);
      expect(resubmitted.registryEntry?.release.ref).toBe("refs/heads/main");

      // ...but approval must be refused: a withdrawn name@version can only be reinstated with the
      // identical commit+hash+ref, so a provenance swap under pinned clients is blocked.
      const res = await admin.request(`/api/publish-requests/${resubmitted.id}/approve`, {
        method: "POST",
        csrfToken: admin.csrfToken,
        body: {},
      });
      const text = await res.text();
      expect(res.status, text).toBe(409);
      expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("PUBLISH_VERSION_WITHDRAWN");

      // Nothing is served at that name — neither the withdrawn original nor the rejected swap.
      const catalog = await harness.publicClient.json<{ packs: Array<{ name: string }> }>("/catalog.json");
      expect(catalog.packs.some((p) => p.name === request.requestedName)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  // ATTACK (a) — name takeover. Before the namespace gate, assertPublishRequestCanMerge never
  // compared the requested name to any owner record, so a repo-proven publish from ANY repo could
  // claim ANY name. Every case below approves 200 on that code and takes the pack over.
  test("a proven repo cannot take over a name another repo already claimed", async () => {
    const harness = await createPublishHarness();
    try {
      const incumbent = await harness.signIn("incumbent-maintainer");
      const admin = await harness.signIn("admin", "admin");

      // 1. A grandfathered BARE name, shaped like the live community pack: claimed by
      //    wespd/cacc-twin-team from the pre-gate world.
      await harness.seedApprovedPublish(
        incumbent.userId,
        admin.userId,
        await harness.createPack("bare-incumbent", "1.0.0", {
          name: "cacc-twin-team",
          repoUrl: "https://github.com/wespd/cacc-twin-team",
        }),
      );
      // The attacker forks it, so validation (which only reads public content) passes, and holds a
      // real GitHub Actions token for their OWN repo — fully repo-proven.
      const bareAttack = await harness.publishWithGitHubActionsToken(
        await harness.createPack("bare-attack", "2.0.0", {
          name: "cacc-twin-team",
          repoUrl: "https://github.com/evil/cacc-twin-team",
        }),
      );
      expect(bareAttack.submissionMethod).toBe("github_actions_oidc");
      const bareError = await harness.approveExpectingError(
        admin,
        bareAttack.id,
        409,
        "PUBLISH_NAME_OWNER_MISMATCH",
      );
      expect(bareError.message).toContain("wespd/cacc-twin-team");

      // 2. A SIBLING repo under the same owner. The scope matches, so only the claim pin stands
      //    between one team's repo and another team's pack name.
      const sibling = `${owner}/integration-sibling`;
      const held = await harness.publishWithGitHubActionsToken(
        await harness.createPack("sibling-incumbent", "1.0.0", { name: sibling }),
      );
      await harness.approve(admin, held.id);
      const siblingAttack = await harness.publishWithGitHubActionsToken(
        await harness.createPack("sibling-attack", "1.1.0", {
          name: sibling,
          repoUrl: `https://github.com/${owner}/some-other-repo`,
        }),
      );
      await harness.approveExpectingError(admin, siblingAttack.id, 409, "PUBLISH_NAME_OWNER_MISMATCH");

      // 3. A repo TRANSFER: same GitHub repository id, new account. The id alone would report
      //    "same repo", so the claim pin has to compare the owner login too.
      const transferred = "integration-transferred";
      await harness.seedApprovedPublish(
        incumbent.userId,
        admin.userId,
        await harness.createPack("transfer-incumbent", "1.0.0", {
          name: transferred,
          repoUrl: `https://github.com/${owner}/transferred-pack`,
        }),
        {
          submissionMethod: "github_actions_oidc",
          sourceIdentity: sourceIdentityFor(`${owner}/transferred-pack`),
        },
      );
      const transferAttack = await harness.publishWithGitHubActionsToken(
        await harness.createPack("transfer-attack", "2.0.0", {
          name: transferred,
          repoUrl: "https://github.com/evil/transferred-pack",
        }),
      );
      expect(transferAttack.sourceGithubRepositoryId).toBe("repo_transferred"); // id says "same repo"
      await harness.approveExpectingError(admin, transferAttack.id, 409, "PUBLISH_NAME_OWNER_MISMATCH");

      // Nothing the attacker submitted was served, and no claim moved.
      const catalog = await harness.publicClient.json<{ packs: Array<{ name: string; latest: string }> }>(
        "/catalog.json",
      );
      expect(catalog.packs).toContainEqual(expect.objectContaining({ name: "cacc-twin-team", latest: "1.0.0" }));
      expect(catalog.packs).toContainEqual(expect.objectContaining({ name: sibling, latest: "1.0.0" }));
      expect((await harness.store.getPackNameClaim("cacc-twin-team"))?.repoFullName).toBe("wespd/cacc-twin-team");
      expect((await harness.store.getPackNameClaim(sibling))?.repoFullName).toBe(`${owner}/${repo}`);
      expect((await harness.store.getPackNameClaim(transferred))?.githubOwnerLogin).toBe(owner);
    } finally {
      await harness.close();
    }
  });

  // ATTACK (b) — minting a NEW bare name. Bare names are the ingested half of the namespace; the
  // only publishable ones are those already claimed when the gate shipped.
  test("a new bare (unscoped) name is refused even from a fully proven repo", async () => {
    const harness = await createPublishHarness();
    try {
      const publisher = await harness.signIn("bare-namer", undefined, { orgMember: true });
      const admin = await harness.signIn("admin", "admin");

      const bare = await harness.publishWithGitHubActionsToken(
        await harness.createPack("bare-new", "1.0.0", { name: "integration-bare-new" }),
      );
      expect(bare.submissionMethod).toBe("github_actions_oidc");
      const error = await harness.approveExpectingError(admin, bare.id, 403, "PUBLISH_NAME_RESERVED");
      // The refusal names the scoped form the publisher should have used.
      expect(error.message).toContain(`${owner}/integration-bare-new`);

      // No staff bypass: neither override key opens a reserved name.
      await harness.approveExpectingError(admin, bare.id, 403, "PUBLISH_NAME_RESERVED", {
        ownershipOverrideReason: "I know these people",
        namePinOverrideReason: "let them have it",
      });
      expect(await harness.store.getPackNameClaim("integration-bare-new")).toBeNull();

      // The same pack under its owner's scope is fine — the gate blocks the shape, not the pack.
      const scoped = await harness.publishWithSession(
        publisher,
        await harness.createPack("bare-new-scoped", "1.0.0", { name: `${owner}/integration-bare-new` }),
      );
      expect((await harness.approve(admin, scoped.id)).status).toBe("approved");
    } finally {
      await harness.close();
    }
  });

  // ATTACK (c) — squatting someone else's scope. Proving repo control IS proving scope control, so
  // the scope segment must equal the owner of the repo the merge gate already proved.
  test("a scope that is not the proven repo owner is refused", async () => {
    const harness = await createPublishHarness();
    try {
      const attacker = await harness.signIn("scope-squatter", undefined, { orgMember: true });
      const admin = await harness.signIn("admin", "admin");

      // Repo-proven for acme/registry-fixtures, but the name claims the `microsoft` scope.
      const squat = await harness.publishWithGitHubActionsToken(
        await harness.createPack("scope-squat", "1.0.0", { name: "microsoft/integration-scope-squat" }),
      );
      const error = await harness.approveExpectingError(admin, squat.id, 403, "PUBLISH_SCOPE_MISMATCH");
      expect(error.message).toContain("microsoft");
      expect(error.message).toContain(owner);

      // Not overridable either: staff cannot hand out a scope whose owner nobody proved.
      await harness.approveExpectingError(admin, squat.id, 403, "PUBLISH_SCOPE_MISMATCH", {
        ownershipOverrideReason: "vouched for",
        namePinOverrideReason: "vouched for",
      });

      // A claim-only submission can't route around it either — the asserted repo owner is still
      // what the scope is compared against.
      const claimOnly = await harness.publishWithPersonalToken(
        attacker,
        await harness.createPack("scope-squat-cli", "1.0.0", { name: "microsoft/integration-scope-cli" }),
      );
      await harness.approveExpectingError(admin, claimOnly.id, 403, "PUBLISH_SCOPE_MISMATCH");
      expect(await harness.store.getPackNameClaim("microsoft/integration-scope-squat")).toBeNull();
    } finally {
      await harness.close();
    }
  });

  // ATTACK (d) — the withdrawn-version denial of service. The withdrawn-name@version guard used to
  // be global, so a hostile publish plus a takedown permanently burned that version number for the
  // repo that actually owns the name. Now it only bites within one lineage (same repo or same
  // submitter), which is the only place the anti-content-swap rule ever meant anything.
  test("a hostile publish-then-takedown no longer burns the version for the real owner", async () => {
    const harness = await createPublishHarness();
    try {
      const admin = await harness.signIn("admin", "admin");
      const name = `${owner}/integration-dos`;

      // The squatter gets there first from a DIFFERENT repo under the same owner, so the scope
      // check passes and they legitimately mint the claim...
      const hostile = await harness.publishWithGitHubActionsToken(
        await harness.createPack("dos-hostile", "1.0.0", {
          name,
          repoUrl: `https://github.com/${owner}/squatted-fork`,
        }),
      );
      await harness.approve(admin, hostile.id);
      // ...and staff take it down AND free the name (the release flag this slice adds; without it
      // the claim would still point at the squatter's repo).
      await harness.withdraw(admin, hostile.id, "takedown: hostile squat", { releaseNameClaim: true });

      // The real owner now publishes the same name@1.0.0 from its own repo with different bits.
      const owned = await harness.publishWithGitHubActionsToken(
        await harness.createPack("dos-real", "1.0.0", { name, commit: secondCommit }),
      );
      // A different repo AND a different submitter (each repo's workflow publishes as its own
      // GitHub Actions identity), so this is a different lineage on both tests.
      expect(owned.submittedBy.id).not.toBe(hostile.submittedBy.id);
      expect(owned.registryEntry?.release.hash).not.toBe(hostile.registryEntry?.release.hash);

      // Different lineage -> the takedown does not follow the version number around. Asserted
      // BEFORE the claim-release assertion below on purpose: the refusal is what this test exists
      // to prove, so a regression has to surface as a refused approve, not as a missing flag.
      expect((await harness.approve(admin, owned.id)).status).toBe("approved");
      const catalog = await harness.publicClient.json<{ packs: Array<{ name: string; latest: string }> }>(
        "/catalog.json",
      );
      expect(catalog.packs).toContainEqual(expect.objectContaining({ name, latest: "1.0.0" }));
      // The release freed the name, so the owner's approve is what re-claimed it.
      expect((await harness.store.getPackNameClaim(name))?.repoFullName).toBe(`${owner}/${repo}`);
      expect((await harness.store.getPackNameClaim(name))?.sourceRequestId).toBe(owned.id);
    } finally {
      await harness.close();
    }
  });

  // H4's lineage filter is an OR of two independent predicates (same source repo, OR same
  // submitter). ATTACK (d) above is the negative control — it differs on BOTH, so it holds for
  // either disjunct alone and pins neither. The next two tests are the positive controls, one per
  // disjunct: each satisfies exactly one side of the OR, so deleting that side alone lets the
  // withdrawn version be re-published with different bits.

  // Pins `w.submittedBy.id === publishRequest.submittedBy.id`. One publisher, two repos: they
  // cannot launder a takedown of their own release by moving it to a sibling repo.
  test("a withdrawn version cannot be re-published with different bits by the same submitter from another repo", async () => {
    const harness = await createPublishHarness();
    try {
      // orgMember so the claim-only (web_session) submissions clear the ownership gate without an
      // override — the withdrawn-version guard is the only thing under test here.
      const publisher = await harness.signIn("lineage-submitter", undefined, { orgMember: true });
      const admin = await harness.signIn("admin", "admin");
      const name = `${owner}/integration-lineage-submitter`;

      const first = await harness.publishWithSession(
        publisher,
        await harness.createPack("lineage-submitter-a", "1.0.0", {
          name,
          repoUrl: `https://github.com/${owner}/lineage-repo-a`,
        }),
      );
      await harness.approve(admin, first.id);
      // Release the claim as well: without it the SECOND approve dies at H2 (the claim pins
      // acme/lineage-repo-a, and neither claim-only side proved ids so the compare is on the repo
      // full name) and the test would assert the wrong refusal code.
      await harness.withdraw(admin, first.id, "takedown: content", { releaseNameClaim: true });

      // Same person, different repo, same name@version, DIFFERENT bits.
      const second = await harness.publishWithSession(
        publisher,
        await harness.createPack("lineage-submitter-b", "1.0.0", {
          name,
          repoUrl: `https://github.com/${owner}/lineage-repo-b`,
          commit: secondCommit,
        }),
      );
      expect(second.submittedBy.id).toBe(first.submittedBy.id);
      expect(second.repository.fullName).not.toBe(first.repository.fullName);
      expect(second.registryEntry?.release.hash).not.toBe(first.registryEntry?.release.hash);

      await harness.approveExpectingError(admin, second.id, 409, "PUBLISH_VERSION_WITHDRAWN");
      const catalog = await harness.publicClient.json<{ packs: Array<{ name: string }> }>("/catalog.json");
      expect(catalog.packs.some((pack) => pack.name === name)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  // Pins `sameSourceRepository(w, publishRequest)`. One repo, two people: a teammate cannot
  // re-publish a taken-down version with different bits just by being a different account. This
  // is also the only coverage of sameSourceRepository's ids-first branch — both sides here are
  // repo-proven, so they carry GitHub's numeric repository id rather than falling back to the
  // repo full name.
  test("a withdrawn version cannot be re-published with different bits by a teammate from the same repo", async () => {
    const harness = await createPublishHarness();
    try {
      const teammate = await harness.signIn("lineage-teammate", undefined, { orgMember: true });
      const admin = await harness.signIn("admin", "admin");
      const name = `${owner}/integration-lineage-repo`;

      // Machine submitter (the repo's GitHub Actions identity), ids stamped from the OIDC claim.
      const first = await harness.publishWithGitHubActionsToken(
        await harness.createPack("lineage-repo-ci", "1.0.0", { name }),
      );
      expect(first.sourceGithubRepositoryId).toBe(repoIdentityFor(`${owner}/${repo}`).repositoryId);
      await harness.approve(admin, first.id);
      // No releaseNameClaim: the claim pins the REPO, and the second publish comes from that same
      // repo, so H2 passes on its own. That is what leaves H4 as the only possible refusal.
      await harness.withdraw(admin, first.id, "takedown: content");

      // Human submitter on the same repo (GitHub App import), same name@version, DIFFERENT bits.
      const second = await harness.publishWithGitHubImport(
        teammate,
        await harness.createPack("lineage-repo-human", "1.0.0", { name, commit: secondCommit }),
      );
      expect(second.submittedBy.id).not.toBe(first.submittedBy.id);
      expect(second.sourceGithubRepositoryId).toBe(first.sourceGithubRepositoryId);
      expect(second.registryEntry?.release.hash).not.toBe(first.registryEntry?.release.hash);

      await harness.approveExpectingError(admin, second.id, 409, "PUBLISH_VERSION_WITHDRAWN");
      const catalog = await harness.publicClient.json<{ packs: Array<{ name: string }> }>("/catalog.json");
      expect(catalog.packs.some((pack) => pack.name === name)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  // Pins sameSourceRepository's IDS-FIRST branch, which the two tests above cannot: they compare
  // repos that share both an id and a full name, so the repo-full-name fallback answers
  // identically and deleting the id branch changes nothing. A repo RENAME is the one shape where
  // the two disagree in the direction that matters — same numeric repository id, different full
  // name — so only here does "ids first" decide that this is still the same lineage.
  test("a withdrawn version cannot be re-published with different bits after the source repo is renamed", async () => {
    const harness = await createPublishHarness();
    try {
      const maintainer = await harness.signIn("lineage-renamed-maintainer");
      const admin = await harness.signIn("admin", "admin");
      const name = `${owner}/integration-lineage-renamed`;
      const before = `${owner}/renamed-before`;
      const after = `${owner}/renamed-after`;

      // Machine submitter (CI) before the rename...
      const first = await harness.publishWithGitHubActionsToken(
        await harness.createPack("lineage-renamed-v1", "1.0.0", {
          name,
          repoUrl: `https://github.com/${before}`,
        }),
      );
      await harness.approve(admin, first.id);
      await harness.withdraw(admin, first.id, "takedown: content");

      // ...human submitter (GitHub App import) after it. Both repo-proven, so both carry the
      // numeric repository id the rename preserved.
      const second = await harness.publishWithGitHubImport(
        maintainer,
        await harness.createPack("lineage-renamed-v2", "1.0.0", {
          name,
          repoUrl: `https://github.com/${after}`,
          commit: secondCommit,
        }),
      );
      // The rename shape: one repository id, two full names, two different submitters. So neither
      // the repo-full-name fallback nor the submitter disjunct can refuse this — sameSourceRepository's
      // id compare is the only thing that can.
      expect(second.sourceGithubRepositoryId).toBe(first.sourceGithubRepositoryId);
      expect(second.repository.fullName).not.toBe(first.repository.fullName);
      expect(second.submittedBy.id).not.toBe(first.submittedBy.id);
      expect(second.registryEntry?.release.hash).not.toBe(first.registryEntry?.release.hash);

      await harness.approveExpectingError(admin, second.id, 409, "PUBLISH_VERSION_WITHDRAWN");
      const catalog = await harness.publicClient.json<{ packs: Array<{ name: string }> }>("/catalog.json");
      expect(catalog.packs.some((pack) => pack.name === name)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  // H4 keys on the version STRING — listWithdrawnPublishRequestsForVersion matches
  // requested_version as bytes — so the guard is only as strong as the grammar that mints that
  // string. While the grammar admitted both arities and leading zeros, a taken-down 0.1.0 re-landed
  // as 0.1, 0.01.0 or 00.1.0: three strings H4 looks up and finds nothing withdrawn under, which
  // compareVersions (which parseInts and pads to three) then calls the SAME version, so the site
  // served the withdrawn commit again and the machine gate told the reviewer it was clean.
  test("a takedown cannot be re-landed under an equivalent spelling of the same version", async () => {
    const harness = await createPublishHarness();
    try {
      const admin = await harness.signIn("admin", "admin");
      const publisher = await harness.signIn("respell-pub");
      const name = `${owner}/integration-respell`;

      const served = await harness.publishWithGitHubActionsToken(
        await harness.createPack("respell", "0.1.0", { name }),
      );
      await harness.approve(admin, served.id);
      await harness.withdraw(admin, served.id, "takedown: malicious content");

      // CONTROL: the canonical spelling is refused, which is H4 working as designed.
      const control = await harness.publishWithGitHubActionsToken(
        await harness.createPack("respell", "0.1.0", { name, commit: secondCommit }),
      );
      await harness.approveExpectingError(admin, control.id, 409, "PUBLISH_VERSION_WITHDRAWN");

      // ATTACK: every synonym is now refused at MINT, before a reviewable row exists at all. One
      // canonical spelling per version is what keeps H4's byte compare total.
      for (const respelling of ["0.1", "0.01.0", "00.1.0", "0.1.00"]) {
        const attack = await harness.createPack("respell", "0.1.0", { name, commit: secondCommit });
        await harness.publishExpectingError(
          publisher,
          { ...attack, requestedVersion: respelling },
          422,
          "VALIDATION_ERROR",
        );
      }

      // Nothing withdrawn came back, under any spelling.
      const catalog = await harness.publicClient.json<{
        packs: Array<{ name: string; latest: string; releases: Array<{ version: string }> }>;
      }>("/catalog.json");
      expect(catalog.packs.some((pack) => pack.name === name)).toBe(false);
      const withdrawnRows = await harness.store.listWithdrawnPublishRequestsForVersion(name, "0.1.0");
      expect(withdrawnRows).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  // BACKWARD-COMPAT GUARANTEE the whole design rests on: the live bare-named community pack keeps
  // working. No rename and no alias (either would break its installers) — its grandfathered claim
  // is what makes the reserved-bare-name rule survivable.
  test("a grandfathered bare-named pack keeps cutting releases from its own repo", async () => {
    const harness = await createPublishHarness();
    try {
      const maintainer = await harness.signIn("wespd");
      const admin = await harness.signIn("admin", "admin");
      const legacyRepo = "wespd/cacc-twin-team";

      await harness.seedApprovedPublish(
        maintainer.userId,
        admin.userId,
        await harness.createPack("cacc-v1", "1.0.0", {
          name: "cacc-twin-team",
          repoUrl: `https://github.com/${legacyRepo}`,
        }),
      );
      const claim = await harness.store.getPackNameClaim("cacc-twin-team");
      expect(claim).toMatchObject({ repoFullName: legacyRepo, githubOwnerLogin: "wespd" });
      expect(claim?.scope).toBeUndefined();
      // Load-bearing for the fail-closed rule in the merge gate below: this claim proved NO numeric
      // ids (its releases are claim-only), so there is no id pin for an id-less submission to
      // defeat, and the repoFullName fallback stays the correct — and only — comparison available.
      // The unprovenNamePin refusal keys on `claim.githubRepositoryId != null` precisely so that it
      // cannot fire here. If this pack ever stops approving, that guard is too broad.
      expect(claim?.githubRepositoryId).toBeUndefined();
      expect(claim?.githubOwnerId).toBeUndefined();

      // The maintainer proved the repo through the GitHub App, so the next release needs no staff
      // override at all — the bare name is the ONLY thing that could have blocked it.
      await harness.store.upsertVerifiedPackOwnership(maintainer.userId, {
        packKey: "wespd--cacc-twin-team",
        sourceUrl: `https://github.com/${legacyRepo}/tree/main`,
        githubRepositoryId: "repo_wespd_cacc-twin-team",
        githubRepositoryFullName: legacyRepo,
        githubRepositoryName: "cacc-twin-team",
        githubOwnerId: "owner_wespd",
        githubOwnerLogin: "wespd",
        githubOwnerType: "User",
        verificationMethod: "github_app_user_token",
      });
      const next = await harness.publishWithPersonalToken(
        maintainer,
        await harness.createPack("cacc-v2", "1.1.0", {
          name: "cacc-twin-team",
          repoUrl: `https://github.com/${legacyRepo}`,
          commit: secondCommit,
        }),
      );
      expect((await harness.approve(admin, next.id)).status).toBe("approved");

      // Both releases served under the unchanged bare name, and the claim did not move.
      const catalog = await harness.publicClient.json<{
        packs: Array<{ name: string; latest: string; releases: Array<{ version: string }> }>;
      }>("/catalog.json");
      const served = catalog.packs.find((pack) => pack.name === "cacc-twin-team");
      expect(served?.latest).toBe("1.1.0");
      expect(served?.releases.map((release) => release.version).sort()).toEqual(["1.0.0", "1.1.0"]);
      expect(await harness.store.getPackNameClaim("cacc-twin-team")).toEqual(claim);
    } finally {
      await harness.close();
    }
  });

  // The population the claim pin exists to SERVE, as opposed to the ones it exists to block: a
  // repo-proven scoped pack cutting its own follow-up releases from the same repo. Every other pin
  // test is a mismatch, and the grandfathered/claim-only cases take the repoFullName fallback, so
  // without this the id-equality branch of nameClaimMatchesRequest has no coverage at all —
  // stubbing it to `return false` left the whole suite green.
  test("a scoped pack's own follow-up releases keep approving from the same repo", async () => {
    const harness = await createPublishHarness();
    try {
      const admin = await harness.signIn("admin", "admin");
      const name = `${owner}/integration-followup`;

      const first = await harness.publishWithGitHubActionsToken(
        await harness.createPack("followup-v1", "1.0.0", { name }),
      );
      expect((await harness.approve(admin, first.id)).status).toBe("approved");
      const claim = await harness.store.getPackNameClaim(name);
      // Repo-proven, so the claim carries GitHub's numeric ids — this is what makes the comparison
      // take the id path rather than the name fallback.
      expect(claim).toMatchObject({
        githubRepositoryId: repoIdentityFor(`${owner}/${repo}`).repositoryId,
        githubOwnerId: repoIdentityFor(`${owner}/${repo}`).ownerId,
      });

      // Same repo, same owner, later release: approves with no override, and does NOT move the pin.
      const second = await harness.publishWithGitHubActionsToken(
        await harness.createPack("followup-v2", "1.1.0", { name }),
      );
      expect(second.sourceGithubRepositoryId).toBe(claim!.githubRepositoryId);
      expect((await harness.approve(admin, second.id)).status).toBe("approved");
      expect(await harness.store.getPackNameClaim(name)).toEqual(claim);

      // A teammate's release counts too: the pin is to the REPO, not to the person who first
      // published it, so a second maintainer publishing from the same repo is not a takeover.
      const teammate = await harness.signIn("followup-teammate", undefined, { orgMember: true });
      const third = await harness.publishWithGitHubImport(
        teammate,
        await harness.createPack("followup-v3", "1.2.0", { name }),
      );
      expect(third.submittedBy.id).not.toBe(first.submittedBy.id);
      expect((await harness.approve(admin, third.id)).status).toBe("approved");
      expect(await harness.store.getPackNameClaim(name)).toEqual(claim);
    } finally {
      await harness.close();
    }
  });

  // Enrichment trust-model condition (3): the ids may come ONLY from what the trusted auth context
  // stamped on the request. A personal token proves a bearer, not a repository, so its publishes
  // must teach the claim nothing — even though the pack HAS a verified pack_ownerships row carrying
  // both real GitHub ids. Sourcing ids from anywhere but PublishSourceIdentity (the body; the
  // ownership table) would let the caller choose the pin. This is also the honest statement of
  // enrichment's limits: it does nothing for the live bare community pack, whose releases arrive by
  // personal token. That pack's only cure is the staff re-pin.
  test("a claim-only publish never teaches the name claim any github ids", async () => {
    const harness = await createPublishHarness();
    try {
      const maintainer = await harness.signIn("wespd");
      const admin = await harness.signIn("admin", "admin");
      const legacyRepo = "wespd/cacc-twin-team";

      await harness.seedApprovedPublish(
        maintainer.userId,
        admin.userId,
        await harness.createPack("enrich-cacc-v1", "1.0.0", {
          name: "cacc-twin-team",
          repoUrl: `https://github.com/${legacyRepo}`,
        }),
      );
      const claim = await harness.store.getPackNameClaim("cacc-twin-team");
      expect(claim?.githubRepositoryId).toBeUndefined();
      expect(claim?.githubOwnerId).toBeUndefined();

      // A verified ownership record for the very same repo, WITH both numeric ids. Enrichment must
      // not reach for it: an ownership row records who proved control of a REPO for the Trust badge,
      // and the ids on it come from whatever GitHub identity the App callback saw — not from the
      // trusted auth context of THIS publish. Sourcing a name pin from anywhere but
      // PublishSourceIdentity would let the caller choose the pin. (Direct packs now DO get ownership
      // rows — the ownership flow resolves `direct--` keys against pack_name_claims — so this is a
      // live path, not a hypothetical one.)
      await harness.store.upsertVerifiedPackOwnership(maintainer.userId, {
        packKey: "wespd--cacc-twin-team",
        sourceUrl: `https://github.com/${legacyRepo}/tree/main`,
        githubRepositoryId: "repo_wespd_cacc-twin-team",
        githubRepositoryFullName: legacyRepo,
        githubRepositoryName: "cacc-twin-team",
        githubOwnerId: "owner_wespd",
        githubOwnerLogin: "wespd",
        githubOwnerType: "User",
        verificationMethod: "github_app_user_token",
      });

      const next = await harness.publishWithPersonalToken(
        maintainer,
        await harness.createPack("enrich-cacc-v2", "1.1.0", {
          name: "cacc-twin-team",
          repoUrl: `https://github.com/${legacyRepo}`,
          commit: secondCommit,
        }),
      );
      expect(next.submissionMethod).toBe("api_token");
      expect(next.sourceGithubRepositoryId).toBeUndefined();
      expect((await harness.approve(admin, next.id)).status).toBe("approved");
      expect(await harness.store.getPackNameClaim("cacc-twin-team")).toEqual(claim);
    } finally {
      await harness.close();
    }
  });

  // The import path's end-to-end id capture: installation listing -> candidate.repository.ownerId
  // -> createPublishRequest's PublishSourceIdentity -> the request columns -> the minted claim's
  // binding. Every link was already wired; none of it was asserted, so deleting either stamp left
  // the suite green while silently downgrading the claim comparison to a case-folded login compare.
  test("a github_import publish stamps both GitHub ids and pins the claim by them", async () => {
    const harness = await createPublishHarness();
    try {
      const maintainer = await harness.signIn("import-ids-maintainer");
      const admin = await harness.signIn("admin", "admin");
      const name = `${owner}/integration-import-ids`;
      const ids = repoIdentityFor(`${owner}/${repo}`);

      const imported = await harness.publishWithGitHubImport(
        maintainer,
        await harness.createPack("import-ids", "1.0.0", { name }),
      );
      expect(imported.submissionMethod).toBe("github_import");
      expect(imported.sourceGithubRepositoryId).toBe(ids.repositoryId);
      expect(imported.sourceGithubOwnerId).toBe(ids.ownerId);

      await harness.approve(admin, imported.id);
      expect(await harness.store.getPackNameClaim(name)).toMatchObject({
        repoFullName: `${owner}/${repo}`,
        githubRepositoryId: ids.repositoryId,
        githubOwnerId: ids.ownerId,
      });
    } finally {
      await harness.close();
    }
  });

  test("staff can re-pin a name onto a migrated repo, and the move is audited", async () => {
    const harness = await createPublishHarness();
    try {
      const admin = await harness.signIn("admin", "admin");
      const name = `${owner}/integration-migrated`;
      const newRepo = `${owner}/registry-fixtures-next`;

      const first = await harness.publishWithGitHubActionsToken(
        await harness.createPack("migrated-v1", "1.0.0", { name }),
      );
      await harness.approve(admin, first.id);

      // The pack moves to a new repo under the same owner: the scope still matches, but the claim
      // still points at the old repo.
      const moved = await harness.publishWithGitHubActionsToken(
        await harness.createPack("migrated-v2", "1.1.0", { name, repoUrl: `https://github.com/${newRepo}` }),
      );
      await harness.approveExpectingError(admin, moved.id, 409, "PUBLISH_NAME_OWNER_MISMATCH");
      // An OWNERSHIP override does not authorize moving a name. Two decisions, two keys — otherwise
      // any "I verified them out of band" approval would silently re-point whatever name it touched.
      await harness.approveExpectingError(admin, moved.id, 409, "PUBLISH_NAME_OWNER_MISMATCH", {
        ownershipOverrideReason: "vouched for the publisher",
      });

      const approved = await harness.approve(admin, moved.id, undefined, "repo migrated, ticket #77");
      expect(approved.status).toBe("approved");
      expect(await harness.store.getPackNameClaim(name)).toMatchObject({
        repoFullName: newRepo,
        githubRepositoryId: repoIdentityFor(newRepo).repositoryId,
        sourceRequestId: moved.id,
      });
      // The re-pinned repo is now the pinned one: the OLD repo has to be re-pinned back to publish.
      const relapse = await harness.publishWithGitHubActionsToken(
        await harness.createPack("migrated-v3", "1.2.0", { name }),
      );
      await harness.approveExpectingError(admin, relapse.id, 409, "PUBLISH_NAME_OWNER_MISMATCH");

      if (harness.dbUrl) {
        const sql = postgres(harness.dbUrl, { max: 1, onnotice: () => {} });
        try {
          const [row] = await sql`
            SELECT metadata FROM audit_logs
            WHERE target_id = ${moved.id} AND action = 'publish_request.approve'`;
          expect(row?.metadata.namePin).toBe("repinned");
          expect(row?.metadata.namePinOverrideReason).toBe("repo migrated, ticket #77");
          // Enough to reconstruct what moved from where to where.
          expect(row?.metadata.namePinFrom).toMatchObject({
            repoFullName: `${owner}/${repo}`,
            sourceRequestId: first.id,
          });
          expect(row?.metadata.namePinTo).toMatchObject({
            repoFullName: newRepo,
            sourceRequestId: moved.id,
          });
          // An approve that only MATCHED the claim records no move at all.
          const [firstRow] = await sql`
            SELECT metadata FROM audit_logs
            WHERE target_id = ${first.id} AND action = 'publish_request.approve'`;
          expect(firstRow?.metadata.namePin).toBe("created");
          expect(firstRow?.metadata.namePinFrom ?? null).toBeNull();
        } finally {
          await sql.end();
        }
      }
    } finally {
      await harness.close();
    }
  });

  // (b) The ownership routes used to resolve a packKey against the COMMITTED catalog artifact only,
  // which never contains a `direct--` key — so every community publish 422'd on /api/ownership, the
  // Trust tab rendered "Unverified source" indistinguishably from a genuinely unverified pack, and
  // the Verify button was permanently disabled. pack_name_claims is the authority instead.
  test("a direct-published pack can be looked up, verified, and re-verified after its source moves", async () => {
    const harness = await createPublishHarness();
    try {
      const admin = await harness.signIn("admin", "admin");
      const maintainer = await harness.signIn("direct-maintainer");
      const request = await harness.publishWithGitHubActionsToken(
        await harness.createPack("badge", "1.0.0"),
      );
      await harness.approve(admin, request.id);
      const packKey = `direct--${owner}--integration-badge`;
      const servedSourceUrl = request.registryEntry!.source;

      // The pack the SPA was served really is resolvable now (this is the (b) regression: 422 today).
      const unverified = await harness.publicClient.json<{
        sourceRepository: { fullName: string } | null;
        verificationStatus: string;
      }>(`/api/ownership?packKey=${encodeURIComponent(packKey)}&sourceUrl=${encodeURIComponent(servedSourceUrl)}`);
      expect(unverified.sourceRepository?.fullName).toBe(`${owner}/${repo}`);
      expect(unverified.verificationStatus).toBe("unverified");

      // (c) The proof row is written by the GitHub App callback at the REPO's tree URL, which is not
      // the commit-pinned `source` the merged catalog serves. The badge lookup used to require exact
      // source_url equality, so it silently reported "unverified" with nobody re-verifying.
      await harness.store.upsertVerifiedPackOwnership(maintainer.userId, {
        packKey,
        sourceUrl: `${repoUrl}/tree/main`,
        githubRepositoryId: "repo_123",
        githubRepositoryFullName: `${owner}/${repo}`,
        githubRepositoryName: repo,
        githubOwnerId: "owner_123",
        githubOwnerLogin: owner,
        githubOwnerType: "Organization",
        verificationMethod: "github_app_user_token",
      });
      const verified = await harness.publicClient.json<{
        verificationStatus: string;
        publisher: { githubOwnerLogin: string } | null;
      }>(`/api/ownership?packKey=${encodeURIComponent(packKey)}&sourceUrl=${encodeURIComponent(servedSourceUrl)}`);
      expect(verified.verificationStatus).toBe("verified");
      expect(verified.publisher?.githubOwnerLogin).toBe(owner);

      // ...and the flow's entry point is reachable too (422 today), redirecting back to the SCOPED
      // pack route derived server-side from the claim, never from a request field.
      const started = await maintainer.json<{ authorizationUrl: string }>("/api/ownership/github/start", {
        method: "POST",
        csrfToken: maintainer.csrfToken,
        body: { packKey, sourceUrl: servedSourceUrl },
      });
      expect(started.authorizationUrl).toContain("state=");

      // The redirect the callback will replay verbatim as its Location. Asserted here because
      // "state= is present" is satisfied by ANY signed state, so it never checked the property the
      // comment above claims: building this from the request's packKey instead of the claim's NAME
      // yields /packs/direct--owner--slug#trust, which the SPA parses as a pack name it cannot
      // resolve, landing the verifier on the not-found panel at the end of a successful GitHub
      // handshake. State format is signValue: base64url(json) "." base64url(hmac).
      const startState = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
      const claimState = JSON.parse(
        Buffer.from(startState.slice(0, startState.lastIndexOf(".")), "base64url").toString("utf8"),
      ) as { redirectTo: string; packKey: string };
      expect(claimState.packKey).toBe(packKey);
      expect(claimState.redirectTo).toBe(`/packs/${owner}/integration-badge#trust`);

      // (c) A row that belongs to a DIFFERENT repository is not this pack's proof. This is the state
      // an audited staff re-pin leaves behind: the name moves to a new repo while the old repo's
      // proof row is still on disk under the same pack_key.
      await harness.store.upsertVerifiedPackOwnership(maintainer.userId, {
        packKey,
        sourceUrl: "https://github.com/attacker/other/tree/main",
        githubRepositoryId: "repo_attacker",
        githubRepositoryFullName: "attacker/other",
        githubRepositoryName: "other",
        githubOwnerId: "owner_attacker",
        githubOwnerLogin: "attacker",
        githubOwnerType: "User",
        verificationMethod: "github_app_user_token",
      });
      const foreignRow = await harness.publicClient.json<{ verificationStatus: string; publisher: unknown }>(
        `/api/ownership?packKey=${encodeURIComponent(packKey)}&sourceUrl=${encodeURIComponent(servedSourceUrl)}`,
      );
      expect(foreignRow.verificationStatus).toBe("unverified");
      expect(foreignRow.publisher ?? null).toBeNull();
    } finally {
      await harness.close();
    }
  });

  // The badge-spoofing defence, which is the whole reason the catalog check stays. pack_ownerships'
  // primary key is pack_key ALONE and its upsert overwrites publisher_id/verified_by_user_id, so a
  // packKey a caller was allowed to assert freely would let anyone with admin on any repo destroy a
  // first-party pack's badge.
  test("an ownership request must name the repository that actually owns the pack", async () => {
    const harness = await createPublishHarness({ basePackSlugs: ["bmad"] });
    try {
      const admin = await harness.signIn("admin", "admin");
      const attacker = await harness.signIn("spoofer");
      const request = await harness.publishWithGitHubActionsToken(
        await harness.createPack("spoof-target", "1.0.0"),
      );
      await harness.approve(admin, request.id);
      const directKey = `direct--${owner}--integration-spoof-target`;

      async function ownershipStatus(packKey: string, sourceUrl: string) {
        const response = await harness.publicClient.request(
          `/api/ownership?packKey=${encodeURIComponent(packKey)}&sourceUrl=${encodeURIComponent(sourceUrl)}`,
        );
        return { status: response.status, body: await response.text() };
      }

      // A direct pack, but a source repo that is not the one its name claim is pinned to.
      const spoofed = await ownershipStatus(directKey, "https://github.com/spoofer/evil/tree/main");
      expect(spoofed.status, spoofed.body).toBe(422);
      // Even a *plausible* URL on the wrong host/shape is refused rather than trusted.
      expect((await ownershipStatus(directKey, "https://gitlab.com/acme/registry-fixtures")).status).toBe(422);
      // A `direct--` key with no name claim behind it at all.
      expect((await ownershipStatus("direct--acme--never-published", `${repoUrl}/tree/main`)).status).toBe(422);
      // A non-canonical key that does NOT survive the flatten round-trip. Without that check this
      // would resolve through the claim for `acme/integration-spoof-target` and write an ownership
      // row under a pack_key the catalog will never ask about.
      expect(
        (await ownershipStatus(`direct--${owner}/integration-spoof-target`, request.registryEntry!.source)).status,
      ).toBe(422);

      // A first-party pack: the generated artifact is the authority, and its exact `source` binds.
      const basePack = baseCatalogPack("bmad");
      expect((await ownershipStatus(basePack.pack_key, basePack.source)).status).toBe(200);
      expect((await ownershipStatus(basePack.pack_key, "https://github.com/spoofer/evil/tree/main")).status).toBe(422);
      // ...and a name claim can never override it. The attacker owns the claim for their own scoped
      // name, but that buys nothing on a `gascity-packs--` key.
      const attackerPack = await harness.publishWithGitHubActionsToken(
        await harness.createPack("bmad-lookalike", "1.0.0", {
          name: "spoofer/bmad",
          repoUrl: "https://github.com/spoofer/bmad",
        }),
      );
      await harness.approve(admin, attackerPack.id);
      expect(
        (await ownershipStatus(basePack.pack_key, "https://github.com/spoofer/bmad/tree/main")).status,
      ).toBe(422);

      // The write path is gated by the same resolver, so no ownership row exists for the spoofed key.
      const started = await attacker.request("/api/ownership/github/start", {
        method: "POST",
        csrfToken: attacker.csrfToken,
        body: { packKey: basePack.pack_key, sourceUrl: "https://github.com/spoofer/evil/tree/main" },
      });
      expect(started.status).toBe(422);
    } finally {
      await harness.close();
    }
  });

  // (b)'s second-order consequence, and the security review of it. Before this change a community
  // claim-only request from a non-org-member with no override died at step 2 with 403
  // OWNERSHIP_NOT_VERIFIED before requestedName, scope or the claim were ever read — so H1b, H2, H4
  // and the aggregate dry run were UNREACHABLE on that traffic shape. Making verified_repo_ownership
  // reachable for community repos moves that traffic into steps 3-7 for the first time.
  test("a community publisher's verified repo ownership clears step 2 but nothing downstream", async () => {
    const harness = await createPublishHarness();
    try {
      const admin = await harness.signIn("admin", "admin");
      const publisher = await harness.signIn("community-pub");
      const victim = await harness.signIn("victim-pub");

      // The publisher proved admin on their own repo through the App flow.
      await harness.store.upsertVerifiedPackOwnership(publisher.userId, {
        packKey: `direct--${owner}--integration-community`,
        sourceUrl: `${repoUrl}/tree/main`,
        githubRepositoryId: "repo_123",
        githubRepositoryFullName: `${owner}/${repo}`,
        githubRepositoryName: repo,
        githubOwnerId: "owner_123",
        githubOwnerLogin: owner,
        githubOwnerType: "Organization",
        verificationMethod: "github_app_user_token",
      });

      // A FOREIGN-scoped name now reaches H1b instead of dying at step 2. Proving admin on a repo
      // buys only that owner's namespace.
      const foreignScope = await harness.publishWithPersonalToken(
        publisher,
        await harness.createPack("community-scope", "1.0.0", { name: "someone-else/community-scope" }),
      );
      expect(foreignScope.submissionMethod).toBe("api_token");
      await harness.approveExpectingError(admin, foreignScope.id, 403, "PUBLISH_SCOPE_MISMATCH");

      // A name already claimed by a different repo now reaches H2, not step 2.
      const claimed = await harness.publishWithGitHubActionsToken(
        await harness.createPack("community-claimed", "1.0.0", {
          name: `${owner}/integration-community-claimed`,
          repoUrl: `https://github.com/${owner}/other-repo`,
        }),
      );
      await harness.approve(admin, claimed.id);
      const takeover = await harness.publishWithPersonalToken(
        publisher,
        await harness.createPack("community-claimed", "1.0.0", {
          name: `${owner}/integration-community-claimed`,
          commit: secondCommit,
        }),
      );
      await harness.approveExpectingError(admin, takeover.id, 409, "PUBLISH_NAME_OWNER_MISMATCH");

      // And the basis is per-user: a different publisher pointing at the same public repo URL still
      // has no proof of anything.
      const borrowed = await harness.publishWithPersonalToken(
        victim,
        await harness.createPack("community-borrowed", "1.0.0"),
      );
      await harness.approveExpectingOwnershipError(admin, borrowed.id);

      // The publisher's OWN scoped name from their proven repo is what the basis is for.
      const legitimate = await harness.publishWithPersonalToken(
        publisher,
        await harness.createPack("community-own", "1.0.0"),
      );
      expect((await harness.approve(admin, legitimate.id)).status).toBe("approved");
    } finally {
      await harness.close();
    }
  });

  // The population the fail-closed rule must NOT catch, and the only test that pins its last
  // conjunct: the submitter proved the very repo the claim is pinned to, then cut the next release
  // over a personal token. Nothing is ambiguous here — the proof and the pin name the same numeric
  // id — so an id-less submission is still measured by the repoFullName fallback and approves with
  // no override. Without this, `claim.githubRepositoryId !== provenRepositoryId` can be stubbed to
  // `true` with the whole suite green, and the refusal silently widens to every claim-only release
  // of an id-pinned pack.
  test("an id-pinned claim still approves an id-less release from the repo that was proven", async () => {
    const harness = await createPublishHarness();
    try {
      const admin = await harness.signIn("admin", "admin");
      const maintainer = await harness.signIn("proven-pin-pub");
      const name = `${owner}/integration-provenpin`;
      const live = repoIdentityFor(`${owner}/${repo}`);

      // Claim pinned to the LIVE ids by a repo-proven release.
      await harness.seedApprovedPublish(
        maintainer.userId,
        admin.userId,
        await harness.createPack("provenpin-v1", "1.0.0", { name }),
        {
          submissionMethod: "github_actions_oidc",
          sourceIdentity: { githubRepositoryId: live.repositoryId, githubOwnerId: live.ownerId },
        },
      );
      expect(await harness.store.getPackNameClaim(name)).toMatchObject({
        githubRepositoryId: live.repositoryId,
      });

      // The maintainer proved that SAME repo through the App flow.
      await harness.store.upsertVerifiedPackOwnership(maintainer.userId, {
        packKey: `direct--${owner}--integration-provenpin`,
        sourceUrl: `${repoUrl}/tree/main`,
        githubRepositoryId: live.repositoryId,
        githubRepositoryFullName: `${owner}/${repo}`,
        githubRepositoryName: repo,
        githubOwnerId: live.ownerId,
        githubOwnerLogin: owner,
        githubOwnerType: "Organization",
        verificationMethod: "github_app_user_token",
      });

      const next = await harness.publishWithPersonalToken(
        maintainer,
        await harness.createPack("provenpin-v2", "1.1.0", { name, commit: secondCommit }),
      );
      expect(next.submissionMethod).toBe("api_token");
      expect(next.sourceGithubRepositoryId ?? null).toBeNull();
      // No ownershipOverrideReason and no namePinOverrideReason: nothing to authorize.
      expect((await harness.approve(admin, next.id)).status).toBe("approved");

      const catalog = await harness.publicClient.json<{ packs: Array<{ name: string; latest: string }> }>(
        "/catalog.json",
      );
      expect(catalog.packs.find((pack) => pack.name === name)?.latest).toBe("1.1.0");
      // The pin did not move, and it did not lose the id it had proven.
      expect(await harness.store.getPackNameClaim(name)).toMatchObject({
        repoFullName: `${owner}/${repo}`,
        githubRepositoryId: live.repositoryId,
      });
    } finally {
      await harness.close();
    }
  });

  // H2's id pin is only as strong as the WEAKEST submission method that can reach it. Ids are
  // compared only when both sides carry them, and only repo-proven methods stamp them on the
  // request — so a release refused over OIDC (ids compared, mismatch) could be resubmitted over a
  // personal token, which stamps nothing, take the case-folded repoFullName fallback, and approve
  // with NO override typed at all. Reachable only because a verified ownership row now clears step 2
  // for community repos; before that, clearing step 2 without an override required a repo-proven
  // method, and those always stamp ids.
  test("an id-pinned claim refuses an id-less resubmission instead of falling back to the name", async () => {
    const harness = await createPublishHarness();
    try {
      const admin = await harness.signIn("admin", "admin");
      const attacker = await harness.signIn("downgrade-pub");
      const name = `${owner}/integration-finalpin`;
      const packKey = `direct--${owner}--integration-finalpin`;

      // The name is pinned to THIS repo's full name but to a STALE numeric id — the shape a repo
      // delete-and-recreate (or an audited re-pin) leaves behind. The full name still matches; the
      // identity does not, and identity is what the pin is written in.
      await harness.seedApprovedPublish(
        attacker.userId,
        admin.userId,
        await harness.createPack("finalpin-v1", "1.0.0", { name }),
        {
          submissionMethod: "github_actions_oidc",
          sourceIdentity: { githubRepositoryId: "repo_OLD", githubOwnerId: "owner_123" },
        },
      );
      const claim = await harness.store.getPackNameClaim(name);
      expect(claim).toMatchObject({ repoFullName: `${owner}/${repo}`, githubRepositoryId: "repo_OLD" });

      // CONTROL: over OIDC the request carries the LIVE id, both sides have ids, and H2 compares
      // them — refused, and staff must type an audited re-pin reason.
      const overOidc = await harness.publishWithGitHubActionsToken(
        await harness.createPack("finalpin-v2", "1.0.0", { name, commit: secondCommit }),
      );
      expect(overOidc.sourceGithubRepositoryId).toBe("repo_123");
      await harness.approveExpectingError(admin, overOidc.id, 409, "PUBLISH_NAME_OWNER_MISMATCH");

      // The newly reachable basis: the attacker proves the LIVE repo through the App flow. This is a
      // real proof of the live repo — it is simply not proof of the repo the name is pinned to.
      const started = await attacker.json<{ authorizationUrl: string }>("/api/ownership/github/start", {
        method: "POST",
        csrfToken: attacker.csrfToken,
        body: { packKey, sourceUrl: `${repoUrl}/tree/main` },
      });
      expect(started.authorizationUrl).toContain("state=");
      await harness.store.upsertVerifiedPackOwnership(attacker.userId, {
        packKey,
        sourceUrl: `${repoUrl}/tree/main`,
        githubRepositoryId: "repo_123",
        githubRepositoryFullName: `${owner}/${repo}`,
        githubRepositoryName: repo,
        githubOwnerId: "owner_123",
        githubOwnerLogin: owner,
        githubOwnerType: "Organization",
        verificationMethod: "github_app_user_token",
      });

      // THE ATTACK: the same name from the same repo, downgraded to a personal token so it stamps no
      // ids. The ownership row clears step 2, and H2 must NOT now soften to a name compare just
      // because the request declined to carry the currency the pin is written in. (A fresh version:
      // the attacker's own approved 1.0.0 is already served, and resubmitting THAT is a different
      // refusal.)
      const downgraded = await harness.publishWithPersonalToken(
        attacker,
        await harness.createPack("finalpin-v3", "1.1.0", { name, commit: secondCommit }),
      );
      expect(downgraded.submissionMethod).toBe("api_token");
      expect(downgraded.sourceGithubRepositoryId ?? null).toBeNull();
      expect(downgraded.repository.fullName.toLowerCase()).toBe(claim!.repoFullName.toLowerCase());
      await harness.approveExpectingError(admin, downgraded.id, 409, "PUBLISH_NAME_OWNER_MISMATCH");

      // The pin held: nothing new was served and the claim still points at the stale id, so the
      // decision is still in front of a human.
      const catalog = await harness.publicClient.json<{
        packs: Array<{ name: string; latest: string }>;
      }>("/catalog.json");
      expect(catalog.packs.find((pack) => pack.name === name)?.latest).toBe("1.0.0");
      expect(await harness.store.getPackNameClaim(name)).toMatchObject({
        githubRepositoryId: "repo_OLD",
      });

      // And the legitimate escape hatch is unchanged: an audited re-pin approves and MOVES the pin,
      // which is the same decision the OIDC path already forced.
      const approved = await harness.approve(
        admin,
        downgraded.id,
        undefined,
        "Repo recreated upstream; re-pinning acme/integration-finalpin after out-of-band check.",
      );
      expect(approved.status).toBe("approved");
      const repinned = await harness.store.getPackNameClaim(name);
      expect(repinned?.repoFullName).toBe(`${owner}/${repo}`);
      // The re-pin records what was actually PROVEN, which for an id-less submission is no id: the
      // claim drops to the weaker name-only pin rather than inheriting the stale one. A later
      // repo-proven release re-teaches the live id through the enrichment path.
      expect(repinned?.githubRepositoryId).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  // The SCOPE of the fail-closed rule, pinned so widening it cannot pass silently. It applies only
  // to the verified_repo_ownership basis — the one this change newly made reachable for community
  // repos. org_member is a pre-existing basis on an unchanged code path, so it keeps taking the
  // repoFullName fallback and this change tightens nothing for it.
  //
  // RESIDUAL, deliberately not closed here: that means a verified org member can still satisfy an
  // id-pinned claim by full name alone with nothing typed. It is exactly as true before this change
  // as after, and the population is @gascity org members rather than open self-registration, so
  // closing it is a separate decision about internal publishing — not a regression to fix in this
  // commit. If it is ever closed, this test is the one that should change.
  test("the fail-closed name-pin rule does not tighten the pre-existing org_member basis", async () => {
    const harness = await createPublishHarness();
    try {
      const admin = await harness.signIn("admin", "admin");
      const member = await harness.signIn("orgpin-member", undefined, { orgMember: true });
      const name = `${owner}/integration-orgpin`;

      // Same setup as the downgrade attack: claim pinned to a STALE numeric id.
      await harness.seedApprovedPublish(
        member.userId,
        admin.userId,
        await harness.createPack("orgpin-v1", "1.0.0", { name }),
        {
          submissionMethod: "github_actions_oidc",
          sourceIdentity: { githubRepositoryId: "repo_OLD", githubOwnerId: "owner_123" },
        },
      );
      expect(await harness.store.getPackNameClaim(name)).toMatchObject({
        githubRepositoryId: "repo_OLD",
      });

      // No pack_ownerships row anywhere, so the basis is org_member, not verified_repo_ownership.
      const next = await harness.publishWithPersonalToken(
        member,
        await harness.createPack("orgpin-v2", "1.1.0", { name, commit: secondCommit }),
      );
      expect(next.sourceGithubRepositoryId ?? null).toBeNull();
      expect((await harness.approve(admin, next.id)).status).toBe("approved");
    } finally {
      await harness.close();
    }
  });

  // (d) Supersede must not become a laundering path for bits a staff takedown removed.
  test("a superseded request approves cleanly, but a withdrawn version still cannot be re-published", async () => {
    const harness = await createPublishHarness();
    try {
      const admin = await harness.signIn("admin", "admin");
      const publisher = await harness.signIn("supersede-pub");

      // Correcting a pending submission: the replacement approves with no PUBLISH_VERSION_WITHDRAWN,
      // because supersede writes `rejected`, never `withdrawn`. As a withdrawn row it would feed
      // H4's same-submitter lineage filter and 409 the submitter's own correction — a self-DoS that
      // burns the version permanently.
      // Repo-proven so the merge gate itself has nothing to say — the only thing that can refuse the
      // superseded row is its own status.
      const pack = await harness.createPack("supersede", "1.0.0");
      const first = await harness.publishWithGitHubActionsToken(pack);
      expect(first.status).toBe("pending_review");
      const corrected = await harness.publishWithGitHubActionsToken({ ...pack, commit: secondCommit });
      expect(corrected.id).not.toBe(first.id);

      const closed = await harness.store.getPublishRequest(first.id);
      expect(closed?.status).toBe("rejected");
      expect(closed?.statusReason).toContain(corrected.id);
      // Staff can no longer approve the bits they were reading: the superseded row fails the
      // status = 'pending_review' guard, so a review TOCTOU is closed rather than resolved by luck.
      await harness.approveExpectingError(admin, first.id, 422, "VALIDATION_ERROR");
      expect((await harness.approve(admin, corrected.id)).status).toBe("approved");

      // A genuinely WITHDRAWN version is still refused at approve, and superseding cannot dissolve
      // that: the withdrawn row is outside the dedup set, so it is never a supersede target.
      const takedown = await harness.createPack("laundry", "1.0.0");
      const served = await harness.publishWithGitHubActionsToken(takedown);
      await harness.approve(admin, served.id);
      await harness.withdraw(admin, served.id, "malware");
      const relapse = await harness.publishWithGitHubActionsToken({ ...takedown, commit: secondCommit });
      expect(relapse.id).not.toBe(served.id);
      await harness.approveExpectingError(admin, relapse.id, 409, "PUBLISH_VERSION_WITHDRAWN");
      expect((await harness.store.getPublishRequest(served.id))?.status).toBe("withdrawn");
    } finally {
      await harness.close();
    }
  });
});

type TestPack = PublishRequestInput & {
  slug: string;
};

type SignedInClient = TestHttpClient & {
  csrfToken: string;
  userId: string;
};

// A first-party, ingest-generated pack as it appears in the committed catalog artifact: keyed
// `gascity-packs--<slug>`, sourced from the monorepo. No publisher can write one, which is why it is
// the authority the ownership routes measure base pack_keys against.
function baseCatalogPack(slug: string) {
  return {
    pack_key: `gascity-packs--${slug}`,
    registry: "gascity-packs",
    name: slug,
    description: `First-party ${slug} pack.`,
    source: `https://github.com/gastownhall/gascity-packs/tree/main/${slug}`,
    source_kind: "git",
    og_image: "/og/registry.svg",
    latest: "1.0.0",
    releases: [
      {
        version: "1.0.0",
        ref: "refs/heads/main",
        commit: "e".repeat(40),
        hash: `sha256:${"f".repeat(64)}`,
        description: `First-party ${slug} release.`,
      },
    ],
  };
}

async function createPublishHarness(options: { basePackSlugs?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "registry-publish-integration-"));
  const distRoot = join(dir, "dist");
  const repoRoot = join(dir, "repo");
  await mkdir(distRoot, { recursive: true });
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(distRoot, "index.html"), "<!doctype html><title>Registry integration shell</title>");
  await writeFile(join(distRoot, "registry.toml"), "schema = 1\n");
  const basePacks = (options.basePackSlugs ?? []).map(baseCatalogPack);
  await writeFile(
    join(distRoot, "catalog.json"),
    `${JSON.stringify({
      schema: 1,
      source_count: basePacks.length > 0 ? 1 : 0,
      pack_count: basePacks.length,
      sources: basePacks.length > 0 ? [{ name: "gascity-packs", url: "https://github.com/gastownhall/gascity-packs", pack_count: basePacks.length }] : [],
      packs: basePacks,
    })}\n`,
  );

  // With REGISTRY_TEST_DATABASE_URL set (CI), run the whole publish flow against a fresh
  // real Postgres database; unset (local default) keeps the fast file store.
  const testDb = process.env.REGISTRY_TEST_DATABASE_URL
    ? await createTestDatabase(process.env.REGISTRY_TEST_DATABASE_URL)
    : null;
  const store = createStore(testDb?.url, join(dir, "registry.local.json"));
  await store.init();
  if (testDb && store.kind !== "postgres") {
    throw new Error("publish-integration: expected the postgres store when REGISTRY_TEST_DATABASE_URL is set.");
  }

  const config = testConfig();
  let importCandidate: GitHubPublishCandidate | null = null;
  // The repo + commit the next minted GitHub Actions token proves. publishWithGitHubActionsToken
  // points this at whatever repo the pack claims, so a test can hold a repo-proven token for a
  // repo OTHER than the one that owns the name it is attacking.
  let oidcSource = { repository: `${owner}/${repo}`, sha: commit };
  const handler = createRegistryFetchHandler({
    config,
    store,
    distRoot: pathToFileURL(`${distRoot}/`),
    validatePublishRequest: (request, currentConfig) =>
      validatePublishRequestForRegistry(request, currentConfig, {
        fetchFn: localRawGitHubFetch(repoRoot),
        computeHash: async (publishRequest) => packHash(publishRequest),
      }),
    verifyGitHubActionsOidcToken: async () => {
      const [identityOwner = owner] = oidcSource.repository.split("/");
      const ids = repoIdentityFor(oidcSource.repository);
      return {
        repository: oidcSource.repository,
        repositoryId: ids.repositoryId,
        repositoryOwner: identityOwner,
        repositoryOwnerId: ids.ownerId,
        workflowRef: `${oidcSource.repository}/.github/workflows/release.yml@refs/heads/main`,
        runId: "1",
        runAttempt: "1",
        sha: oidcSource.sha,
        actor: "publisher",
        actorId: "actor_123",
        eventName: "push",
      } satisfies GitHubActionsIdentity;
    },
    verifyRegistryEiaToken: async (token) => {
      if (!token.startsWith("test-eia:")) throw new Error("invalid test EIA");
      return {
        subject: token.slice("test-eia:".length),
        jti: `jti-${token.length}`,
        scopes: ["registry:publish"],
      };
    },
    exchangeGitHubCode: async () => "github-user-token",
    discoverGitHubPublishCandidates: async () =>
      ({
        repositoriesScanned: 1,
        privateRepositoriesSkipped: 0,
        candidates: importCandidate ? [importCandidate] : [],
        scanErrors: [],
        truncated: false,
        expiresAt: new Date(Date.now() + 60_000),
      }) satisfies GitHubPublishImportCreateInput,
  });
  const server = Bun.serve({ port: 0, fetch: handler });
  const port = server.port;
  if (!port) throw new Error("Expected Bun.serve to allocate a local test port.");
  config.port = port;
  config.appUrl = `http://127.0.0.1:${port}`;
  const publicClient = new TestHttpClient(config.appUrl);

  // Direct publishes are SCOPED `owner/pack`, where owner is the GitHub owner of the source repo
  // (`acme` here). `name` overrides that for the namespace-gate cases that deliberately request a
  // bare or foreign-scoped name.
  async function createPack(
    slug: string,
    version: string,
    over: { name?: string; repoUrl?: string; commit?: string } = {},
  ): Promise<TestPack> {
    const packPath = `packs/${slug}`;
    const packDir = join(repoRoot, packPath);
    const requestedName = over.name ?? `${owner}/integration-${slug}`;
    await mkdir(packDir, { recursive: true });
    await writeFile(
      join(packDir, "pack.toml"),
      `[pack]\nname = "${requestedName}"\nversion = "${version}"\ndescription = "Integration ${slug} pack."\n`,
    );
    await writeFile(
      join(packDir, "README.md"),
      `# ${requestedName}\n\nLocal integration pack uploaded through ${slug}.\n`,
    );
    return {
      slug,
      repoUrl: over.repoUrl ?? repoUrl,
      commit: over.commit ?? commit,
      packPath,
      requestedName,
      requestedVersion: version,
      requestedRef: "refs/heads/main",
      requestedDescription: `Release ${requestedName} ${version}.`,
    };
  }

  // Writes an approved publish (and therefore its name claim) straight through the store, which
  // is exactly what the server did before this gate existed. Tests use it to stand up the
  // pre-gate world — notably a grandfathered BARE-named pack — without pretending the gate would
  // mint one today. In production those claims come from slice 2's init() backfill; the gate reads
  // the same row either way.
  async function seedApprovedPublish(
    submitterUserId: string,
    adminUserId: string,
    pack: TestPack,
    over: { submissionMethod?: PublishSubmissionMethod; sourceIdentity?: PublishSourceIdentity } = {},
  ) {
    const created = await store.createPublishRequest(
      submitterUserId,
      pack,
      over.submissionMethod ?? "web_session",
      over.sourceIdentity,
    );
    const validated = await store.markPublishRequestValidated(created.id, {
      name: created.requestedName,
      description: pack.requestedDescription ?? `${created.requestedName} pack.`,
      source: created.sourceUrl,
      sourceKind: "git",
      release: {
        version: created.requestedVersion,
        ref: created.requestedRef ?? created.commit,
        commit: created.commit,
        hash: packHash(created),
        description: `Publish ${created.requestedName} ${created.requestedVersion}.`,
      },
    });
    return store.approvePublishRequest(adminUserId, validated.id);
  }

  async function signIn(
    handle: string,
    role?: "admin" | "moderator" | "user",
    opts: { orgMember?: boolean } = {},
  ): Promise<SignedInClient> {
    const client = new TestHttpClient(config.appUrl);
    const roleParam = role ? `&role=${role}` : "";
    const orgParam = opts.orgMember ? "&orgMember=1" : "";
    const response = await client.request(
      `/api/dev/sign-in?handle=${encodeURIComponent(handle)}${roleParam}${orgParam}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    const me = await client.json<{ csrfToken: string; user: { id: string; handle: string } }>("/api/me");
    expect(me.user.handle).toBe(handle);
    return Object.assign(client, { csrfToken: me.csrfToken, userId: me.user.id });
  }

  async function publishWithSession(client: SignedInClient, pack: TestPack) {
    return publishRequestFromResponse(
      await client.json<{ publishRequest: PublishRequestRow }>("/api/publish-requests?validate=1", {
        method: "POST",
        csrfToken: client.csrfToken,
        body: pack,
      }),
    );
  }

  async function publishWithPersonalToken(client: SignedInClient, pack: TestPack) {
    const created = await client.json<{ token: { token: string } }>("/api/account/api-tokens", {
      method: "POST",
      csrfToken: client.csrfToken,
      body: { label: `publish ${pack.slug}` },
    });
    return publishWithBearerToken(created.token.token, pack);
  }

  async function publishWithCliBrowserToken(client: SignedInClient, pack: TestPack) {
    const created = await client.json<{ token: { token: string } }>("/api/cli/auth/token", {
      method: "POST",
      csrfToken: client.csrfToken,
      body: {
        label: `cli browser ${pack.slug}`,
        redirectUri: "http://127.0.0.1:9876/callback",
        state: `state-${pack.slug}`,
      },
    });
    return publishWithBearerToken(created.token.token, pack);
  }

  async function publishWithCliDeviceToken(client: SignedInClient, pack: TestPack) {
    const deviceClient = new TestHttpClient(config.appUrl);
    const code = await deviceClient.json<{ device_code: string; user_code: string }>("/api/cli/device/code", {
      method: "POST",
      body: { label: `cli device ${pack.slug}` },
    });
    const approve = await client.json<{ status: "approved" }>("/api/cli/device/approve", {
      method: "POST",
      csrfToken: client.csrfToken,
      body: { user_code: code.user_code },
    });
    expect(approve.status).toBe("approved");
    const token = await deviceClient.json<{ access_token: string }>("/api/cli/device/token", {
      method: "POST",
      body: { device_code: code.device_code },
    });
    return publishWithBearerToken(token.access_token, pack);
  }

  async function publishWithGitHubActionsToken(pack: TestPack) {
    // The token proves the pack's OWN repo — that is what a real workflow running in that repo
    // gets. A test attacks a foreign name by pointing the pack at its own hostile repo, never by
    // holding a token for one repo and asserting another (the mint path already refuses that).
    oidcSource = { repository: new URL(pack.repoUrl).pathname.slice(1), sha: pack.commit };
    const runner = nextMachineClient();
    const minted = await runner.json<{ access_token: string }>("/api/publish-tokens/github-actions/mint", {
      method: "POST",
      body: { ...pack, oidcToken: "test-oidc-token" },
    });
    return publishWithBearerToken(minted.access_token, pack, runner);
  }

  async function publishWithEiaToken(pack: TestPack) {
    return publishWithBearerToken(`test-eia:usr_${pack.slug}`, pack);
  }

  async function publishWithGitHubImport(client: SignedInClient, pack: TestPack) {
    importCandidate = githubCandidateFor(pack);
    const started = await client.json<{ authorizationUrl: string }>("/api/publish/github/start", {
      method: "POST",
      csrfToken: client.csrfToken,
      body: {},
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    const callback = await client.request(
      `/api/ownership/github/callback?code=fake-code&state=${encodeURIComponent(state!)}`,
      { redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    const redirectTo = callback.headers.get("location") ?? "";
    const importId = new URL(redirectTo, config.appUrl).searchParams.get("githubImport");
    expect(importId).toBeTruthy();
    const imported = await client.json<{ import: { candidates: GitHubPublishCandidate[] } }>(
      `/api/publish/github/imports/${encodeURIComponent(importId!)}`,
      { csrfToken: client.csrfToken },
    );
    expect(imported.import.candidates).toHaveLength(1);
    return publishRequestFromResponse(
      await client.json<{ publishRequest: PublishRequestRow }>(
        `/api/publish/github/imports/${encodeURIComponent(importId!)}/submit`,
        {
          method: "POST",
          csrfToken: client.csrfToken,
          body: {
            candidateId: imported.import.candidates[0].id,
            requestedVersion: pack.requestedVersion,
            requestedRef: pack.requestedRef,
            requestedDescription: pack.requestedDescription,
          },
        },
      ),
    );
  }

  // A bearer publish carries no session, so the create rate limit keys on the client address.
  // Real publishes arrive from many machines (one CI runner or laptop per publisher); funnelling
  // the whole suite through one address would let the number of tests, rather than the code under
  // test, decide whether a test passes.
  function nextMachineClient() {
    machineCount += 1;
    return new TestHttpClient(config.appUrl, `10.0.${Math.floor(machineCount / 256)}.${machineCount % 256}`);
  }

  async function publishWithBearerToken(token: string, pack: TestPack, client = nextMachineClient()) {
    return publishRequestFromResponse(
      await client.json<{ publishRequest: PublishRequestRow }>("/api/publish-requests?validate=1", {
        method: "POST",
        bearerToken: token,
        body: pack,
      }),
    );
  }

  // A submit that must be REFUSED before any row exists, so a test can pin the status and code of
  // an input the mint grammar rejects. Same path as publishWithPersonalToken; it just does not
  // assert 2xx.
  async function publishExpectingError(
    client: SignedInClient,
    pack: TestPack,
    status: number,
    code: string,
  ) {
    const created = await client.json<{ token: { token: string } }>("/api/account/api-tokens", {
      method: "POST",
      csrfToken: client.csrfToken,
      body: { label: `publish ${pack.slug}` },
    });
    const response = await nextMachineClient().request("/api/publish-requests?validate=1", {
      method: "POST",
      bearerToken: created.token.token,
      body: pack,
    });
    const text = await response.text();
    expect(response.status, text).toBe(status);
    const { error } = JSON.parse(text) as { error: { code: string; message: string } };
    expect(error.code).toBe(code);
    return error;
  }

  async function approve(
    client: SignedInClient,
    requestId: string,
    ownershipOverrideReason?: string,
    namePinOverrideReason?: string,
  ) {
    const approved = await client.json<{ publishRequest: PublishRequestRow }>(
      `/api/publish-requests/${encodeURIComponent(requestId)}/approve`,
      {
        method: "POST",
        csrfToken: client.csrfToken,
        body: {
          ...(ownershipOverrideReason ? { ownershipOverrideReason } : {}),
          ...(namePinOverrideReason ? { namePinOverrideReason } : {}),
        },
      },
    );
    expect(approved.publishRequest.status).toBe("approved");
    return approved.publishRequest;
  }

  async function approveExpectingOwnershipError(client: SignedInClient, requestId: string) {
    await approveExpectingError(client, requestId, 403, "OWNERSHIP_NOT_VERIFIED");
  }

  // Drives approve and asserts the exact refusal. Asserting the CODE (not just a 4xx) is what
  // makes the namespace tests meaningful: each one has to fail at its own gate, not at a
  // neighbouring one that happens to also say no.
  async function approveExpectingError(
    client: SignedInClient,
    requestId: string,
    status: number,
    code: string,
    body: Record<string, unknown> = {},
  ) {
    const response = await client.request(
      `/api/publish-requests/${encodeURIComponent(requestId)}/approve`,
      { method: "POST", csrfToken: client.csrfToken, body },
    );
    const text = await response.text();
    expect(response.status, text).toBe(status);
    const payload = JSON.parse(text) as { error: { code: string; message: string } };
    expect(payload.error.code, text).toBe(code);
    return payload.error;
  }

  async function withdraw(
    client: SignedInClient,
    requestId: string,
    reason?: string,
    options: { releaseNameClaim?: boolean } = {},
  ) {
    const res = await client.json<{ publishRequest: PublishRequestRow }>(
      `/api/publish-requests/${encodeURIComponent(requestId)}/withdraw`,
      {
        method: "POST",
        csrfToken: client.csrfToken,
        body: { ...(reason ? { reason } : {}), ...options },
      },
    );
    expect(res.publishRequest.status).toBe("withdrawn");
    return res.publishRequest;
  }

  return {
    store,
    dbUrl: testDb?.url,
    publicClient,
    createPack,
    seedApprovedPublish,
    signIn,
    publishWithSession,
    publishWithPersonalToken,
    publishWithCliBrowserToken,
    publishWithCliDeviceToken,
    publishWithGitHubActionsToken,
    publishWithEiaToken,
    publishWithGitHubImport,
    publishExpectingError,
    approve,
    approveExpectingOwnershipError,
    approveExpectingError,
    withdraw,
    async close() {
      server.stop(true);
      await store.close();
      await testDb?.drop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function testConfig(): ServerConfig {
  return {
    port: 0,
    appUrl: "http://127.0.0.1:0",
    mountBase: "",
    sessionSecret: "integration-test-session-secret-value",
    localDataPath: ".registry-data/integration-test.json",
    eia: {
      issuer: "https://edge.gascity.internal",
      audience: "registry",
      jwksUrl: "https://works.gascity.com/sts/v0/jwks/registry",
    },
    githubApp: {
      appSlug: "test-registry-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    },
    publishValidation: {
      gcBin: "gc",
      timeoutMs: 1_000,
    },
    isProduction: false,
    devAuthEnabled: true,
  };
}

// Serves the fixture tree for ANY owner/repo/commit. That is not laziness: a fork exposes
// byte-identical public content, so validation can never be an ownership check — which is exactly
// why the namespace gate has to be. Tests that need a hostile repo just point at one.
function localRawGitHubFetch(repoRoot: string) {
  return async (input: string | URL | Request) => {
    const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsed = new URL(rawUrl);
    if (parsed.hostname !== "raw.githubusercontent.com") return new Response("not found", { status: 404 });
    const [rawOwner, rawRepo, rawCommit, ...pathParts] = parsed.pathname.split("/").filter(Boolean);
    if (!rawOwner || !rawRepo || !/^[0-9a-f]{40}$/.test(rawCommit ?? "")) {
      return new Response("not found", { status: 404 });
    }
    const file = Bun.file(join(repoRoot, ...pathParts));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  };
}

// GitHub's numeric ids for a fixture repo. Stable per repo (and per owner) so the OIDC and import
// paths agree about the same repo — a fixture that stamped two different repository ids for one
// repo would make the claim-pin comparison fail for reasons the production code never would.
function repoIdentityFor(fullName: string) {
  if (fullName === `${owner}/${repo}`) return { repositoryId: "repo_123", ownerId: "owner_123" };
  const [repoOwner = "", repoName = ""] = fullName.split("/");
  // A repo TRANSFER keeps GitHub's numeric repository id while the repo moves to a different
  // account. Every `*/transferred-pack` therefore shares one repository id here, which is the only
  // way to exercise the claim pin's owner-login check — the id alone would say "same repo".
  if (repoName === "transferred-pack") {
    return { repositoryId: "repo_transferred", ownerId: `owner_${repoOwner}` };
  }
  // A repo RENAME keeps the numeric repository id while the full name changes. Every
  // `{owner}/renamed-*` shares one repository id per owner, which is the only way to make the
  // ids-first comparisons disagree with the repo-full-name fallback in the direction that matters
  // (same repo, different name) — without it, every fixture pair that shares an id also shares a
  // full name and the fallback silently answers identically.
  if (repoName.startsWith("renamed-")) {
    return { repositoryId: `repo_${repoOwner}_renamed`, ownerId: `owner_${repoOwner}` };
  }
  return { repositoryId: `repo_${repoOwner}_${repoName}`, ownerId: `owner_${repoOwner}` };
}

// The same ids in the shape a repo-proven publish request stores them.
function sourceIdentityFor(fullName: string): PublishSourceIdentity {
  const ids = repoIdentityFor(fullName);
  return { githubRepositoryId: ids.repositoryId, githubOwnerId: ids.ownerId };
}

function packHash(request: Pick<PublishRequestRow, "requestedName" | "requestedVersion" | "commit" | "packPath">) {
  return `sha256:${createHash("sha256")
    .update(`${request.requestedName}:${request.requestedVersion}:${request.commit}:${request.packPath}`)
    .digest("hex")}`;
}

function githubCandidateFor(pack: TestPack): GitHubPublishCandidate {
  const fullName = new URL(pack.repoUrl).pathname.slice(1);
  const [candidateOwner = owner, candidateRepo = repo] = fullName.split("/");
  return {
    id: `candidate-${pack.slug}`,
    repository: {
      id: repoIdentityFor(fullName).repositoryId,
      // Both ids, matching what discoverGitHubPublishCandidates actually returns from the
      // installation listing. This fixture used to omit ownerId, so every github_import test
      // silently exercised the DEGRADED path (repo id present, owner id NULL) and the owner-id
      // stamp had no coverage at all.
      ownerId: repoIdentityFor(fullName).ownerId,
      fullName,
      owner: candidateOwner,
      name: candidateRepo,
      htmlUrl: pack.repoUrl,
      defaultBranch: "main",
      permission: "push",
    },
    branch: "main",
    commit: pack.commit,
    packPath: pack.packPath ?? ".",
    packTomlPath: `${pack.packPath}/pack.toml`,
    pack: {
      name: pack.requestedName,
      version: pack.requestedVersion,
      description: pack.requestedDescription,
    },
    warnings: [],
  };
}

function publishRequestFromResponse(response: { publishRequest: PublishRequestRow }) {
  return response.publishRequest;
}

class TestHttpClient {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly clientIp?: string,
  ) {}

  async text(path: string, init: TestRequestInit = {}) {
    const response = await this.request(path, init);
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    return await response.text();
  }

  async json<T>(path: string, init: TestRequestInit = {}) {
    const response = await this.request(path, init);
    const text = await response.text();
    expect(response.status, text).toBeGreaterThanOrEqual(200);
    expect(response.status, text).toBeLessThan(300);
    return JSON.parse(text) as T;
  }

  async request(path: string, init: TestRequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (init.csrfToken) headers.set("X-CSRF-Token", init.csrfToken);
    if (init.bearerToken) headers.set("Authorization", `Bearer ${init.bearerToken}`);
    if (this.clientIp) headers.set("X-Real-Ip", this.clientIp);
    if (this.cookies.size > 0) {
      headers.set(
        "Cookie",
        [...this.cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "),
      );
    }
    if ((init.method ?? "GET") !== "GET") headers.set("Origin", this.baseUrl);

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: init.redirect ?? "follow",
    });
    this.storeCookies(response.headers);
    return response;
  }

  private storeCookies(headers: Headers) {
    const cookieHeaders = getSetCookie(headers);
    for (const cookie of cookieHeaders) {
      const [pair] = cookie.split(";");
      const [name, rawValue] = pair.split("=");
      if (!name) continue;
      const value = decodeURIComponent(rawValue ?? "");
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }
}

type TestRequestInit = Omit<RequestInit, "body"> & {
  body?: unknown;
  csrfToken?: string;
  bearerToken?: string;
};

function getSetCookie(headers: Headers) {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (withGetSetCookie.getSetCookie) return withGetSetCookie.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}
