import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  discoverGitHubPublishCandidates,
  publishInputFromGitHubCandidate,
} from "./github-publish";
import { createStore } from "./store";
import type { GitHubPublishCandidate } from "./types";

const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const tree = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("GitHub publish discovery", () => {
  test("discovers nested public pack manifests from app installation repositories", async () => {
    const calls: string[] = [];
    const result = await discoverGitHubPublishCandidates("github-token", {
      fetchGitHub: async (apiPath) => {
        calls.push(apiPath);
        return githubResponse(apiPath);
      },
    });

    expect(result.repositoriesScanned).toBe(3);
    expect(result.privateRepositoriesSkipped).toBe(1);
    expect(result.candidates.map((candidate) => candidate.pack.name)).toEqual([
      "root-pack",
      "demo-pack",
    ]);
    expect(result.candidates[0].packPath).toBe(".");
    expect(result.candidates[1].packPath).toBe("packs/demo");
    expect(result.candidates[1].pack.version).toBe("0.2.0");
    expect(result.candidates[1].repository.permission).toBe("maintain");
    expect(calls).toContain(`/repos/acme/packs/git/trees/${tree}?recursive=1`);

    // Both rename-stable GitHub ids, as strings. These are what a github_import publish stamps on
    // its request, and therefore what the minted name claim is pinned by. Without the owner id the
    // claim comparison silently downgrades to a case-folded LOGIN compare, which a repo transfer
    // to a re-registered login defeats — so an unasserted `ownerId` is a security regression that
    // leaves every other test green.
    for (const candidate of result.candidates) {
      expect(candidate.repository.id).toBe("12");
      expect(candidate.repository.ownerId).toBe("4242");
    }
  });

  // The fixture repo also holds pack.toml manifests named `legacy--pack` and a 65-character
  // name. Both would 422 on submit, so offering them as importable candidates would send the
  // publisher into a dead end — and the long one would brick every `gc` client if approved.
  test("drops candidates whose manifest name is not publishable", async () => {
    const result = await discoverGitHubPublishCandidates("github-token", {
      fetchGitHub: async (apiPath) => githubResponse(apiPath),
    });

    expect(result.candidates.map((candidate) => candidate.pack.name)).toEqual([
      "root-pack",
      "demo-pack",
    ]);
    expect(result.candidates.map((candidate) => candidate.packPath)).not.toContain("packs/legacy");
  });

  test("builds publish input from immutable candidate fields and editable metadata", () => {
    const candidate = candidateFixture({ version: undefined });
    const input = publishInputFromGitHubCandidate(candidate, {
      requestedVersion: "0.3.0",
      requestedDescription: "Release from the browser.",
    });

    expect(input).toEqual({
      repoUrl: "https://github.com/acme/packs",
      commit,
      packPath: "packs/demo",
      requestedName: "demo-pack",
      requestedVersion: "0.3.0",
      requestedRef: "main",
      requestedDescription: "Release from the browser.",
    });
  });
});

