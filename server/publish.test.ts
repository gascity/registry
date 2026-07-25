import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  renderCatalogJsonWithApprovedPublishes,
  renderRegistryTomlWithApprovedPublishes,
} from "./aggregate";
import {
  normalizePackPath,
  normalizePublishRequestInput,
  packNameScope,
  packNameSegments,
  packRoutePath,
  parseGitHubRepositoryUrl,
  PublishRequestValidationError,
} from "./publish";
import { computePackHash, validatePublishRequestForRegistry } from "./publish-validation";
import { createStore } from "./store";
import type { ServerConfig } from "./config";

const commit = "0123456789abcdef0123456789abcdef01234567";
const hash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Pins the server's copy of the pack-name/URL helpers to the SPA's. These expectations are
// byte-identical to the ones in src/lib/urlState.test.ts and src/lib/packName.test.ts — the two
// copies exist because tsconfig.app.json (src) and tsconfig.server.json (server) are separate
// composite projects that cannot import from each other, so this table is the only thing holding
// them together. Change one side and this test (or its twin) fails.
describe("pack name URL helpers (pinned to src/lib)", () => {
  test("packRoutePath emits one real path segment per name segment", () => {
    expect(packRoutePath("gascity")).toBe("/packs/gascity");
    expect(packRoutePath("cacc-twin-team")).toBe("/packs/cacc-twin-team");
    expect(packRoutePath("wespd/cacc-twin-team")).toBe("/packs/wespd/cacc-twin-team");
    expect(packRoutePath("acme/tools")).toBe("/packs/acme/tools");
    expect(packRoutePath("acme/a b")).toBe("/packs/acme/a%20b");
  });

  test("packNameSegments splits on the scope separator only", () => {
    expect(packNameSegments("gascity")).toEqual(["gascity"]);
    expect(packNameSegments("wespd/cacc-twin-team")).toEqual(["wespd", "cacc-twin-team"]);
  });

  test("packNameScope reports a scope only for a scoped name", () => {
    expect(packNameScope("wespd/cacc-twin-team")).toBe("wespd");
    expect(packNameScope("acme/tools")).toBe("acme");
    expect(packNameScope("gascity")).toBeUndefined();
    expect(packNameScope("cacc-twin-team")).toBeUndefined();
    expect(packNameScope("gascity/")).toBeUndefined();
  });
});

describe("publish request normalization", () => {
  test("normalizes GitHub repo URLs and source URLs", () => {
    const request = normalizePublishRequestInput({
      repoUrl: "git@github.com:gastownhall/gascity-packs.git",
      commit,
      packPath: "packs/example",
      requestedName: "example-pack",
      requestedVersion: "1.2.3",
      requestedRef: "refs/tags/v1.2.3",
      requestedDescription: "Initial release",
    });

    expect(request.repository.fullName).toBe("gastownhall/gascity-packs");
    expect(request.repoUrl).toBe("https://github.com/gastownhall/gascity-packs");
    expect(request.sourceUrl).toBe(
      `https://github.com/gastownhall/gascity-packs/tree/${commit}/packs/example`,
    );
  });

  test("rejects non-GitHub repositories", () => {
    expect(() => parseGitHubRepositoryUrl("https://example.com/org/repo")).toThrow(
      /Only github\.com/,
    );
  });

  test("rejects unsafe pack paths", () => {
    expect(() => normalizePackPath("../pack")).toThrow(/dot-dot/);
    expect(() => normalizePackPath("/pack")).toThrow(/relative POSIX/);
    expect(() => normalizePackPath("pack with spaces")).toThrow(/unsupported characters/);
  });

  test("rejects mutable or malformed commit values", () => {
    expect(() =>
      normalizePublishRequestInput({
        repoUrl: "https://github.com/gastownhall/gascity-packs",
        commit: "main",
        requestedName: "example-pack",
        requestedVersion: "1.2.3",
      }),
    ).toThrow(/full lowercase Git SHA/);
  });
});

