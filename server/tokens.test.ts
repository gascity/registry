import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createStore } from "./store";
import { parseBearerToken } from "./tokens";

describe("registry API tokens", () => {
  test("authenticates by bearer token without storing the raw token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-tokens-"));
    const store = createStore(undefined, join(dir, "registry.local.json"));
    try {
      await store.init();
      const user = await store.ensureUser({
        subject: "token-user",
        gasCityUserId: "gcu_token_user",
        handle: "token-user",
        displayName: "Token User",
      });

      const created = await store.createApiToken(user.id, { label: "Publish CLI" });
      expect(created.token.startsWith("gcr_")).toBe(true);
      expect(created.prefix).toBe(created.token.slice(0, 12));

      const rawState = await readFile(join(dir, "registry.local.json"), "utf8");
      expect(rawState).not.toContain(created.token);
      expect(rawState).toContain(created.prefix);

      const auth = await store.getUserForApiToken(created.token);
      expect(auth?.user.id).toBe(user.id);
      expect(auth?.user.handle).toBe("token-user");

      const tokens = await store.listApiTokens(user.id);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].lastUsedAt).toBeDefined();

      await store.revokeApiToken(user.id, created.id);
      expect(await store.getUserForApiToken(created.token)).toBeNull();
      expect((await store.listApiTokens(user.id))[0].revokedAt).toBeDefined();
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("parses bearer authorization headers", () => {
    expect(parseBearerToken("Bearer gcr_test")).toBe("gcr_test");
    expect(parseBearerToken("bearer   gcr_test  ")).toBe("gcr_test");
    expect(parseBearerToken("Basic gcr_test")).toBeNull();
    expect(parseBearerToken(null)).toBeNull();
  });
});