describe("GitHub publish imports", () => {
  test("file store returns imports only to the owning user before expiry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-github-import-"));
    const store = createStore(undefined, join(dir, "registry.local.json"));
    try {
      await store.init();
      const owner = await store.ensureUser({
        subject: "owner",
        gasCityUserId: "gcu_owner",
        handle: "owner",
        displayName: "Owner",
      });
      const other = await store.ensureUser({
        subject: "other",
        gasCityUserId: "gcu_other",
        handle: "other",
        displayName: "Other",
      });
      const imported = await store.createGitHubPublishImport(owner.id, {
        repositoriesScanned: 1,
        privateRepositoriesSkipped: 0,
        candidates: [candidateFixture()],
        scanErrors: [],
        truncated: false,
        expiresAt: new Date(Date.now() + 60_000),
      });

      expect((await store.getGitHubPublishImport(owner.id, imported.id))?.candidates).toHaveLength(1);
      expect(await store.getGitHubPublishImport(other.id, imported.id)).toBeNull();
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function githubResponse(apiPath: string) {
  if (apiPath === "/user/installations?per_page=100&page=1") {
    return jsonResponse({ installations: [{ id: 1 }] });
  }
  if (apiPath === "/user/installations/1/repositories?per_page=100&page=1") {
    return jsonResponse({
      repositories: [
        {
          id: 10,
          full_name: "acme/private-packs",
          name: "private-packs",
          html_url: "https://github.com/acme/private-packs",
          private: true,
          default_branch: "main",
          permissions: { admin: true, maintain: true, push: true, pull: true },
        },
        {
          id: 11,
          full_name: "acme/read-only",
          name: "read-only",
          html_url: "https://github.com/acme/read-only",
          private: false,
          default_branch: "main",
          permissions: { pull: true },
        },
        {
          id: 12,
          full_name: "acme/packs",
          name: "packs",
          // The installation listing always carries the owner object; capturing its numeric id
          // here is the ONLY free source of a rename-stable account id on the import path
          // (/repos/{o}/{n}/branches/{b}, the other call this scan makes, has no owner in its
          // payload).
          owner: { id: 4242, login: "acme" },
          html_url: "https://github.com/acme/packs",
          private: false,
          default_branch: "main",
          permissions: { maintain: true, push: true, pull: true },
        },
      ],
    });
  }
  if (apiPath === "/repos/acme/packs/branches/main") {
    return jsonResponse({
      commit: {
        sha: commit,
        commit: {
          tree: { sha: tree },
        },
      },
    });
  }
  if (apiPath === `/repos/acme/packs/git/trees/${tree}?recursive=1`) {
    return jsonResponse({
      tree: [
        { path: "README.md", type: "blob" },
        { path: "pack.toml", type: "blob" },
        { path: "packs/demo/pack.toml", type: "blob" },
        { path: "packs/legacy/pack.toml", type: "blob" },
        { path: "packs/long/pack.toml", type: "blob" },
      ],
      truncated: false,
    });
  }
  if (apiPath === `/repos/acme/packs/contents/pack.toml?ref=${commit}`) {
    return contentResponse('[pack]\nname = "root-pack"\nversion = "0.1.0"\n');
  }
  if (apiPath === `/repos/acme/packs/contents/packs/demo/pack.toml?ref=${commit}`) {
    return contentResponse(
      '[pack]\nname = "demo-pack"\nversion = "0.2.0"\ndescription = "Demo pack."\n',
    );
  }
  if (apiPath === `/repos/acme/packs/contents/packs/legacy/pack.toml?ref=${commit}`) {
    return contentResponse('[pack]\nname = "legacy--pack"\nversion = "0.1.0"\n');
  }
  if (apiPath === `/repos/acme/packs/contents/packs/long/pack.toml?ref=${commit}`) {
    return contentResponse(`[pack]\nname = "${"a".repeat(65)}"\nversion = "0.1.0"\n`);
  }
  return jsonResponse({ message: "not found" }, 404);
}

function contentResponse(text: string) {
  return jsonResponse({
    type: "file",
    encoding: "base64",
    content: Buffer.from(text, "utf8").toString("base64"),
    size: Buffer.byteLength(text, "utf8"),
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function candidateFixture(overrides: { version?: string } = {}): GitHubPublishCandidate {
  return {
    id: "gpc_test",
    repository: {
      id: "12",
      fullName: "acme/packs",
      owner: "acme",
      name: "packs",
      htmlUrl: "https://github.com/acme/packs",
      defaultBranch: "main",
      permission: "push",
    },
    branch: "main",
    commit,
    packPath: "packs/demo",
    packTomlPath: "packs/demo/pack.toml",
    pack: {
      name: "demo-pack",
      version: overrides.version,
    },
    warnings: [],
  };
}
