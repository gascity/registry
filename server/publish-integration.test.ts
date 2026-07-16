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
const repoUrl = `https://github.com/${owner}/${repo}`;

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
});

type TestPack = PublishRequestInput & {
  slug: string;
};

type SignedInClient = TestHttpClient & {
  csrfToken: string;
  userId: string;
};

async function createPublishHarness() {
  const dir = await mkdtemp(join(tmpdir(), "registry-publish-integration-"));
  const distRoot = join(dir, "dist");
  const repoRoot = join(dir, "repo");
  await mkdir(distRoot, { recursive: true });
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(distRoot, "index.html"), "<!doctype html><title>Registry integration shell</title>");
  await writeFile(join(distRoot, "registry.toml"), "schema = 1\n");
  await writeFile(
    join(distRoot, "catalog.json"),
    `${JSON.stringify({ schema: 1, source_count: 0, pack_count: 0, sources: [], packs: [] })}\n`,
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
  const handler = createRegistryFetchHandler({
    config,
    store,
    distRoot: pathToFileURL(`${distRoot}/`),
    validatePublishRequest: (request, currentConfig) =>
      validatePublishRequestForRegistry(request, currentConfig, {
        fetchFn: localRawGitHubFetch(repoRoot),
        computeHash: async (publishRequest) => packHash(publishRequest),
      }),
    verifyGitHubActionsOidcToken: async () =>
      ({
        repository: `${owner}/${repo}`,
        repositoryId: "repo_123",
        repositoryOwner: owner,
        repositoryOwnerId: "owner_123",
        workflowRef: `${owner}/${repo}/.github/workflows/release.yml@refs/heads/main`,
        runId: "1",
        runAttempt: "1",
        sha: commit,
        actor: "publisher",
        actorId: "actor_123",
        eventName: "push",
      }) satisfies GitHubActionsIdentity,
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

  async function createPack(slug: string, version: string): Promise<TestPack> {
    const packPath = `packs/${slug}`;
    const packDir = join(repoRoot, packPath);
    const requestedName = `integration-${slug}`;
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
      repoUrl,
      commit,
      packPath,
      requestedName,
      requestedVersion: version,
      requestedRef: "refs/heads/main",
      requestedDescription: `Release ${requestedName} ${version}.`,
    };
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
    const minted = await publicClient.json<{ access_token: string }>("/api/publish-tokens/github-actions/mint", {
      method: "POST",
      body: { ...pack, oidcToken: "test-oidc-token" },
    });
    return publishWithBearerToken(minted.access_token, pack);
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

  async function publishWithBearerToken(token: string, pack: TestPack) {
    return publishRequestFromResponse(
      await publicClient.json<{ publishRequest: PublishRequestRow }>("/api/publish-requests?validate=1", {
        method: "POST",
        bearerToken: token,
        body: pack,
      }),
    );
  }

  async function approve(client: SignedInClient, requestId: string, ownershipOverrideReason?: string) {
    const approved = await client.json<{ publishRequest: PublishRequestRow }>(
      `/api/publish-requests/${encodeURIComponent(requestId)}/approve`,
      {
        method: "POST",
        csrfToken: client.csrfToken,
        body: ownershipOverrideReason ? { ownershipOverrideReason } : {},
      },
    );
    expect(approved.publishRequest.status).toBe("approved");
    return approved.publishRequest;
  }

  async function approveExpectingOwnershipError(client: SignedInClient, requestId: string) {
    const response = await client.request(
      `/api/publish-requests/${encodeURIComponent(requestId)}/approve`,
      { method: "POST", csrfToken: client.csrfToken, body: {} },
    );
    const text = await response.text();
    expect(response.status, text).toBe(403);
    const payload = JSON.parse(text) as { error: { code: string } };
    expect(payload.error.code).toBe("OWNERSHIP_NOT_VERIFIED");
  }

  async function withdraw(client: SignedInClient, requestId: string, reason?: string) {
    const res = await client.json<{ publishRequest: PublishRequestRow }>(
      `/api/publish-requests/${encodeURIComponent(requestId)}/withdraw`,
      { method: "POST", csrfToken: client.csrfToken, body: reason ? { reason } : {} },
    );
    expect(res.publishRequest.status).toBe("withdrawn");
    return res.publishRequest;
  }

  return {
    store,
    dbUrl: testDb?.url,
    publicClient,
    createPack,
    signIn,
    publishWithSession,
    publishWithPersonalToken,
    publishWithCliBrowserToken,
    publishWithCliDeviceToken,
    publishWithGitHubActionsToken,
    publishWithEiaToken,
    publishWithGitHubImport,
    approve,
    approveExpectingOwnershipError,
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

function localRawGitHubFetch(repoRoot: string) {
  return async (input: string | URL | Request) => {
    const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsed = new URL(rawUrl);
    if (parsed.hostname !== "raw.githubusercontent.com") return new Response("not found", { status: 404 });
    const [rawOwner, rawRepo, rawCommit, ...pathParts] = parsed.pathname.split("/").filter(Boolean);
    if (rawOwner !== owner || rawRepo !== repo || rawCommit !== commit) {
      return new Response("not found", { status: 404 });
    }
    const file = Bun.file(join(repoRoot, ...pathParts));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  };
}

function packHash(request: Pick<PublishRequestRow, "requestedName" | "requestedVersion" | "commit" | "packPath">) {
  return `sha256:${createHash("sha256")
    .update(`${request.requestedName}:${request.requestedVersion}:${request.commit}:${request.packPath}`)
    .digest("hex")}`;
}

function githubCandidateFor(pack: TestPack): GitHubPublishCandidate {
  return {
    id: `candidate-${pack.slug}`,
    repository: {
      id: "repo_123",
      fullName: `${owner}/${repo}`,
      owner,
      name: repo,
      htmlUrl: repoUrl,
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

  constructor(private readonly baseUrl: string) {}

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