describe("file-backed publish requests", () => {
  test("stores requests idempotently by pack version and commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-publish-"));
    const store = createStore(undefined, join(dir, "registry.local.json"));
    try {
      await store.init();
      const user = await store.ensureUser({
        subject: "test-subject",
        gasCityUserId: "gcu_test",
        handle: "publisher",
        displayName: "Publisher",
      });

      const input = {
        repoUrl: "https://github.com/gastownhall/gascity-packs",
        commit,
        packPath: "packs/example",
        requestedName: "example-pack",
        requestedVersion: "1.2.3",
      };
      const first = await store.createPublishRequest(user.id, input, "web_session");
      const second = await store.createPublishRequest(user.id, input, "web_session");

      expect(second.id).toBe(first.id);
      expect(second.status).toBe("pending_validation");
      expect(second.submissionMethod).toBe("web_session");
      expect(await store.listAccountPublishRequests(user.id)).toHaveLength(1);

      // A divergent resubmit by the same submitter supersedes its own pending predecessor instead of
      // 409ing forever; the predecessor is closed as `rejected` naming the replacement, and the
      // approved case (which must still conflict) is covered in the conformance suite on both lanes.
      const corrected = await store.createPublishRequest(
        user.id,
        {
          ...input,
          commit: "fedcba9876543210fedcba9876543210fedcba98",
        },
        "web_session",
      );
      expect(corrected.id).not.toBe(first.id);
      expect(corrected.status).toBe("pending_validation");
      const superseded = await store.getPublishRequest(first.id);
      expect(superseded?.status).toBe("rejected");
      expect(superseded?.statusReason).toContain(corrected.id);
      expect(superseded?.reviewedBy).toBeUndefined();
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("repo ownership escape hatch (file store)", () => {
  test("binds to the repo the user personally verified, not org-wide publisher membership", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-ownership-"));
    const store = createStore(undefined, join(dir, "registry.local.json"));
    try {
      await store.init();
      const maintainer = await store.ensureUser({
        subject: "m",
        gasCityUserId: "gcu_m",
        handle: "maintainer",
        displayName: "Maintainer",
      });
      const teammate = await store.ensureUser({
        subject: "t",
        gasCityUserId: "gcu_t",
        handle: "teammate",
        displayName: "Teammate",
      });

      // repo-a and repo-b share one GitHub owner (owner_1) => one publisher, so both users
      // become members of the same publisher. Ownership must still be per-repo, per-user.
      await store.upsertVerifiedPackOwnership(maintainer.id, {
        packKey: "org--repo-a",
        sourceUrl: "https://github.com/org/repo-a/tree/main",
        githubRepositoryId: "repo_a",
        githubRepositoryFullName: "org/repo-a",
        githubRepositoryName: "repo-a",
        githubOwnerId: "owner_1",
        githubOwnerLogin: "org",
        githubOwnerType: "Organization",
        verificationMethod: "github_app_user_token",
      });
      await store.upsertVerifiedPackOwnership(teammate.id, {
        packKey: "org--repo-b",
        sourceUrl: "https://github.com/org/repo-b/tree/main",
        githubRepositoryId: "repo_b",
        githubRepositoryFullName: "org/repo-b",
        githubRepositoryName: "repo-b",
        githubOwnerId: "owner_1",
        githubOwnerLogin: "org",
        githubOwnerType: "Organization",
        verificationMethod: "github_app_user_token",
      });

      // The maintainer proved repo-a (case-insensitive match), and the answer is the numeric id of
      // the repo they proved — the gate needs WHICH repo, not just whether.
      expect(await store.verifiedRepoOwnershipRepositoryId(maintainer.id, "org/repo-a")).toBe("repo_a");
      expect(await store.verifiedRepoOwnershipRepositoryId(maintainer.id, "ORG/REPO-A")).toBe("repo_a");
      // ...but NOT repo-b, which a teammate onboarded under the same org/publisher. This is
      // the org-wide-membership escalation the gate must not permit.
      expect(await store.verifiedRepoOwnershipRepositoryId(maintainer.id, "org/repo-b")).toBeNull();
      expect(await store.verifiedRepoOwnershipRepositoryId(teammate.id, "org/repo-b")).toBe("repo_b");
      // A user who verified nothing is never authorized.
      expect(await store.verifiedRepoOwnershipRepositoryId("usr_nobody", "org/repo-a")).toBeNull();
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("postgres publish request queries", () => {
  test("qualifies duplicate lookup columns across joined tables", async () => {
    const source = await readFile(new URL("./store.ts", import.meta.url), "utf8");
    const createPublishRequestBody = source.match(
      /async createPublishRequest\([\s\S]*?\n  async getPublishRequest/,
    )?.[0];

    expect(createPublishRequestBody).toBeTruthy();
    expect(createPublishRequestBody).toContain("WHERE pack_publish_requests.requested_name =");
    expect(createPublishRequestBody).toContain("AND pack_publish_requests.requested_version =");
    // Dedup must be scoped to the submitter so a user cannot occupy another's slot.
    expect(createPublishRequestBody).toContain("AND pack_publish_requests.submitter_user_id =");
    // Terminal states never block a re-submission: rejected AND withdrawn are both excluded so a
    // taken-down name@version can be reinstated by re-publishing.
    expect(createPublishRequestBody).toContain("AND pack_publish_requests.status NOT IN ('rejected', 'withdrawn')");
    expect(createPublishRequestBody).toContain("ORDER BY pack_publish_requests.created_at DESC");
    expect(createPublishRequestBody).not.toMatch(/\bWHERE requested_name =/);
    expect(createPublishRequestBody).not.toMatch(/\bAND requested_version =/);
    expect(createPublishRequestBody).not.toMatch(/\bAND status NOT IN \('rejected'/);
    expect(createPublishRequestBody).not.toMatch(/\bORDER BY created_at DESC/);
  });

  test("persists submission_method and audits the ownership override on approve", async () => {
    const source = await readFile(new URL("./store.ts", import.meta.url), "utf8");

    const createBody = source.match(
      /async createPublishRequest\([\s\S]*?\n  async getPublishRequest/,
    )?.[0];
    expect(createBody).toBeTruthy();
    // submission_method is persisted from the server-derived param, never the body.
    expect(createBody).toContain("submission_method");
    expect(createBody).toContain("${submissionMethod}");

    const approveBody = source.match(
      /async approvePublishRequest\([\s\S]*?\n  async rejectPublishRequest/,
    )?.[0];
    expect(approveBody).toBeTruthy();
    expect(approveBody).toContain('"publish_request.approve"');
    // The audited justification for a claim-only override is folded into the approve audit.
    expect(approveBody).toContain("ownershipOverrideReason: options?.ownershipOverrideReason");
  });
});

describe("publish request validation", () => {
  test("computes pack hashes through gc with immutable source flags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-gc-"));
    const gcBin = join(dir, "gc");
    const argsFile = join(dir, "gc-args.txt");
    try {
      await writeFile(
        gcBin,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
          `printf '%s\\n' ${JSON.stringify(hash)}`,
        ].join("\n"),
      );
      await chmod(gcBin, 0o755);

      const computed = await computePackHash(
        {
          repoUrl: "https://github.com/gastownhall/gascity-packs",
          commit,
          packPath: "packs/example",
        },
        { gcBin, timeoutMs: 1_000 },
      );

      expect(computed).toBe(hash);
      expect((await readFile(argsFile, "utf8")).trim().split("\n")).toEqual([
        "pack",
        "release",
        "hash",
        "https://github.com/gastownhall/gascity-packs",
        "--commit",
        commit,
        "--path",
        "packs/example",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("builds a synthetic registry entry from upstream pack metadata", async () => {
    const request = {
      id: "prq_test",
      status: "pending_validation" as const,
      repository: {
        host: "github.com" as const,
        owner: "gastownhall",
        name: "gascity-packs",
        fullName: "gastownhall/gascity-packs",
      },
      repoUrl: "https://github.com/gastownhall/gascity-packs",
      sourceUrl: `https://github.com/gastownhall/gascity-packs/tree/${commit}/packs/example`,
      packPath: "packs/example",
      commit,
      requestedName: "example-pack",
      requestedVersion: "1.2.3",
      requestedRef: "refs/tags/v1.2.3",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      submittedBy: {
        id: "usr_test",
        handle: "publisher",
        displayName: "Publisher",
        role: "user" as const,
      },
    };
    const entry = await validatePublishRequestForRegistry(request, testConfig(), {
      fetchFn: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/pack.toml")) {
          return new Response('[pack]\nname = "example-pack"\nschema = 2\n');
        }
        return new Response("# Example Pack\n\nUseful pack for testing.");
      },
      computeHash: async () => hash,
    });

    expect(entry).toEqual({
      name: "example-pack",
      description: "Useful pack for testing.",
      source: `https://github.com/gastownhall/gascity-packs/tree/${commit}/packs/example`,
      sourceKind: "git",
      release: {
        version: "1.2.3",
        ref: "refs/tags/v1.2.3",
        commit,
        hash,
        description: "Publish example-pack 1.2.3.",
      },
    });
  });

  test("rejects a publish whose upstream pack.toml name does not match the request (squatter guard)", async () => {
    const request = {
      id: "prq_mismatch",
      status: "pending_validation" as const,
      repository: {
        host: "github.com" as const,
        owner: "attacker",
        name: "lookalike",
        fullName: "attacker/lookalike",
      },
      repoUrl: "https://github.com/attacker/lookalike",
      sourceUrl: `https://github.com/attacker/lookalike/tree/${commit}/packs/example`,
      packPath: "packs/example",
      commit,
      requestedName: "gascity", // squatting a trusted name...
      requestedVersion: "1.0.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      submittedBy: { id: "usr_attacker", handle: "attacker", displayName: "Attacker", role: "user" as const },
    };
    const promise = validatePublishRequestForRegistry(request, testConfig(), {
      // ...but the upstream pack.toml declares a different name.
      fetchFn: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/pack.toml")) return new Response('[pack]\nname = "attacker-pack"\n');
        return new Response("# other");
      },
      computeHash: async () => hash,
    });
    await expect(promise).rejects.toThrow(/pack\.toml declares/i);
  });
});

describe("dynamic aggregate rendering", () => {
  test("adds approved direct publish entries to registry TOML and catalog JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-approved-"));
    const store = createStore(undefined, join(dir, "registry.local.json"));
    try {
      await store.init();
      const user = await store.ensureUser({
        subject: "submitter",
        gasCityUserId: "gcu_submitter",
        handle: "submitter",
        displayName: "Submitter",
      });
      const admin = await store.ensureUser({
        subject: "admin",
        gasCityUserId: "gcu_admin",
        handle: "admin",
        displayName: "Admin",
      });
      admin.role = "admin";
      const request = await store.createPublishRequest(
        user.id,
        {
          repoUrl: "https://github.com/gastownhall/gascity-packs",
          commit,
          packPath: "packs/example",
          requestedName: "example-pack",
          requestedVersion: "1.2.3",
        },
        "web_session",
      );
      await store.markPublishRequestValidated(request.id, {
        name: "example-pack",
        description: "Example direct pack.",
        source: request.sourceUrl,
        sourceKind: "git",
        release: {
          version: "1.2.3",
          ref: commit,
          commit,
          hash,
          description: "Publish example-pack 1.2.3.",
        },
      });
      await store.approvePublishRequest(admin.id, request.id);
      const approved = await store.listApprovedPublishRequests();
      const registryToml = renderRegistryTomlWithApprovedPublishes("schema = 1\n", approved);
      const catalogJson = renderCatalogJsonWithApprovedPublishes(
        '{"schema":1,"source_count":0,"pack_count":0,"sources":[],"packs":[]}\n',
        approved,
      );

      expect(registryToml).toContain('name = "example-pack"');
      expect(registryToml).toContain(`hash = "${hash}"`);
      const catalog = JSON.parse(catalogJson);
      expect(catalog.pack_count).toBe(1);
      expect(catalog.packs[0].name).toBe("example-pack");
      expect(catalog.packs[0].registry).toBe("direct");
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("pack name grammar", () => {
  const withName = (requestedName: string) => ({
    repoUrl: "https://github.com/acme/tools",
    commit,
    requestedName,
    requestedVersion: "1.0.0",
    packPath: "packs/tools",
  });
  const accepts = (name: string) =>
    expect(normalizePublishRequestInput(withName(name)).requestedName).toBe(name);

  test("accepts a bare name and a one-slash scoped name", () => {
    for (const name of ["a", "example-pack", "acme/a", "acme/example-pack"]) accepts(name);
  });

  // A literal list, NOT a read of public/catalog.json. Ingest deliberately admits names this
  // grammar rejects (`--`, trailing dash), so asserting the submit grammar over the catalog
  // couples the two lanes: an upstream author naming a pack `runtime--cloudflare` would ingest
  // cleanly, pass generate:check, and fail test:unit — which fails CI, which leaves the hourly
  // refresh PR unmerged and freezes public/ for EVERY pack. A skip degrades one pack; a stall
  // degrades all of them.
  //
  // Bare names are also not a product invariant: H1a reserves them with no staff bypass, so every
  // ingested bare name is unpublishable by construction. The only bare names that must keep
  // submitting are the grandfathered claims, and those live in the DB, not in any artifact.
  test("accepts every grandfathered bare claim", () => {
    for (const name of ["cacc-twin-team"]) accepts(name);
  });

  test("rejects consecutive dashes in either segment so the / -> -- flattening stays injective", () => {
    for (const name of ["a--b", "acme/a--b", "a--b/tool", "acme/tool--kit"]) {
      expect(() => normalizePublishRequestInput(withName(name))).toThrow(/consecutive dashes/);
    }
  });

  test("still accepts a trailing dash, which grandfathered claims may rely on", () => {
    for (const name of ["alpha-", "acme/alpha-", "acme-/tool"]) accepts(name);
  });

  test("rejects a segment longer than 64 characters and accepts 64 in both segments", () => {
    const long = "a".repeat(65);
    const max = "a".repeat(64);
    for (const name of [long, `acme/${long}`, `${long}/tool`]) {
      expect(() => normalizePublishRequestInput(withName(name))).toThrow(/64 characters/);
    }
    accepts(`${max}/${max}`);
  });

  test("rejects extra slashes, uppercase, and a leading dash in either segment", () => {
    for (const name of ["a/b/c", "Acme/Tools", "ACME", "acme/Tools", "-lead", "acme/-lead", "/tool"]) {
      expect(() => normalizePublishRequestInput(withName(name))).toThrow(PublishRequestValidationError);
    }
  });

  test("admits no two accepted names that flatten to the same pack_key component", () => {
    const flattened = new Map<string, string>();
    let accepted = 0;
    const walk = (prefix: string) => {
      if (prefix.length > 0) {
        let ok = true;
        try {
          normalizePublishRequestInput(withName(prefix));
        } catch {
          ok = false;
        }
        if (ok) {
          accepted += 1;
          const flat = prefix.replaceAll("/", "--");
          expect(flattened.get(flat) ?? prefix).toBe(prefix);
          flattened.set(flat, prefix);
        }
      }
      if (prefix.length === 6) return;
      for (const character of ["a", "b", "-", "/"]) walk(prefix + character);
    };
    walk("");
    expect(accepted).toBeGreaterThan(100);
    expect(flattened.size).toBe(accepted);
  });
});

// The version is pure client input (publish-validation compares only pack.toml's NAME) and several
// security-relevant lookups key on it as bytes — H4's withdrawn-version guard most of all. So the
// grammar has to admit exactly one spelling per version, or a takedown re-lands under a synonym.
describe("release version grammar", () => {
  const withVersion = (requestedVersion: string) => ({
    repoUrl: "https://github.com/acme/tools",
    commit,
    requestedName: "acme/tools",
    requestedVersion,
    packPath: "packs/tools",
  });

  test("accepts canonical major.minor.patch including zeroes", () => {
    for (const version of ["0.0.0", "0.1.0", "1.0.0", "1.2.3", "10.20.30"]) {
      expect(normalizePublishRequestInput(withVersion(version)).requestedVersion).toBe(version);
    }
  });

  // Each of these is a distinct string that compareVersions (server/aggregate.ts parseInts and pads
  // to three) calls EQUAL to 0.1.0, so admitting any of them means the withdrawn-version guard
  // looks up a spelling nobody withdrew while the site treats the release as the same version.
  test("rejects every alternate spelling of a canonical version", () => {
    for (const version of ["0.1", "0.01.0", "00.1.0", "0.1.00", "1.0", "01.2.3", "1.2.3.4", "1"]) {
      expect(() => normalizePublishRequestInput(withVersion(version))).toThrow(
        /semver major\.minor\.patch with no leading zeros/,
      );
    }
  });

  test("no two accepted versions collide under compareVersions", () => {
    const accepted: string[] = [];
    const walk = (prefix: string) => {
      if (prefix.length > 0) {
        try {
          accepted.push(normalizePublishRequestInput(withVersion(prefix)).requestedVersion);
        } catch {
          // not a version; keep walking
        }
      }
      // Depth 6 is the shallowest that reaches BOTH a two-digit part (`10.1.1`) and its
      // leading-zero synonym (`01.1.1`) — the pair the injectivity claim is actually about.
      if (prefix.length === 6) return;
      for (const character of ["0", "1", "."]) walk(prefix + character);
    };
    walk("");
    expect(accepted.length).toBeGreaterThan(8);
    const canonicalKeys = new Set(
      accepted.map((version) =>
        version
          .split(".")
          .map((part) => String(Number.parseInt(part, 10)))
          .join("."),
      ),
    );
    expect(canonicalKeys.size).toBe(accepted.length);
  });
});

function testConfig(): ServerConfig {
  return {
    port: 8080,
    appUrl: "http://127.0.0.1:8080",
    mountBase: "",
    sessionSecret: "test-secret-test-secret-test-secret",
    localDataPath: ".registry-data/test.json",
    publishValidation: {
      gcBin: "gc",
      timeoutMs: 1_000,
    },
    isProduction: false,
    devAuthEnabled: true,
  };
}
