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
  parseGitHubRepositoryUrl,
} from "./publish";
import { computePackHash, validatePublishRequestForRegistry } from "./publish-validation";
import { createStore, StoreConflictError } from "./store";
import type { ServerConfig } from "./config";

const commit = "0123456789abcdef0123456789abcdef01234567";
const hash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
      const first = await store.createPublishRequest(user.id, input);
      const second = await store.createPublishRequest(user.id, input);

      expect(second.id).toBe(first.id);
      expect(second.status).toBe("pending_validation");
      expect(await store.listAccountPublishRequests(user.id)).toHaveLength(1);

      await expect(
        store.createPublishRequest(user.id, {
          ...input,
          commit: "fedcba9876543210fedcba9876543210fedcba98",
        }),
      ).rejects.toBeInstanceOf(StoreConflictError);
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
    expect(createPublishRequestBody).toContain("AND pack_publish_requests.status <> 'rejected'");
    expect(createPublishRequestBody).toContain("ORDER BY pack_publish_requests.created_at DESC");
    expect(createPublishRequestBody).not.toMatch(/\bWHERE requested_name =/);
    expect(createPublishRequestBody).not.toMatch(/\bAND requested_version =/);
    expect(createPublishRequestBody).not.toMatch(/\bAND status <> 'rejected'/);
    expect(createPublishRequestBody).not.toMatch(/\bORDER BY created_at DESC/);
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
      const request = await store.createPublishRequest(user.id, {
        repoUrl: "https://github.com/gastownhall/gascity-packs",
        commit,
        packPath: "packs/example",
        requestedName: "example-pack",
        requestedVersion: "1.2.3",
      });
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
