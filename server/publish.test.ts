import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  normalizePackPath,
  normalizePublishRequestInput,
  parseGitHubRepositoryUrl,
} from "./publish";
import { createStore, StoreConflictError } from "./store";

const commit = "0123456789abcdef0123456789abcdef01234567";

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
