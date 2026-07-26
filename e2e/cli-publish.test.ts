// Real-gc CLI e2e: boots the harness in real-gc mode (real validatePublishRequest + the real
// `gc pack release hash` subprocess against a real commit), then drives the ACTUAL `gc` binary
// out-of-process — `gc pack registry publish ... --dev-auth` — and asserts the pack lands in the
// served catalog and that the server-computed hash equals gc's own. Proves the gc<->server
// contract that the stubbed integration test cannot. `gc` must be on PATH (CI extracts the
// pinned binary from the production image).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PublishRequestRow } from "../server/types";

const PORT = 48278; // distinct from Playwright's 48177
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = "e2e-fixture/demo-pack";
// Direct publishes are SCOPED `owner/pack`, and the scope must be the GitHub owner of the proven
// source repo. An unscoped name would be refused at approve with PUBLISH_NAME_RESERVED.
const PACK_NAME = "e2e-fixture/e2e-demo";

let dir: string;
let fixture: string;
let commit: string;
let serverProc: ReturnType<typeof Bun.spawn> | undefined;

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

async function adminSession() {
  const signIn = await fetch(`${BASE}/api/dev/sign-in?handle=cli-admin&role=admin`, { redirect: "manual" });
  const cookie = (signIn.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  const me = (await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json()) as {
    csrfToken: string;
  };
  return { cookie, csrfToken: me.csrfToken };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "registry-cli-e2e-"));
  fixture = join(dir, "fixture");
  await mkdir(join(fixture, "packs/demo"), { recursive: true });
  await writeFile(
    join(fixture, "packs/demo/pack.toml"),
    `[pack]\nname = "${PACK_NAME}"\nversion = "0.1.0"\ndescription = "E2E demo pack."\n`,
  );
  await writeFile(
    join(fixture, "packs/demo/README.md"),
    `# ${PACK_NAME}\n\nFixture pack for the registry real-gc e2e.\n`,
  );

  const git = (...args: string[]) =>
    run(["git", "-c", "user.email=e2e@test", "-c", "user.name=e2e", ...args], { cwd: fixture });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  commit = git("rev-parse", "HEAD").stdout.trim();
  // gc publish reads repoUrl from `origin` and requires HEAD == the configured upstream; a
  // synthetic upstream ref satisfies both with zero network.
  git("remote", "add", "origin", `https://github.com/${REPO}.git`);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("config", "branch.main.remote", "origin");
  git("config", "branch.main.merge", "refs/heads/main");

  serverProc = Bun.spawn(["bun", "server/index.harness.ts"], {
    env: {
      ...process.env,
      REGISTRY_HARNESS: "1",
      REGISTRY_HARNESS_MODE: "real-gc",
      REGISTRY_HARNESS_REPO: REPO,
      REGISTRY_HARNESS_FIXTURE_ROOT: fixture,
      REGISTRY_DEV_AUTH: "1",
      PORT: String(PORT),
      APP_URL: BASE,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("harness did not become healthy");
}, 60_000);

afterAll(async () => {
  serverProc?.kill();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test(
  "real gc publishes through the harness and the pack lands in the served catalog",
  async () => {
    // Out-of-process, real CLI, real dev-auth session, real server-side validation
    // (--validate defaults true). HOME=dir isolates gc's stored registry login.
    const publish = run(
      ["gc", "pack", "registry", "publish", "packs/demo", "--dev-auth", "--dev-auth-handle", "e2e-cli"],
      { cwd: fixture, env: { GC_REGISTRY_URL: BASE, HOME: dir } },
    );
    expect(publish.code, publish.stderr || publish.stdout).toBe(0);

    // Ground-truth hash from the same gc binary, computed independently of the server.
    const expectedHash = run([
      "gc",
      "pack",
      "release",
      "hash",
      fixture,
      "--commit",
      commit,
      "--path",
      "packs/demo",
    ]).stdout.trim();
    expect(expectedHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const { cookie, csrfToken } = await adminSession();
    const queue = (await (
      await fetch(`${BASE}/api/admin/publish-requests`, {
        headers: { Cookie: cookie, "X-CSRF-Token": csrfToken },
      })
    ).json()) as { publishRequests: PublishRequestRow[] };
    const request = queue.publishRequests.find((row) => row.requestedName === PACK_NAME);
    expect(request?.status).toBe("pending_review"); // real server-side gc validation ran
    expect(request?.commit).toBe(commit);
    expect(request?.registryEntry?.release.hash).toBe(expectedHash); // server hash == real gc hash

    const approve = await fetch(`${BASE}/api/publish-requests/${encodeURIComponent(request!.id)}/approve`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        "Content-Type": "application/json",
        Origin: BASE,
      },
      body: JSON.stringify({ ownershipOverrideReason: "e2e real-gc harness" }),
    });
    expect(approve.status, await approve.clone().text()).toBe(200);

    const catalog = (await (await fetch(`${BASE}/catalog.json`)).json()) as {
      packs: Array<{ name: string; latest: string }>;
    };
    expect(catalog.packs).toContainEqual(expect.objectContaining({ name: PACK_NAME, latest: "0.1.0" }));
    const toml = await (await fetch(`${BASE}/registry.toml`)).text();
    expect(toml).toContain(`name = "${PACK_NAME}"`);

    // The pinned production gc must consume the same live aggregate that the browser does.
    // Cover both trust tiers and both user-facing projections so Registry cannot ship fields
    // that its deployed CLI silently drops.
    const registryName = "e2e";
    const cliEnv = { HOME: dir };
    const servedRegistry = join(dir, "served-registry.toml");
    await writeFile(servedRegistry, toml);
    const addRegistry = run(
      ["gc", "pack", "registry", "add", registryName, servedRegistry],
      { env: cliEnv },
    );
    expect(addRegistry.code, addRegistry.stderr || addRegistry.stdout).toBe(0);

    const attributionCases = [
      {
        name: "gascity",
        tier: "maintained",
        publisher: "Gas City",
        searchTextPattern: /gascity\s+\S+\s+maintained\s+Gas City/,
      },
      {
        name: PACK_NAME,
        tier: "community",
        publisher: "e2e-fixture",
        searchTextPattern:
          /e2e-fixture\/e2e-demo\s+0\.1\.0\s+community\s+e2e-fixture/,
      },
    ] as const;

    const searchText = run(
      ["gc", "pack", "registry", "search", "--registry", registryName, "--all"],
      { env: cliEnv },
    );
    expect(searchText.code, searchText.stderr || searchText.stdout).toBe(0);
    for (const expected of attributionCases) {
      expect(searchText.stdout).toMatch(expected.searchTextPattern);
    }

    const searchJson = run(
      ["gc", "pack", "registry", "search", "--registry", registryName, "--all", "--json"],
      { env: cliEnv },
    );
    expect(searchJson.code, searchJson.stderr || searchJson.stdout).toBe(0);
    const searchResult = JSON.parse(searchJson.stdout) as {
      results: Array<{ name: string; tier: string; publisher: string }>;
    };
    for (const expected of attributionCases) {
      expect(
        searchResult.results.find((row) => row.name === expected.name),
      ).toMatchObject({
        tier: expected.tier,
        publisher: expected.publisher,
      });

      const showText = run(
        ["gc", "pack", "registry", "show", `${registryName}:${expected.name}`],
        { env: cliEnv },
      );
      expect(showText.code, showText.stderr || showText.stdout).toBe(0);
      expect(showText.stdout).toMatch(new RegExp(`^Tier:\\s+${expected.tier}$`, "m"));
      expect(showText.stdout).toMatch(
        new RegExp(`^Publisher:\\s+${expected.publisher}$`, "m"),
      );

      const showJson = run(
        [
          "gc",
          "pack",
          "registry",
          "show",
          `${registryName}:${expected.name}`,
          "--json",
        ],
        { env: cliEnv },
      );
      expect(showJson.code, showJson.stderr || showJson.stdout).toBe(0);
      expect(JSON.parse(showJson.stdout)).toMatchObject({
        name: expected.name,
        tier: expected.tier,
        publisher: expected.publisher,
      });
    }
  },
  120_000,
);
