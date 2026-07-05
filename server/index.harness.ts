// E2E harness entrypoint. NEVER run in production. Prod boots server/index.ts and
// never imports this file, so the fake dependencies below are physically absent from
// the production graph. As defense in depth this entrypoint also refuses to start
// without REGISTRY_HARNESS=1 and refuses any production/deployed-looking config
// (devAuthEnabled is itself force-false off a loopback origin — see config.ts).
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryServer } from "./app";
import { loadConfig, type ServerConfig } from "./config";
import { computePackHash, validatePublishRequestForRegistry } from "./publish-validation";
import { createStore } from "./store";
import type { GitHubActionsIdentity } from "./github-actions";
import type { PublishRegistryEntry, PublishRequestRow } from "./types";

if (process.env.REGISTRY_HARNESS !== "1") {
  console.error("[registry-harness] refusing to start: REGISTRY_HARNESS=1 is required.");
  process.exit(1);
}

const config = loadConfig();
if (config.isProduction || !config.devAuthEnabled) {
  console.error(
    "[registry-harness] refusing to start: requires a local, dev-auth-enabled config " +
      "(loopback APP_URL, REGISTRY_DEV_AUTH=1, not production).",
  );
  process.exit(1);
}

const mode = process.env.REGISTRY_HARNESS_MODE === "real-gc" ? "real-gc" : "hermetic";
const fixtureRepo = process.env.REGISTRY_HARNESS_REPO?.trim() || "e2e-fixture/demo-pack";
const fixtureRoot = process.env.REGISTRY_HARNESS_FIXTURE_ROOT?.trim();
if (mode === "real-gc" && !fixtureRoot) {
  console.error("[registry-harness] real-gc mode requires REGISTRY_HARNESS_FIXTURE_ROOT.");
  process.exit(1);
}

// No DATABASE_URL and no pinned data path -> a fresh temp store per run, so out-of-process
// e2e runs can't leak state into each other (TESTING.md §10 isolation).
if (!config.databaseUrl && !process.env.REGISTRY_DATA_PATH) {
  config.localDataPath = join(mkdtempSync(join(tmpdir(), "registry-harness-")), "registry.json");
}

const store = createStore(config.databaseUrl, config.localDataPath);
await store.init();

const [owner = "e2e-fixture", repoName = "demo-pack"] = fixtureRepo.split("/");
void repoName;

const server = createRegistryServer({
  config,
  store,
  validatePublishRequest: mode === "real-gc" ? realGcValidate : hermeticValidate,
  exchangeGitHubCode: async () => "harness-github-user-token",
  discoverGitHubPublishCandidates: async () => ({
    repositoriesScanned: 0,
    privateRepositoriesSkipped: 0,
    candidates: [],
    scanErrors: [],
    truncated: false,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  }),
  verifyGitHubActionsOidcToken: async () =>
    ({
      repository: fixtureRepo,
      repositoryId: "harness_repo_1",
      repositoryOwner: owner,
      repositoryOwnerId: "harness_owner_1",
      workflowRef: `${fixtureRepo}/.github/workflows/release.yml@refs/heads/main`,
      runId: "1",
      runAttempt: "1",
      sha: "0".repeat(40),
      actor: "harness",
      actorId: "harness_actor_1",
      eventName: "push",
    }) satisfies GitHubActionsIdentity,
  verifyGitHubPackOwnership: async (_config, _code, sourceRepository) => ({
    githubRepositoryId: "harness_repo_1",
    githubRepositoryFullName: sourceRepository.fullName,
    githubRepositoryName: sourceRepository.name,
    githubOwnerId: "harness_owner_1",
    githubOwnerLogin: sourceRepository.owner,
    githubOwnerType: "User" as const,
    verificationMethod: "github_app_user_token" as const,
  }),
});

console.log(
  `[registry-harness] ready mode=${mode} store=${store.kind} url=http://127.0.0.1:${server.port}`,
);

process.on("SIGTERM", () => void store.close().finally(() => process.exit(0)));

// Deterministic, network-free, gc-free validation: a stable sha256 derived from
// repo+commit+packPath, so hermetic e2e runs never touch gc or the network.
async function hermeticValidate(request: PublishRequestRow): Promise<PublishRegistryEntry> {
  const hash = `sha256:${createHash("sha256")
    .update(`${request.repository.fullName}:${request.commit}:${request.packPath}`)
    .digest("hex")}`;
  return {
    name: request.requestedName,
    description:
      request.requestedDescription ??
      `${request.requestedName} pack from ${request.repository.fullName}.`,
    source: request.sourceUrl,
    sourceKind: "git",
    release: {
      version: request.requestedVersion,
      ref: request.requestedRef ?? request.commit,
      commit: request.commit,
      hash,
      description:
        request.requestedDescription ??
        `Publish ${request.requestedName} ${request.requestedVersion}.`,
    },
  };
}

// Real validation + the REAL `gc pack release hash` subprocess against a real commit;
// only the transport is redirected: raw.githubusercontent.com -> fixture files, and the
// hash source -> the local fixture repo path (gc accepts local paths).
async function realGcValidate(request: PublishRequestRow, cfg: ServerConfig) {
  if (request.repository.fullName !== fixtureRepo) {
    throw new Error(`[registry-harness] unknown fixture repository ${request.repository.fullName}`);
  }
  return validatePublishRequestForRegistry(request, cfg, {
    fetchFn: fixtureRawFetch(fixtureRoot!, fixtureRepo),
    computeHash: (row) =>
      computePackHash(
        { repoUrl: fixtureRoot!, commit: row.commit, packPath: row.packPath },
        { gcBin: cfg.publishValidation.gcBin, timeoutMs: cfg.publishValidation.timeoutMs },
      ),
  });
}

function fixtureRawFetch(root: string, repoFullName: string) {
  return async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsed = new URL(raw);
    if (parsed.hostname !== "raw.githubusercontent.com") {
      return new Response("not found", { status: 404 });
    }
    const [o, r, _commit, ...pathParts] = parsed.pathname.split("/").filter(Boolean);
    if (`${o}/${r}` !== repoFullName) return new Response("not found", { status: 404 });
    const file = Bun.file(join(root, ...pathParts));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  };
}
