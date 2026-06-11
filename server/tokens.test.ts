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

  test("approves CLI device codes and mints one token on poll", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-device-codes-"));
    const store = createStore(undefined, join(dir, "registry.local.json"));
    try {
      await store.init();
      const user = await store.ensureUser({
        subject: "device-user",
        gasCityUserId: "gcu_device_user",
        handle: "device-user",
        displayName: "Device User",
      });
      const created = await store.createCliDeviceCode({
        deviceCode: "device-secret",
        userCode: "ABCD-2345",
        label: "Laptop login",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        intervalSeconds: 5,
      });

      expect(created.deviceCode).toBe("device-secret");
      expect(created.userCode).toBe("ABCD-2345");
      expect(await store.pollCliDeviceCode("device-secret")).toEqual({
        status: "pending",
        intervalSeconds: 5,
      });

      const rawState = await readFile(join(dir, "registry.local.json"), "utf8");
      expect(rawState).not.toContain("device-secret");
      expect(rawState).not.toContain("ABCD-2345");

      await store.approveCliDeviceCode(user.id, "abcd 2345");
      const approved = await store.pollCliDeviceCode("device-secret");
      expect(approved.status).toBe("approved");
      if (approved.status !== "approved") throw new Error("expected approval");
      expect(approved.token.token.startsWith("gcr_")).toBe(true);
      expect(approved.token.label).toBe("Laptop login");
      expect(await store.getUserForApiToken(approved.token.token)).toMatchObject({
        user: { id: user.id },
      });

      expect(await store.pollCliDeviceCode("device-secret")).toEqual({ status: "expired" });
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("denied CLI device codes do not mint tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-device-deny-"));
    const store = createStore(undefined, join(dir, "registry.local.json"));
    try {
      await store.init();
      const user = await store.ensureUser({
        subject: "deny-user",
        gasCityUserId: "gcu_deny_user",
        handle: "deny-user",
        displayName: "Deny User",
      });
      await store.createCliDeviceCode({
        deviceCode: "device-denied",
        userCode: "WXYZ-9876",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        intervalSeconds: 5,
      });
      await store.denyCliDeviceCode(user.id, "WXYZ-9876");
      expect(await store.pollCliDeviceCode("device-denied")).toEqual({ status: "denied" });
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stores constrained short-lived publish tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-constrained-token-"));
    const store = createStore(undefined, join(dir, "registry.local.json"));
    try {
      await store.init();
      const user = await store.ensureUser({
        subject: "github-actions:123",
        gasCityUserId: "github-actions:123",
        handle: "gha-demo",
        displayName: "Demo Actions",
      });
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      const created = await store.createApiToken(user.id, {
        label: "GitHub Actions demo-pack 1.2.3",
        kind: "github_actions_publish",
        expiresAt,
        constraints: {
          repoUrl: "https://github.com/gastownhall/demo-packs",
          commit: "0123456789abcdef0123456789abcdef01234567",
          packPath: "packs/demo",
          requestedName: "demo-pack",
          requestedVersion: "1.2.3",
        },
      });

      expect(created.kind).toBe("github_actions_publish");
      expect(created.expiresAt).toBe(expiresAt.toISOString());
      const auth = await store.getUserForApiToken(created.token);
      expect(auth?.kind).toBe("github_actions_publish");
      expect(auth?.constraints).toMatchObject({
        requestedName: "demo-pack",
        requestedVersion: "1.2.3",
      });
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("expired publish tokens do not authenticate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-expired-token-"));
    const store = createStore(undefined, join(dir, "registry.local.json"));
    try {
      await store.init();
      const user = await store.ensureUser({
        subject: "github-actions:expired",
        gasCityUserId: "github-actions:expired",
        handle: "gha-expired",
        displayName: "Expired Actions",
      });
      const created = await store.createApiToken(user.id, {
        label: "Expired Actions token",
        kind: "github_actions_publish",
        expiresAt: new Date(Date.now() - 1000),
        constraints: {
          repoUrl: "https://github.com/gastownhall/demo-packs",
          commit: "0123456789abcdef0123456789abcdef01234567",
          packPath: ".",
          requestedName: "demo-pack",
          requestedVersion: "1.2.3",
        },
      });
      expect(await store.getUserForApiToken(created.token)).toBeNull();
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
