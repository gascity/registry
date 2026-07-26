import { extname, normalize } from "node:path";
import {
  type CatalogRenderIssue,
  renderCatalogJsonWithApprovedPublishes,
  renderRegistryTomlWithApprovedPublishes,
} from "./aggregate";
import type { ServerConfig } from "./config";
import {
  clearSession,
  createDevSession,
  finishLogin,
  getRequestApiTokenAuth,
  getRequestSession,
  requireCsrf,
  startLogin,
  AuthError,
} from "./auth";
import {
  CLI_DEVICE_CODE_INTERVAL_SECONDS,
  CLI_DEVICE_CODE_TTL_MS,
  buildCliVerificationUris,
  generateCliDeviceCodePair,
  validateCliLoopbackRedirectUri,
} from "./cli-auth";
import { findCatalogPackSource, type CatalogPackSource } from "./catalog";
import {
  PublishRequestValidationError,
  nameClaimMatchesRequest,
  normalizePublishRequestInput,
  packNameScope,
  packRoutePath,
  parseGitHubRepositoryUrl,
  sameSourceRepository,
} from "./publish";
import { validatePublishRequestForRegistry } from "./publish-validation";
import { StoreConflictError, StoreValidationError } from "./store";
import { RequestError, assertOrigin, errorJson, json, readJsonBody, readOptionalJsonBody } from "./http";
import { enforceRateLimit, tryConsumeRateLimit, withSecurityHeaders } from "./security";
import {
  githubAppConfigured,
  githubAppClientId,
  githubAppInstallUrl,
  githubAuthorizationUrl,
  exchangeGitHubCode as defaultExchangeGitHubCode,
  parseGitHubSource,
  revokedRepositoryIdsFromWebhook,
  signGitHubClaimState,
  signGitHubPublishImportState,
  tryVerifyGitHubPublishImportState,
  validateGitHubWebhook,
  verifyGitHubClaimState,
  verifyGitHubPackOwnership as defaultVerifyGitHubPackOwnership,
} from "./github";
import {
  discoverGitHubPublishCandidates as defaultDiscoverGitHubPublishCandidates,
  publishInputFromGitHubCandidate,
} from "./github-publish";
import {
  GITHUB_ACTIONS_OIDC_AUDIENCE,
  assertGitHubActionsCanMintPublishToken,
  verifyGitHubActionsOidcToken as defaultVerifyGitHubActionsOidcToken,
  type GitHubActionsIdentity,
} from "./github-actions";
import type {
  ApiTokenAuthResult,
  ApiTokenPublishConstraints,
  GitHubPublishImportCreateInput,
  PublishApprovalDecision,
  PublishRegistryEntry,
  PublishRequestInput,
  PublishRequestRow,
  PublishRequestStatus,
  PublishSourceIdentity,
  PublishSubmissionMethod,
  ReviewInput,
  SourceRepository,
  SessionRecord,
  RegistryStore,
} from "./types";

export type RegistryAppDependencies = {
  config: ServerConfig;
  store: RegistryStore;
  distRoot?: URL;
  validatePublishRequest?: (
    request: PublishRequestRow,
    config: ServerConfig,
  ) => Promise<PublishRegistryEntry>;
  verifyGitHubActionsOidcToken?: (token: string) => Promise<GitHubActionsIdentity>;
  verifyRegistryEiaToken?: Parameters<typeof getRequestApiTokenAuth>[3];
  exchangeGitHubCode?: (config: ServerConfig, code: string) => Promise<string>;
  discoverGitHubPublishCandidates?: (accessToken: string) => Promise<GitHubPublishImportCreateInput>;
  verifyGitHubPackOwnership?: (
    config: ServerConfig,
    code: string,
    sourceRepository: SourceRepository,
  ) => Promise<Awaited<ReturnType<typeof defaultVerifyGitHubPackOwnership>>>;
};

export function createRegistryFetchHandler(dependencies: RegistryAppDependencies) {
  const config = dependencies.config;
  const store = dependencies.store;
  const distRoot = dependencies.distRoot ?? new URL("../dist/", import.meta.url);
  const validatePublishRequest =
    dependencies.validatePublishRequest ?? validatePublishRequestForRegistry;
  const verifyGitHubActionsOidcToken =
    dependencies.verifyGitHubActionsOidcToken ?? defaultVerifyGitHubActionsOidcToken;
  const exchangeGitHubCode = dependencies.exchangeGitHubCode ?? defaultExchangeGitHubCode;
  const discoverGitHubPublishCandidates =
    dependencies.discoverGitHubPublishCandidates ?? defaultDiscoverGitHubPublishCandidates;
  const verifyGitHubPackOwnership =
    dependencies.verifyGitHubPackOwnership ?? defaultVerifyGitHubPackOwnership;
  // Per-handler tracker: one poisoned approved entry logs once (render runs every request) and
  // surfaces a count for /health, instead of flooding logs or 500-ing the public catalog.
  // Declared here (before the return) because the helpers below are hoisted declarations.
  const reportedCatalogIssues = new Set<string>();
  let healthCache: { at: number; ok: boolean } | null = null;

  async function fetch(request: Request) {
    let response: Response;
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        response = await serveHealth();
      } else if (request.method === "GET" && url.pathname === "/registry.toml") {
        response = await serveRuntimeRegistryToml();
      } else if (request.method === "GET" && url.pathname === "/catalog.json") {
        response = await serveRuntimeCatalogJson();
      } else if (request.method === "GET" && url.pathname === "/staff") {
        // Internal staff entry: straight to Gas City SSO (kc_idp_hint=staff IdP). Not linked
        // from the product UI — staff bookmark it; the customer login stays GitHub-only.
        response = await startLogin(request, config, { staff: true });
      } else if (url.pathname.startsWith("/api/")) {
        response = await handleApi(request);
      } else {
        response = await serveStatic(url);
      }
    } catch (error) {
      if (error instanceof AuthError || error instanceof RequestError) {
        response = errorJson(error.status, error.code, error.message);
      } else if (error instanceof StoreValidationError) {
        response = errorJson(error.status, error.code, error.message);
      } else if (error instanceof StoreConflictError) {
        response = errorJson(error.status, error.code, error.message);
      } else if (error instanceof PublishRequestValidationError) {
        response = errorJson(error.status, error.code, error.message);
      } else {
        console.error("[registry] unhandled request error", error);
        response = errorJson(500, "INTERNAL_ERROR", "Internal server error.");
      }
    }
    return withSecurityHeaders(response, config);
  }

  return fetch;

async function handleApi(request: Request) {
  assertOrigin(request, config);
  const url = new URL(request.url);
  const apiTokenAuth = await getRequestApiTokenAuth(
    request,
    store,
    config,
    dependencies.verifyRegistryEiaToken,
  );
  const session = apiTokenAuth ? null : await getRequestSession(request, store);

  if (request.method === "GET" && url.pathname === "/api/me") {
    return json({
      user: session?.user ?? apiTokenAuth?.user ?? null,
      csrfToken: session?.csrfToken ?? null,
      authConfigured: Boolean(config.authProvider),
      authProvider: config.authProvider ?? null,
      devAuthEnabled: config.devAuthEnabled,
      store: store.kind,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/auth/login") {
    enforceRateLimit(request, "auth-login", { windowMs: 10 * 60 * 1000, max: 30 });
    return await startLogin(request, config);
  }
  if (request.method === "GET" && url.pathname === "/api/auth/callback") {
    enforceRateLimit(request, "auth-callback", { windowMs: 10 * 60 * 1000, max: 60 });
    return await finishLogin(request, config, store);
  }
  // Dev-only session backdoor: registered ONLY when dev auth is enabled, which
  // loadConfig() forces false in production (REGISTRY_DEV_AUTH=1 && !isProduction).
  // So in prod the route is absent (falls through to 404) AND createDevSession's
  // own guard 404s — defense in depth. See server/dev-session.test.ts.
  if (config.devAuthEnabled && request.method === "GET" && url.pathname === "/api/dev/sign-in") {
    // Dev-only route (unreachable off a loopback dev box), so a generous cap: parallel e2e
    // runs share one loopback bucket and would otherwise 429 under retries.
    enforceRateLimit(request, "dev-sign-in", { windowMs: 10 * 60 * 1000, max: 500 });
    return await createDevSession(request, config, store);
  }
  // Dev-only ownership seed: binds the signed-in dev user to a source repo the way the
  // GitHub App claim flow would (upsertVerifiedPackOwnership), so out-of-process e2e can
  // set up an approvable claim-only publish without a real GitHub App. Same devAuthEnabled
  // gating as /api/dev/sign-in (absent -> 404 in prod).
  if (config.devAuthEnabled && request.method === "POST" && url.pathname === "/api/dev/seed-ownership") {
    requireCsrf(request, session);
    const body = await readJsonBody<{ repoUrl?: string; packKey?: string }>(request, 4 * 1024);
    const repository = parseGitHubRepositoryUrl(body.repoUrl ?? "");
    const ownership = await store.upsertVerifiedPackOwnership(session!.user.id, {
      packKey: body.packKey?.trim() || `${repository.owner}--${repository.name}`,
      sourceUrl: `https://github.com/${repository.fullName}/tree/main`,
      githubRepositoryId: `dev-repo-${repository.fullName}`,
      githubRepositoryFullName: repository.fullName,
      githubRepositoryName: repository.name,
      githubOwnerId: `dev-owner-${repository.owner}`,
      githubOwnerLogin: repository.owner,
      githubOwnerType: "User",
      verificationMethod: "manual",
    });
    return json({ ownership }, { status: 201 });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    if (session) requireCsrf(request, session);
    return await clearSession(request, config, store);
  }

  if (request.method === "POST" && url.pathname === "/api/cli/auth/token") {
    requireCsrf(request, session);
    enforceRateLimit(request, "cli-auth-token", { windowMs: 60 * 60 * 1000, max: 10 }, session);
    const body = await readJsonBody<{ label?: string; redirectUri?: string; redirect_uri?: string; state?: string }>(
      request,
      4 * 1024,
    );
    const redirectUri = validateCliLoopbackRedirectUri(body.redirectUri ?? body.redirect_uri);
    const state = typeof body.state === "string" ? body.state.trim() : "";
    if (!state || state.length > 256) {
      throw new RequestError(422, "VALIDATION_ERROR", "CLI auth state is required.");
    }
    const token = await store.createApiToken(session!.user.id, {
      label: body.label || "GC CLI browser login",
    });
    return json({
      token,
      registryUrl: config.appUrl,
      redirectUri,
      state,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/cli/device/code") {
    enforceRateLimit(request, "cli-device-code", { windowMs: 10 * 60 * 1000, max: 30 });
    const body = await readJsonBody<{ label?: string }>(request, 4 * 1024);
    const pair = generateCliDeviceCodePair();
    const expiresAt = new Date(Date.now() + CLI_DEVICE_CODE_TTL_MS);
    const created = await store.createCliDeviceCode({
      ...pair,
      label: body.label || "GC CLI device login",
      expiresAt,
      intervalSeconds: CLI_DEVICE_CODE_INTERVAL_SECONDS,
    });
    const uris = buildCliVerificationUris(config, created.userCode);
    return json(
      {
        device_code: created.deviceCode,
        user_code: created.userCode,
        verification_uri: uris.verificationUri,
        verification_uri_complete: uris.verificationUriComplete,
        expires_in: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
        interval: created.intervalSeconds,
      },
      { status: 201 },
    );
  }

  if (request.method === "POST" && url.pathname === "/api/cli/device/token") {
    enforceRateLimit(request, "cli-device-token", { windowMs: 10 * 60 * 1000, max: 240 });
    const body = await readJsonBody<{ device_code?: string; deviceCode?: string }>(request, 4 * 1024);
    const deviceCode = body.device_code ?? body.deviceCode;
    if (!deviceCode) throw new RequestError(400, "INVALID_REQUEST", "Device code is required.");
    const result = await store.pollCliDeviceCode(deviceCode);
    if (result.status === "approved") {
      return json({
        access_token: result.token.token,
        token_type: "bearer",
        scope: "registry:publish",
        registry_url: config.appUrl,
      });
    }
    if (result.status === "pending") {
      return json(
        { error: "authorization_pending", interval: result.intervalSeconds },
        { status: 400 },
      );
    }
    if (result.status === "denied") {
      return json({ error: "access_denied" }, { status: 400 });
    }
    return json({ error: "expired_token" }, { status: 400 });
  }

  if (request.method === "POST" && url.pathname === "/api/cli/device/approve") {
    requireCsrf(request, session);
    enforceRateLimit(request, "cli-device-approve", { windowMs: 10 * 60 * 1000, max: 30 }, session);
    const body = await readJsonBody<{ userCode?: string; user_code?: string }>(request, 4 * 1024);
    const userCode = body.userCode ?? body.user_code ?? "";
    await store.approveCliDeviceCode(session!.user.id, userCode);
    return json({ status: "approved" });
  }

  if (request.method === "POST" && url.pathname === "/api/cli/device/deny") {
    requireCsrf(request, session);
    enforceRateLimit(request, "cli-device-deny", { windowMs: 10 * 60 * 1000, max: 30 }, session);
    const body = await readJsonBody<{ userCode?: string; user_code?: string }>(request, 4 * 1024);
    const userCode = body.userCode ?? body.user_code ?? "";
    await store.denyCliDeviceCode(session!.user.id, userCode);
    return json({ status: "denied" });
  }

  if (request.method === "POST" && url.pathname === "/api/publish-tokens/github-actions/mint") {
    enforceRateLimit(request, "github-actions-publish-token", { windowMs: 10 * 60 * 1000, max: 60 });
    const body = await readJsonBody<
      PublishRequestInput & { githubOidcToken?: string; oidcToken?: string }
    >(request, 32 * 1024);
    const identity = await verifyGitHubActionsOidcToken(body.githubOidcToken ?? body.oidcToken ?? "");
    const normalized = assertGitHubActionsCanMintPublishToken(identity, body);
    const user = await store.ensureUser({
      subject: `github-actions:${identity.repositoryId ?? identity.repository.toLowerCase()}`,
      gasCityUserId: `github-actions:${identity.repositoryId ?? identity.repository.toLowerCase()}`,
      handle: `gha-${identity.repository.replace("/", "-")}`,
      displayName: `${identity.repository} GitHub Actions`,
    });
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const constraints: ApiTokenPublishConstraints = {
      repoUrl: normalized.repoUrl,
      commit: normalized.commit,
      packPath: normalized.packPath,
      requestedName: normalized.requestedName,
      requestedVersion: normalized.requestedVersion,
      // Carried from the verified OIDC claims so the submit path can stamp rename-stable
      // source ids on the publish request without trusting its body.
      githubRepositoryId: identity.repositoryId,
      githubOwnerId: identity.repositoryOwnerId,
      // Forensics for the unattended-approval audit row, from the same verified claims. Carried,
      // never compared — see autoApproveReleaseForActor.
      ref: identity.ref,
      eventName: identity.eventName,
    };
    const token = await store.createApiToken(user.id, {
      label: `GitHub Actions ${normalized.requestedName} ${normalized.requestedVersion}`,
      kind: "github_actions_publish",
      expiresAt,
      constraints,
    });
    return json(
      {
        access_token: token.token,
        token_type: "bearer",
        scope: "registry:publish",
        audience: GITHUB_ACTIONS_OIDC_AUDIENCE,
        expires_at: token.expiresAt,
      },
      { status: 201 },
    );
  }

  if (request.method === "GET" && url.pathname === "/api/account/api-tokens") {
    requireCsrf(request, session);
    return json({ tokens: await store.listApiTokens(session!.user.id) });
  }
  if (request.method === "POST" && url.pathname === "/api/account/api-tokens") {
    requireCsrf(request, session);
    enforceRateLimit(request, "api-token-create", { windowMs: 60 * 60 * 1000, max: 10 }, session);
    const body = await readJsonBody<{ label?: string }>(request, 4 * 1024);
    return json(
      { token: await store.createApiToken(session!.user.id, { label: body.label }) },
      { status: 201 },
    );
  }
  const apiTokenMatch = url.pathname.match(/^\/api\/account\/api-tokens\/([^/]+)$/);
  if (request.method === "DELETE" && apiTokenMatch?.[1]) {
    requireCsrf(request, session);
    await store.revokeApiToken(session!.user.id, decodeURIComponent(apiTokenMatch[1]));
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET" && url.pathname === "/api/ownership") {
    const packKey = requirePackKey(url);
    const sourceUrl = requireSourceUrl(url);
    await requirePackSource(packKey, sourceUrl);
    const sourceRepository = parseGitHubSource(sourceUrl);
    const stored = await store.getPackOwnership(packKey);
    // A verification is of a REPOSITORY, not of one commit-pinned URL: a direct pack's catalog
    // `source` moves when its earliest approved release is withdrawn (aggregate.ts writes `source`
    // only when it creates the pack), which is why the row is no longer keyed by source_url.
    // Matching the repo here survives that drift and still refuses a row that belongs to a
    // DIFFERENT repository than the one being asked about — the state left behind when an audited
    // staff re-pin moves a name to a new repo while the old repo's proof row is still on disk.
    const ownership =
      stored &&
      sourceRepository &&
      stored.sourceRepository?.fullName.toLowerCase() === sourceRepository.fullName.toLowerCase()
        ? stored
        : null;
    return json({
      packKey,
      sourceUrl,
      sourceRepository,
      verificationStatus: ownership?.verificationStatus ?? "unverified",
      verificationMethod: ownership?.verificationMethod,
      publisher: ownership?.publisher,
      verifiedAt: ownership?.verifiedAt,
      githubApp: {
        configured: githubAppConfigured(config),
        installUrl: githubAppInstallUrl(config),
        clientId: githubAppClientId(config),
      },
    });
  }
  if (request.method === "POST" && url.pathname === "/api/ownership/github/start") {
    requireCsrf(request, session);
    enforceRateLimit(request, "ownership-start", { windowMs: 15 * 60 * 1000, max: 10 }, session);
    const body = await readJsonBody<{ packKey?: string; sourceUrl?: string }>(request);
    const packKey = body.packKey?.trim();
    const sourceUrl = body.sourceUrl?.trim();
    if (!packKey || !sourceUrl) {
      throw new RequestError(422, "VALIDATION_ERROR", "Pack key and source URL are required.");
    }
    const pack = await requirePackSource(packKey, sourceUrl);
    const sourceRepository = parseGitHubSource(sourceUrl);
    if (!sourceRepository) {
      throw new RequestError(422, "UNSUPPORTED_SOURCE", "Only GitHub source repositories can be verified.");
    }
    const state = signGitHubClaimState(config, {
      userId: session!.user.id,
      packKey,
      sourceUrl,
      redirectTo: `${packRoutePath(pack.name)}#trust`,
    });
    return json({ authorizationUrl: githubAuthorizationUrl(config, state) });
  }
  if (request.method === "POST" && url.pathname === "/api/publish/github/start") {
    requireCsrf(request, session);
    enforceRateLimit(request, "publish-github-start", { windowMs: 15 * 60 * 1000, max: 10 }, session);
    const state = signGitHubPublishImportState(config, {
      userId: session!.user.id,
      redirectTo: "/publish",
    });
    return json({ authorizationUrl: githubAuthorizationUrl(config, state) });
  }
  if (request.method === "GET" && url.pathname === "/api/ownership/github/callback") {
    enforceRateLimit(request, "ownership-callback", { windowMs: 15 * 60 * 1000, max: 30 }, session);
    if (!session) throw new RequestError(401, "UNAUTHENTICATED", "Sign in required.");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      throw new RequestError(400, "BAD_GITHUB_CALLBACK", "GitHub verification callback is incomplete.");
    }
    const publishImportState = tryVerifyGitHubPublishImportState(config, state);
    if (publishImportState) {
      if (publishImportState.userId !== session.user.id) {
        throw new RequestError(403, "BAD_GITHUB_STATE", "GitHub publish state is invalid.");
      }
      const accessToken = await exchangeGitHubCode(config, code);
      const importInput = await discoverGitHubPublishCandidates(accessToken);
      const imported = await store.createGitHubPublishImport(session.user.id, importInput);
      return new Response(null, {
        status: 302,
        headers: {
          // mount-prefixed so the browser lands back in registry, not the apex shell root.
          Location: `${config.mountBase}${publishImportState.redirectTo}?githubImport=${encodeURIComponent(imported.id)}`,
        },
      });
    }
    const claim = verifyGitHubClaimState(config, state);
    if (claim.userId !== session.user.id) {
      throw new RequestError(403, "BAD_GITHUB_STATE", "GitHub verification state is invalid.");
    }
    await requirePackSource(claim.packKey, claim.sourceUrl);
    const sourceRepository = parseGitHubSource(claim.sourceUrl);
    if (!sourceRepository) {
      throw new RequestError(422, "UNSUPPORTED_SOURCE", "Only GitHub source repositories can be verified.");
    }
    const verified = await verifyGitHubPackOwnership(config, code, sourceRepository);
    await store.upsertVerifiedPackOwnership(session.user.id, {
      ...verified,
      packKey: claim.packKey,
      sourceUrl: claim.sourceUrl,
    });
    return new Response(null, {
      status: 302,
      // mount-prefixed so the browser lands back in registry, not the apex shell root.
      headers: { Location: `${config.mountBase}${claim.redirectTo}` },
    });
  }
  if (request.method === "POST" && url.pathname === "/api/github/webhook") {
    const webhook = await validateGitHubWebhook(request, config);
    const revokedRepositoryIds = revokedRepositoryIdsFromWebhook(webhook.event, webhook.payload);
    if (revokedRepositoryIds.length > 0) {
      await store.deletePackOwnershipsForGithubRepositoryIds(
        revokedRepositoryIds,
        `github.${webhook.event}`,
      );
    }
    return new Response(null, { status: 204 });
  }

  const githubPublishImportMatch = url.pathname.match(/^\/api\/publish\/github\/imports\/([^/]+)$/);
  if (request.method === "GET" && githubPublishImportMatch?.[1]) {
    requireCsrf(request, session);
    const imported = await requireGitHubPublishImport(
      session!.user.id,
      decodeURIComponent(githubPublishImportMatch[1]),
    );
    return json({ import: imported });
  }

  const githubPublishSubmitMatch = url.pathname.match(/^\/api\/publish\/github\/imports\/([^/]+)\/submit$/);
  if (request.method === "POST" && githubPublishSubmitMatch?.[1]) {
    requireCsrf(request, session);
    enforceRateLimit(request, "publish-github-submit", { windowMs: 60 * 60 * 1000, max: 20 }, session);
    const imported = await requireGitHubPublishImport(
      session!.user.id,
      decodeURIComponent(githubPublishSubmitMatch[1]),
    );
    const body = await readJsonBody<{
      candidateId?: string;
      requestedName?: string;
      requestedVersion?: string;
      requestedRef?: string;
      requestedDescription?: string;
    }>(request, 8 * 1024);
    const candidate = imported.candidates.find((item) => item.id === body.candidateId);
    if (!candidate) throw new RequestError(422, "VALIDATION_ERROR", "GitHub publish candidate not found.");
    // Repo-proven: the candidate was discovered from a GitHub App installation where
    // the authed user holds push/maintain/admin on the source repo, and its repo/commit
    // come from that verified candidate, not free-form body input.
    const publishRequest = await store.createPublishRequest(
      session!.user.id,
      publishInputFromGitHubCandidate(candidate, body),
      "github_import",
      {
        githubRepositoryId: candidate.repository.id,
        githubOwnerId: candidate.repository.ownerId,
      },
    );
    return publishValidationOutcomeResponse(
      await validateAndStorePublishRequest(publishRequest.id),
      201,
    );
  }

  if (request.method === "POST" && url.pathname === "/api/publish-requests") {
    const actor = requirePublishRequestActor(request, session, apiTokenAuth);
    enforceRateLimit(request, "publish-request-create", { windowMs: 60 * 60 * 1000, max: 20 }, session);
    const body = await readJsonBody<PublishRequestInput>(request, 16 * 1024);
    if (actor.kind === "api_token" && actor.token.constraints) {
      assertPublishTokenAllows(actor.token.constraints, body);
    }
    const publishRequest = await store.createPublishRequest(
      actor.user.id,
      body,
      publishSubmissionMethodForActor(actor),
      publishSourceIdentityForActor(actor),
    );
    if (url.searchParams.get("validate") === "1" || url.searchParams.get("validate") === "true") {
      // A CI re-run of an already-published release: the submitter-scoped dedup returned the
      // approved row, and markPublishRequestValidated's status guard would 422 it. Replay the row
      // instead — an idempotent re-run of a green workflow is not an error.
      if (publishRequest.status === "approved") {
        return json({ publishRequest }, { status: 201 });
      }
      return publishValidationOutcomeResponse(
        await validateAndStorePublishRequest(publishRequest.id, autoApproveReleaseForActor(actor)),
        201,
      );
    }
    return json(publishRequest, { status: 201 });
  }
  if (request.method === "GET" && url.pathname === "/api/account/publish-requests") {
    requireCsrf(request, session);
    return json({ publishRequests: await store.listAccountPublishRequests(session!.user.id) });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/publish-requests") {
    requireCsrf(request, session);
    requireRegistryStaff(session);
    return json({ publishRequests: await store.listPublishRequests() });
  }
  const publishRequestActionMatch = url.pathname.match(
    /^\/api\/publish-requests\/([^/]+)\/(validate|approve|reject|withdraw)$/,
  );
  if (request.method === "POST" && publishRequestActionMatch?.[1] && publishRequestActionMatch[2]) {
    requireCsrf(request, session);
    const id = decodeURIComponent(publishRequestActionMatch[1]);
    const action = publishRequestActionMatch[2];
    const publishRequest = await requirePublishRequestAccess(id, session);
    if (action === "validate") {
      // A terminal request must not re-enter validation — validate is submitter-accessible, so
      // this stops a publisher resurrecting a withdrawn takedown or unpublishing an approved release.
      if (
        publishRequest.status === "approved" ||
        publishRequest.status === "withdrawn" ||
        publishRequest.status === "rejected"
      ) {
        throw new RequestError(409, "PUBLISH_STATE_TERMINAL", "This publish request can no longer be validated.");
      }
      enforceRateLimit(request, "publish-request-validate", { windowMs: 60 * 60 * 1000, max: 12 }, session);
      return publishValidationOutcomeResponse(await validateAndStorePublishRequest(publishRequest.id));
    }
    requireRegistryStaff(session);
    if (action === "approve") {
      const approveBody = await readOptionalJsonBody<{
        ownershipOverrideReason?: string;
        namePinOverrideReason?: string;
      }>(request, 4 * 1024);
      // Two separate keys, deliberately: an ownership override waved through for a plausible
      // "I checked out of band" reason must not silently move a pack name off the repo that owns
      // it. Re-pinning a name is its own decision and needs its own justification.
      const overrideReason = staffOverrideReason(
        approveBody.ownershipOverrideReason,
        "Ownership override reason is too long.",
      );
      const namePinOverrideReason = staffOverrideReason(
        approveBody.namePinOverrideReason,
        "Name re-pin override reason is too long.",
      );
      const decision = await assertPublishRequestCanMerge(publishRequest, {
        ownershipOverrideReason: overrideReason,
        namePinOverrideReason,
      });
      return json({
        publishRequest: await store.approvePublishRequest(session!.user.id, id, decision),
      });
    }
    const body = await readJsonBody<{ reason?: string; releaseNameClaim?: boolean }>(request);
    if (action === "withdraw") {
      // Takedown of an already-approved (served) publish; status approved -> withdrawn, drops from
      // the runtime catalog on the next request. Staff-only (gated by requireRegistryStaff above).
      // releaseNameClaim additionally unclaims the pack name, returning it to the unclaimed pool
      // (bare names stay reserved — releasing one does not make it publishable again).
      return json({
        publishRequest: await store.withdrawPublishRequest(session!.user.id, id, body.reason ?? "", {
          releaseNameClaim: body.releaseNameClaim === true,
        }),
      });
    }
    return json({
      publishRequest: await store.rejectPublishRequest(session!.user.id, id, body.reason ?? ""),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/reviews") {
    const packKey = requirePackKey(url);
    return json(await store.listReviews(packKey, session?.user.id));
  }
  if (request.method === "PUT" && url.pathname === "/api/reviews") {
    requireCsrf(request, session);
    enforceRateLimit(request, "review-write", { windowMs: 60 * 60 * 1000, max: 30 }, session);
    const body = await readJsonBody<ReviewInput>(request);
    return json(await store.upsertReview(session!.user.id, body));
  }
  if (request.method === "DELETE" && url.pathname === "/api/reviews") {
    requireCsrf(request, session);
    enforceRateLimit(request, "review-delete", { windowMs: 60 * 60 * 1000, max: 30 }, session);
    await store.deleteReview(session!.user.id, requirePackKey(url));
    return new Response(null, { status: 204 });
  }
  const reportMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/report$/);
  if (request.method === "POST" && reportMatch?.[1]) {
    requireCsrf(request, session);
    enforceRateLimit(request, "review-report", { windowMs: 60 * 60 * 1000, max: 10 }, session);
    const body = await readJsonBody<{ reason?: string }>(request);
    return json(await store.reportReview(session!.user.id, decodeURIComponent(reportMatch[1]), body.reason ?? ""));
  }

  if (request.method === "GET" && url.pathname === "/api/account/reviews") {
    requireCsrf(request, session);
    return json({ reviews: await store.listAccountReviews(session!.user.id) });
  }
  if (request.method === "PUT" && url.pathname === "/api/account/profile") {
    requireCsrf(request, session);
    enforceRateLimit(request, "profile-write", { windowMs: 60 * 60 * 1000, max: 20 }, session);
    const body = await readJsonBody<{ displayName?: string; handle?: string }>(request);
    return json({
      user: await store.updateUserProfile(session!.user.id, {
        displayName: body.displayName ?? "",
        handle: body.handle,
      }),
    });
  }
  if (request.method === "PUT" && url.pathname === "/api/stars") {
    requireCsrf(request, session);
    enforceRateLimit(request, "star-write", { windowMs: 60 * 60 * 1000, max: 120 }, session);
    const body = await readJsonBody<{ packKey?: string; starred?: boolean }>(request);
    const packKey = body.packKey?.trim();
    if (!packKey) throw new RequestError(422, "VALIDATION_ERROR", "Pack key required.");
    return json(await store.setStar(session!.user.id, packKey, body.starred !== false));
  }

  return errorJson(404, "NOT_FOUND", "Not found.");
}

function requirePackKey(url: URL) {
  const packKey = url.searchParams.get("packKey")?.trim();
  if (!packKey) throw new RequestError(422, "VALIDATION_ERROR", "Pack key required.");
  return packKey;
}

function requireSourceUrl(url: URL) {
  const sourceUrl = url.searchParams.get("sourceUrl")?.trim();
  if (!sourceUrl) throw new RequestError(422, "VALIDATION_ERROR", "Source URL required.");
  return sourceUrl;
}

// Resolve the packKey -> source-repository binding an ownership request asserts, or refuse. This is
// the only thing standing between a client-supplied packKey and a pack_ownerships upsert whose
// primary key is that packKey alone (store.ts, ON CONFLICT (pack_key) DO UPDATE overwrites
// publisher_id and verified_by_user_id), so it is what stops badge spoofing: without it anyone with
// admin on any repo could start the flow with packKey "gascity-packs--bmad" and their own repo as
// the source, prove admin on their own repo, and paint "Verified author" onto a first-party pack.
//
// A packKey lives in exactly one of two disjoint universes and each has its own authority.
async function requirePackSource(packKey: string, sourceUrl: string): Promise<CatalogPackSource> {
  // Base/ingested packs first. The generated artifact is the one document no publisher can write,
  // so a name claim can never override a first-party pack's binding — belt to the braces of the
  // `direct--` prefix test below.
  const base = findCatalogPackSource(await readRuntimeText("catalog.json"), packKey);
  if (base) {
    if (base.source !== sourceUrl) throw packSourceMismatch();
    return base;
  }
  // Community direct publishes. pack_name_claims is the authority, NOT the committed catalog (which
  // never contains a `direct--` key — the bug this replaces, so /api/ownership 422'd for every
  // direct publish) and NOT a runtime render of the merged catalog (this route has no auth, no CSRF
  // and no rate limit, the base artifact is ~428 KB, and the merge is fail-soft, so a dropped pack
  // would silently become a verification failure). It is also the same table the merge gate measures
  // every release against, so the badge and the gate cannot disagree about who owns a name.
  const name = directPackName(packKey);
  const claim = name ? await store.getPackNameClaim(name) : null;
  if (!claim) throw packSourceMismatch();
  // Repo IDENTITY, not a URL string: strictly stronger than comparing a commit-pinned pack.source,
  // and independent of which commit or branch the caller happened to send.
  const repository = parseGitHubSource(sourceUrl);
  if (!repository || repository.fullName.toLowerCase() !== claim.repoFullName.toLowerCase()) {
    throw packSourceMismatch();
  }
  return { packKey, name: claim.name, source: sourceUrl };
}

// `direct--owner--pack` -> `owner/pack`. Inverse of aggregate.ts's flattenName, injective only
// because assertPublishablePackName bans `--` inside a segment. The round-trip re-flatten is what
// makes a non-canonical packKey (a literal `/`, a doubled `--`) fail here instead of writing an
// ownership row under a key getPackOwnership will never be asked for.
function directPackName(packKey: string) {
  const prefix = "direct--";
  if (!packKey.startsWith(prefix)) return null;
  const flat = packKey.slice(prefix.length);
  if (!flat) return null;
  const name = flat.replaceAll("--", "/");
  return `${prefix}${name.replaceAll("/", "--")}` === packKey ? name : null;
}

function packSourceMismatch() {
  return new RequestError(422, "VALIDATION_ERROR", "Pack source does not match the catalog.");
}

function requireRegistryStaff(session: SessionRecord | null) {
  if (!session) throw new RequestError(401, "UNAUTHENTICATED", "Sign in required.");
  if (session.user.role !== "admin" && session.user.role !== "moderator") {
    throw new RequestError(403, "FORBIDDEN", "Registry staff access required.");
  }
}

function requirePublishRequestActor(
  request: Request,
  session: SessionRecord | null,
  apiTokenAuth: ApiTokenAuthResult | null,
) {
  if (apiTokenAuth) {
    return { kind: "api_token" as const, user: apiTokenAuth.user, token: apiTokenAuth };
  }
  if (session) {
    requireCsrf(request, session);
    return { kind: "session" as const, user: session.user };
  }
  throw new RequestError(401, "UNAUTHENTICATED", "Sign in required.");
}

// Derive the repo-proof provenance of a /api/publish-requests submission from its
// trusted auth context (NOT the request body). A github_actions_publish token is minted
// only after OIDC repo+commit verification; personal tokens and browser sessions are
// claim-only.
function publishSubmissionMethodForActor(
  actor: ReturnType<typeof requirePublishRequestActor>,
): PublishSubmissionMethod {
  if (actor.kind === "session") return "web_session";
  // Only treat a CI token as repo-proven when it carries the OIDC-minted repo+commit
  // constraints (enforced at submit by assertPublishTokenAllows). A github_actions_publish
  // token is always minted with constraints; the guard fails closed to claim-only if one
  // ever isn't, so the repo-proven stamp can never outrun its repo binding.
  if (actor.token.kind === "github_actions_publish" && actor.token.constraints) {
    return "github_actions_oidc";
  }
  return "api_token";
}

// The unattended-approval credential, and the whole reason auto-approve is not keyed on a stored
// column. Its EXISTENCE is the authorization; there is nothing to forge and nothing to replay,
// because it is produced from the auth context of the request that carries the OIDC-minted,
// single-release-scoped publish token (assertPublishTokenAllows has already pinned the body to that
// token's exact repo/commit/name/version tuple), and it is passed BY VALUE into the one validation
// that request performs. It is never persisted.
//
// That is load-bearing, not stylistic. markPublishRequestValidated admits `pending_review` and
// leaves it `pending_review`, and POST /api/publish-requests/:id/validate is submitter-accessible.
// Key auto-approve on a persisted flag or on submissionMethod alone and this works: queue a
// malicious @2.0 while the name is unclaimed (it parks), wait for staff to approve a clean @1.0
// (which mints the claim), then re-validate @2.0 and it merges unread. Staff approving ONE queued
// item would silently arm every other queued item for that name. A later /validate call cannot
// synthesize one of these, which is what keeps a parked request staff-only forever.
type AutoApproveRelease = { ref?: string; eventName?: string };

function autoApproveReleaseForActor(
  actor: ReturnType<typeof requirePublishRequestActor>,
): AutoApproveRelease | undefined {
  if (actor.kind !== "api_token") return undefined;
  // Exactly the actor shape publishSubmissionMethodForActor calls `github_actions_oidc`. An
  // `sts_eia` or `personal` token falls through here, fail-closed.
  if (actor.token.kind !== "github_actions_publish" || !actor.token.constraints) return undefined;
  // Forensics only, from verified OIDC claims. NOT an admission input.
  return { ref: actor.token.constraints.ref, eventName: actor.token.constraints.eventName };
}

// The rename-stable GitHub ids to stamp on the request, taken from the same trusted context.
// Only an OIDC-minted CI token carries them; a browser session or personal token asserts a
// repo URL and nothing more, so it pins nothing.
function publishSourceIdentityForActor(
  actor: ReturnType<typeof requirePublishRequestActor>,
): PublishSourceIdentity {
  if (actor.kind === "session" || actor.token.kind !== "github_actions_publish") return {};
  return {
    githubRepositoryId: actor.token.constraints?.githubRepositoryId,
    githubOwnerId: actor.token.constraints?.githubOwnerId,
  };
}

// A staff override justification from an approve body: trimmed, length-bounded, and normalized
// to undefined when blank so the gate treats "" the same as absent.
function staffOverrideReason(value: unknown, tooLongMessage: string) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length > 500) throw new RequestError(422, "VALIDATION_ERROR", tooLongMessage);
  return trimmed || undefined;
}

function assertPublishTokenAllows(
  constraints: ApiTokenPublishConstraints,
  input: PublishRequestInput,
) {
  const normalized = normalizePublishRequestInput(input);
  if (
    normalized.repoUrl !== constraints.repoUrl ||
    normalized.commit !== constraints.commit ||
    normalized.packPath !== constraints.packPath ||
    normalized.requestedName !== constraints.requestedName ||
    normalized.requestedVersion !== constraints.requestedVersion
  ) {
    throw new RequestError(
      403,
      "PUBLISH_TOKEN_SCOPE_DENIED",
      "Registry publish token is scoped to a different package, version, repository, or commit.",
    );
  }
}

async function requirePublishRequestAccess(id: string, session: SessionRecord | null) {
  if (!session) throw new RequestError(401, "UNAUTHENTICATED", "Sign in required.");
  const publishRequest = await store.getPublishRequest(id);
  if (!publishRequest) throw new RequestError(404, "NOT_FOUND", "Publish request not found.");
  if (
    publishRequest.submittedBy.id !== session.user.id &&
    session.user.role !== "admin" &&
    session.user.role !== "moderator"
  ) {
    throw new RequestError(403, "FORBIDDEN", "Publish request access denied.");
  }
  return publishRequest;
}

async function requireGitHubPublishImport(userId: string, id: string) {
  const imported = await store.getGitHubPublishImport(userId, id);
  if (!imported) throw new RequestError(404, "NOT_FOUND", "GitHub publish import not found or expired.");
  return imported;
}

type PublishValidationFailure = {
  status: number;
  code: string;
  message: string;
};

type PublishValidationOutcome = {
  publishRequest: PublishRequestRow;
  failure?: PublishValidationFailure;
};

function publishValidationOutcomeResponse(
  outcome: PublishValidationOutcome,
  successStatus = 200,
) {
  if (outcome.failure) {
    return json(
      {
        error: {
          code: outcome.failure.code,
          message: outcome.failure.message,
        },
        // Validation happens after create, so a failure is still a durable request. Returning the
        // row alongside the non-2xx error lets browser clients render/retry it while scripts can
        // finally trust the HTTP status.
        publishRequest: outcome.publishRequest,
      },
      { status: outcome.failure.status },
    );
  }
  return json({ publishRequest: outcome.publishRequest }, { status: successStatus });
}

async function validateAndStorePublishRequest(
  id: string,
  release?: AutoApproveRelease,
): Promise<PublishValidationOutcome> {
  const publishRequest = await store.getPublishRequest(id);
  if (!publishRequest) throw new RequestError(404, "NOT_FOUND", "Publish request not found.");
  // Read BEFORE validation, because markPublishRequestValidated overwrites it. Auto-approve clause
  // (3) needs the pre-state: `pending_review` re-validates to `pending_review`.
  const priorStatus = publishRequest.status;
  let validated: PublishRequestRow;
  try {
    const entry = await validatePublishRequest(publishRequest, config);
    validated = await store.markPublishRequestValidated(id, entry);
  } catch (error) {
    const message =
      error instanceof RequestError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Publish request validation failed.";
    if (!(error instanceof RequestError)) {
      console.error("[registry] publish validation failed", error);
    }
    const failure: PublishValidationFailure =
      error instanceof RequestError
        ? { status: error.status, code: error.code, message }
        : { status: 500, code: "PUBLISH_VALIDATION_FAILED", message };
    return {
      publishRequest: await store.markPublishRequestValidationFailed(id, message),
      failure,
    };
  }
  // OUTSIDE that catch, deliberately: inside it, any bug in approval would mark a perfectly valid
  // release `validation_failed` and tell the publisher their pack is broken.
  return { publishRequest: await tryAutoApprove(validated, priorStatus, release) };
}

// Why a refusal is never an error: the row stays `pending_review`, which is the pre-bead outcome
// for every release. Nothing a publisher can do makes this path fail their publish.
type AutoApproveRefusal =
  | "disabled"
  | "no_release_context"
  | "requeued"
  | "request_ids_missing"
  | "claim_missing"
  | "claim_ids_missing"
  | "no_served_precedent"
  | "pack_path_changed"
  | "withdrawn_history"
  | "staff_refused"
  | "gate_refused"
  | "rate_limited";

// Unattended approval of a REPEAT release. The human stays in the loop for the first publish of a
// name — that is the decision that creates a namespace entry — and for everything the queue has
// already seen.
//
// LEGALITY is delegated wholesale to assertPublishRequestCanMerge at (10) with BOTH override slots
// empty, so an auto-approval is provably a subset of what a staff member could approve with no
// override. The clauses below decide only whether a human is REQUIRED.
async function tryAutoApprove(
  validated: PublishRequestRow,
  priorStatus: PublishRequestStatus,
  release: AutoApproveRelease | undefined,
): Promise<PublishRequestRow> {
  // The reason is the observable of WHICH clause refused, and the counts are how ops watch the
  // rollout (a flood of no_release_context / claim_ids_missing is the expected steady state before
  // publishers adopt OIDC). The integration tests assert it for the same reason: without it two
  // clauses that both end in "stays pending_review" could not be killed independently.
  const decline = async (reason: AutoApproveRefusal) => {
    console.info(
      `[registry] auto-approve declined ${validated.id} (${validated.requestedName}): ${reason}`,
    );
    return validated;
  };

  // (1) Global kill switch, fail-closed: anything but an explicit true is off.
  if (config.publishAutoApprove !== true) return decline("disabled");

  // (2) The single-request OIDC release context. This IS the submission-method check: the context is
  //     produced from exactly the actor shape that makes publishSubmissionMethodForActor return
  //     "github_actions_oidc", so re-testing submissionMethod here would be unreachable code no test
  //     could kill. Excludes a leaked personal gcr_ token, a stolen browser session, an sts_eia
  //     bearer, an immortal github_import row re-validated after the GitHub permission was revoked,
  //     and both claim-only gate escape hatches (verified_repo_ownership, org_member) — none of
  //     which prove the release came from the repo AT THIS MOMENT.
  if (!release) return decline("no_release_context");

  // (3) FIRST validation only. pending_review re-validates to pending_review, so without this a row
  //     a staff member has parked — or one the rate limit deferred — could be re-rolled through
  //     auto-approve by its own submitter. A validation_failed row is corrected by SUPERSEDING it,
  //     which lands a fresh pending_validation row.
  if (priorStatus !== "pending_validation") return decline("requeued");

  // (4) Both rename-stable ids on the request. GitHub's repository_id / repository_owner_id are
  //     OPTIONAL claims, so a repo-proven request can arrive pinned only by case-folded full name,
  //     which a transfer or a re-registered owner login can move. Staff may still approve that;
  //     automation may not, because it is what forces the claim comparison onto numeric ids.
  if (!validated.sourceGithubRepositoryId || !validated.sourceGithubOwnerId) {
    return decline("request_ids_missing");
  }

  // (5) The name must ALREADY be claimed. This is what keeps the first publish of a NEW name
  //     human-reviewed: H1a inside the gate reserves only BARE names, so a brand-new SCOPED name
  //     from a proven repo passes the gate on its own.
  const claim = await store.getPackNameClaim(validated.requestedName);
  if (!claim) return decline("claim_missing");

  // (6) The claim must know both ids too. (4)+(6) together force nameClaimMatchesRequest onto
  //     NUMERIC IDS ONLY, never a login or a mutable full name. No id EQUALITY is compared here,
  //     deliberately: with both sides' ids present, H2 inside the gate has already refused every
  //     mismatch and no namePinOverrideReason is supplied, so an equality check here would be
  //     unreachable. This is also what excludes the grandfathered claim-only packs.
  //     `claim?.` rather than `claim.`: the two clauses stay independently revertible.
  if (!claim?.githubRepositoryId || !claim?.githubOwnerId) return decline("claim_ids_missing");

  // (7) A currently-SERVED release of this name must exist. NOT implied by (5): withdraw drops the
  //     claim only on an explicit releaseNameClaim, so a pack whose entire history was taken down
  //     keeps its claim. This is the per-pack kill switch — withdraw every release and the next one
  //     goes back to a human.
  const precedent = await store.getServedPublishPrecedent(validated.requestedName);
  if (!precedent) return decline("no_served_precedent");

  // (8) Same pack directory as the served release. validatePublishRequestForRegistry already binds
  //     path -> name, so a path change is reachable only when the repo holds two directories
  //     declaring the same pack name — and then the path is the only thing choosing which bits ship.
  //     A legitimate monorepo move costs one staff approval, which re-establishes the precedent;
  //     dropping this clause would let a repo co-maintainer point an established name at different
  //     bits with no human ever seeing that they moved.
  if (precedent?.packPath !== validated.packPath) return decline("pack_path_changed");

  // (9) Never auto-approve a name staff have EVER said no to. NAME-scoped, not version-scoped: H4 is
  //     (name, version)-scoped AND content-swap-scoped, so a refusal of 1.0.0 for malware stops
  //     neither an identical-bits 1.0.0 (H4 permits that as the staff-gated reinstatement path) nor a
  //     1.0.1 carrying the same payload. Lineage-filtered so a name legitimately re-issued to a
  //     different repo after releaseNameClaim is not quarantined forever.
  //     NOTE FOR FUTURE READERS: this is strictly broader than H4 within the auto-approve path, so
  //     H4 is unreachable HERE. It stays reachable and tested on the staff approve route. Do not
  //     "simplify" this clause into H4.
  const refused = await store.listStaffRefusedPublishRequestsForName(validated.requestedName);
  // H4's lineage predicate, but FAILING CLOSED on the id-less row. Every web_session / api_token
  // row is id-less (publishSourceIdentityForActor returns {} for them), which is the ordinary shape
  // of every pre-OIDC release, and sameSourceRepository then falls back to the case-folded repo full
  // name — which a repo RENAME moves while the numeric id it should have been measured against does
  // not. Clause (4) has already guaranteed the INCOMING request carries both ids, so this reads as
  // "if the refused row cannot answer in numeric ids, automation cannot argue it into a different
  // lineage — send it to a human." Same direction, and for the same reason, as H2's own fail-closed
  // in assertPublishRequestCanMerge below ("the currency the pin is written in").
  // Inside auto-approve a false positive costs one staff click; in H4 it would permanently burn a
  // version number for the real owner, which is why H4 keeps the open fallback (registry-tr1).
  const sameLineage = (row: PublishRequestRow) =>
    !row.sourceGithubRepositoryId ||
    sameSourceRepository(row, validated) ||
    row.submittedBy.id === validated.submittedBy.id;
  // Two refusals, not one, so a takedown and a queue rejection stay independently killable — and so
  // ops can tell "this pack was taken down" from "staff read these bits and refused them".
  if (refused.some((row) => row.status === "withdrawn" && sameLineage(row))) {
    return decline("withdrawn_history");
  }
  if (refused.some((row) => row.status === "rejected" && sameLineage(row))) {
    return decline("staff_refused");
  }

  // (10) THE STAFF GATE, UNCHANGED, LAST, NO OVERRIDES. PUBLISH_NAME_RESERVED /
  //      PUBLISH_SCOPE_MISMATCH / PUBLISH_NAME_OWNER_MISMATCH / PUBLISH_VERSION_WITHDRAWN /
  //      PUBLISH_CONFLICT all still bind. A refusal is a queue entry, not a 500; anything that is
  //      NOT a refusal is a bug and must surface.
  let decision: PublishApprovalDecision;
  try {
    decision = await assertPublishRequestCanMerge(validated, {});
  } catch (error) {
    if (
      error instanceof RequestError ||
      error instanceof StoreConflictError ||
      error instanceof StoreValidationError
    ) {
      console.warn(`[registry] auto-approve gate refused ${validated.id}: ${error.message}`);
      return decline("gate_refused");
    }
    throw error;
  }

  // (11) Backstop, consumed LAST so a gate-refused release never burns a token. Keyed on the pack
  //      NAME: server-derived, and the name is what a runaway CI hammers (the create limit keys on
  //      the client address for token actors, and CI egress pools rotate). Degrades to staff review
  //      rather than 429 — the publish is valid, only the automation is suspect.
  if (
    !tryConsumeRateLimit(`publish-auto-approve:${validated.requestedName}`, {
      windowMs: 60 * 60 * 1000,
      max: 10,
    })
  ) {
    return decline("rate_limited");
  }

  try {
    return await store.autoApprovePublishRequest(validated.id, {
      ...decision,
      autoApprove: { precedentRequestId: precedent.id, ref: release.ref, eventName: release.eventName },
    });
  } catch (error) {
    // The approve transaction re-checks the claim under the per-name advisory lock and can lose that
    // race. Re-READ rather than returning the stale pre-approve row.
    console.warn(`[registry] auto-approve failed ${validated.id}:`, error);
    return (await store.getPublishRequest(validated.id)) ?? validated;
  }
}

// The publish-approval merge gate. Returns the audit decision (the consumed override reasons and
// the bases they satisfied) for the caller to thread into approvePublishRequest.
//
// Order, and why: (1) validated; (2) repo control; (3) bare names reserved; (4) scope == the
// proven repo owner; (5) the name's existing claim must match; (6) withdrawn name@version guard;
// (7) aggregate dry run. 3-5 come after 2 because they are all measured against the repo that
// step 2 proved — checking a name against an unproven repo would prove nothing.
async function assertPublishRequestCanMerge(
  publishRequest: Awaited<ReturnType<typeof store.getPublishRequest>>,
  overrides: { ownershipOverrideReason?: string; namePinOverrideReason?: string },
): Promise<PublishApprovalDecision> {
  if (!publishRequest?.registryEntry) {
    throw new RequestError(422, "PUBLISH_NOT_VALIDATED", "Publish request must be validated before approval.");
  }
  const overrideReason = overrides.ownershipOverrideReason;

  // Path-aware ownership gate. Open self-registration turns the approval queue into a
  // security boundary, so approve requires proof that the submitter controls the source
  // repo: a repo-proven submission path (GitHub Actions OIDC / GitHub import), a verified
  // pack-ownership record for the repo, or an explicit audited staff override. An unknown
  // submission method is treated as claim-only (fail-closed).
  const method = publishRequest.submissionMethod;
  const repoProven = method === "github_actions_oidc" || method === "github_import";
  let ownershipDecision: PublishApprovalDecision = { ownershipBasis: "repo_proven" };
  // WHICH repo the submitter actually proved, when the basis is a verified ownership row. H2 needs
  // it below: the row is found by a mutable full name, so the name it matched is not proof that it
  // is the repo the name claim is pinned to.
  let provenRepositoryId: string | null = null;
  if (!repoProven) {
    provenRepositoryId = await store.verifiedRepoOwnershipRepositoryId(
      publishRequest.submittedBy.id,
      publishRequest.repository.fullName,
    );
    if (provenRepositoryId) {
      ownershipDecision = { ownershipBasis: "verified_repo_ownership" };
    } else if (await store.isOrgMember(publishRequest.submittedBy.id)) {
      // Verified @gascity org members (registry-member realm role, live-synced at login)
      // publish their own claim-only submissions without a per-repo ownership record or an
      // override. PUBLISHER-only: grants nothing on the staff/moderation surface, and staff
      // approval remains in the loop (D2a).
      ownershipDecision = { ownershipBasis: "org_member" };
    } else if (overrideReason) {
      ownershipDecision = { ownershipBasis: "override", ownershipOverrideReason: overrideReason };
    } else {
      throw new RequestError(
        403,
        "OWNERSHIP_NOT_VERIFIED",
        "Publish request lacks proof of source-repository ownership. Submit via GitHub Actions or GitHub import, verify pack ownership, or supply an ownershipOverrideReason to override.",
      );
    }
  }

  // The namespace gate (H1a/H1b/H2). The name checked here is requestedName, not
  // registryEntry.name: requestedName is what the store keys the claim by, so measuring anything
  // else could pass the gate for one name and pin another.
  const requestedName = publishRequest.requestedName;
  const scope = packNameScope(requestedName);
  const repoOwnerLogin = publishRequest.repository.owner.toLowerCase();
  const claim = await store.getPackNameClaim(requestedName);

  // H1a — bare (unscoped) names are reserved. They are the base/ingested half of the namespace,
  // and the only bare names a publish may use are the ones already claimed when this gate
  // shipped (the closed grandfathered set). No staff bypass exists on purpose: first-party packs
  // arrive through sources.toml ingest, never through publish, so a bypass would only ever be
  // used to hand out a reserved name.
  if (!scope && !claim) {
    throw new RequestError(
      403,
      "PUBLISH_NAME_RESERVED",
      `Unscoped pack names are reserved. Publish ${requestedName} as ${repoOwnerLogin}/${requestedName} instead.`,
    );
  }

  // H1b — a scoped name's scope must be the GitHub owner of the source repo, case-folded. Step 2
  // already proved control of that repo, and proving repo control IS proving scope control, so
  // this needs no separate verification flow.
  if (scope && scope !== repoOwnerLogin) {
    throw new RequestError(
      403,
      "PUBLISH_SCOPE_MISMATCH",
      `Pack name scope ${JSON.stringify(scope)} does not match the source repository owner ${JSON.stringify(publishRequest.repository.owner)}.`,
    );
  }

  // H2 — the name's existing claim pins it to a REPO (not a person, so teammates can cut
  // releases). A mismatch is a takeover attempt; staff can authorize an audited RE-PIN instead,
  // which is the legitimate repo-migration path.
  //
  // FAIL CLOSED when the request cannot answer the pin in the currency the pin is written in. A
  // claim that carries a numeric repository id was pinned by a repo-proven release; a submission
  // that carries none (session, personal token, EIA) can only be measured against the claim's
  // mutable repoFullName. Letting it fall back to that string means DOWNGRADING the submission
  // method defeats the id pin: the same release refused 409 over OIDC (ids compared, mismatch)
  // re-lands over a personal token (no ids, case-folded name compare, match) with nothing typed.
  // Scoped to verified_repo_ownership because that is the basis this change newly made reachable
  // for community repos — before it, clearing step 2 without an override REQUIRED a repo-proven
  // method, and those always stamp ids, so the fallback was unreachable on approvable traffic.
  // org_member and override are deliberately untouched: no pre-existing path tightens here.
  //
  // A claim with NO ids still falls back to the name compare exactly as today, which is what keeps
  // the grandfathered claim-only packs (cacc-twin-team) publishing. And a submitter who proved the
  // very repo the claim is pinned to is not refused — the proof and the pin name the same id.
  //
  // The sourceGithubRepositoryId term is belt-and-braces, not load-bearing: it cannot be false while
  // the basis is verified_repo_ownership, because only repo-proven methods stamp ids on a request
  // and those never reach this basis. Kept so the shape being closed is legible, and so a future
  // submission path that stamps ids without proving a repo cannot quietly re-open it.
  const unprovenNamePin =
    ownershipDecision.ownershipBasis === "verified_repo_ownership" &&
    claim?.githubRepositoryId != null &&
    publishRequest.sourceGithubRepositoryId == null &&
    claim.githubRepositoryId !== provenRepositoryId;
  let namePinDecision: Pick<PublishApprovalDecision, "namePinOverrideReason"> = {};
  if (claim && (unprovenNamePin || !nameClaimMatchesRequest(claim, publishRequest))) {
    if (!overrides.namePinOverrideReason) {
      throw new RequestError(
        409,
        "PUBLISH_NAME_OWNER_MISMATCH",
        `${requestedName} is claimed by ${claim.repoFullName}; releases must come from that repository. Supply a namePinOverrideReason to re-pin the name (repo migration).`,
      );
    }
    namePinDecision = { namePinOverrideReason: overrides.namePinOverrideReason };
  }

  // H4 — a withdrawn (taken-down) name@version must not be silently re-published with DIFFERENT
  // provenance: pinned clients would otherwise get swapped bits. An IDENTICAL commit+hash+ref is
  // allowed and is the staff-gated reinstatement path (a fresh, fully-audited approval).
  //
  // Scoped to the SAME LINEAGE (same repo, or same submitter) rather than globally on
  // (name, version). Globally, anyone who could get one publish approved and then taken down
  // permanently burned that version number for the real owner — a denial of service on every
  // future release of a pack they do not own. Content-swap protection only ever mattered within
  // a lineage anyway: the bits a takedown was about are that lineage's bits.
  //
  // The version lookup is a BYTE compare (requested_version = $1), so it is total only because
  // releaseVersionPattern admits one spelling per version. That holds for everything minted after
  // that grammar tightened; it does NOT retroactively canonicalize rows already stored. A
  // withdrawn row persisted as `0.1` or `00.1.0` is still invisible to the canonical `0.1.0`
  // lookup, so the deploy that ships the tightened grammar has to canonicalize or reject any
  // pre-existing non-canonical requested_version first. Fixing that in code would mean comparing
  // semantically here, which is the deferrable belt-and-braces option, not this guard's job.
  const entry = publishRequest.registryEntry;
  const withdrawnConflict = (
    await store.listWithdrawnPublishRequestsForVersion(entry.name, entry.release.version)
  ).find(
    (w) =>
      w.registryEntry != null &&
      (sameSourceRepository(w, publishRequest) || w.submittedBy.id === publishRequest.submittedBy.id) &&
      (w.registryEntry.release.commit !== entry.release.commit ||
        w.registryEntry.release.hash !== entry.release.hash ||
        w.registryEntry.release.ref !== entry.release.ref),
  );
  if (withdrawnConflict) {
    throw new RequestError(
      409,
      "PUBLISH_VERSION_WITHDRAWN",
      `${entry.name}@${entry.release.version} was withdrawn and can only be reinstated with the identical commit and hash.`,
    );
  }

  const baseToml = await readRuntimeText("registry.toml");
  const approved = await store.listApprovedPublishRequests();
  const merging = [...approved, { ...publishRequest, status: "approved" as const }];
  try {
    renderRegistryTomlWithApprovedPublishes(baseToml, merging, {
      // The dry run has to model the SERVE path exactly. Without the claims the serve path reads,
      // a claim holder whose name an upstream source also declares would 409 here while the merge
      // it is predicting succeeds — an upstream edit silently freezing that pack's releases.
      ...(await catalogRenderContext(merging)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publish request conflicts with the aggregate.";
    throw new RequestError(409, "PUBLISH_CONFLICT", message);
  }
  return { ...ownershipDecision, ...namePinDecision };
}

// Readiness probe: /health resolves only if the backing store can serve queries, so a
// DB-degraded instance fails its healthcheck (the orchestrator won't route to / keep it).
// Cached 5s and bounded by a 2s ping timeout so it stays cheap and never hangs past the probe timeout.
async function serveHealth() {
  const now = Date.now();
  if (!healthCache || now - healthCache.at > 5_000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        store.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("store ping timed out")), 2_000);
        }),
      ]);
      healthCache = { at: now, ok: true };
    } catch (error) {
      healthCache = { at: now, ok: false };
      console.error("[registry] health store ping failed", error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return new Response(
    `${JSON.stringify({
      status: healthCache.ok ? "ok" : "degraded",
      store: store.kind,
      catalogRenderIssues: reportedCatalogIssues.size,
    })}\n`,
    {
      status: healthCache.ok ? 200 : 503,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}

function reportCatalogIssue(surface: "registry.toml" | "catalog.json") {
  return (issue: CatalogRenderIssue) => {
    const key =
      issue.kind === "base"
        ? `${surface}:base:${issue.error.message}`
        : issue.kind === "base-ignored"
          ? `${surface}:base-ignored:${issue.name}`
          : `${surface}:${issue.requestId}:${issue.error.message}`;
    if (reportedCatalogIssues.has(key)) return;
    reportedCatalogIssues.add(key);
    if (issue.kind === "base") {
      console.error(`[registry] ${surface} fail-soft: serving base artifact unmerged`, issue.error);
    } else if (issue.kind === "base-ignored") {
      // The ONLY channel that tells a first-party operator their upstream entry is being ignored:
      // the ingest lane that wrote it has no database and cannot see name claims. Logged at error
      // level and counted in /health's catalogRenderIssues, with both remedies named.
      console.error(
        `[registry] ${surface}: IGNORING ingested pack ${issue.name} from source ${issue.baseRegistry} — that name is claimed by ${issue.claimedBy}, whose approved release is served under it instead (request ${issue.requestId}). Either remove the pack from that source's registry.toml, or hand the name back to ingest by taking the claimed release down (withdraw with releaseNameClaim).`,
      );
    } else {
      console.error(
        `[registry] ${surface} fail-soft: skipped approved publish ${issue.name}@${issue.version} (request ${issue.requestId})`,
        issue.error,
      );
    }
  };
}

// Current claim + publisher attribution for every direct name, in two fixed-size batch reads.
// Claim precedence only consumes bare-name claims today, but publisher attribution applies to the
// normal scoped lane too; retaining the old `!packNameScope(name)` optimization would silently
// classify every modern direct pack as unknown/community. Stable owner-id matching and the
// fail-safe fallback live in the store implementations; aggregate.ts remains DB-free and pure.
async function catalogRenderContext(requests: PublishRequestRow[]) {
  const names = [
    ...new Set(
      requests
        .map((request) => request.registryEntry?.name)
        .filter((name): name is string => typeof name === "string"),
    ),
  ];
  if (names.length === 0) return {};
  const [claims, attributions] = await Promise.all([
    store.listPackNameClaims(names),
    store.listCatalogPublisherAttributions(names),
  ]);
  return {
    nameClaims: new Map(claims.map((claim) => [claim.name, claim])),
    attributions: new Map(
      attributions.map(({ name, publisher, trusted }) => [
        name,
        { publisher, trusted },
      ]),
    ),
  };
}

async function serveRuntimeRegistryToml() {
  const baseToml = await readRuntimeText("registry.toml");
  const approved = await store.listApprovedPublishRequests();
  return new Response(
    renderRegistryTomlWithApprovedPublishes(baseToml, approved, {
      mode: "fail-soft",
      onIssue: reportCatalogIssue("registry.toml"),
      ...(await catalogRenderContext(approved)),
    }),
    { headers: runtimeCatalogHeaders("text/plain; charset=utf-8") },
  );
}

async function serveRuntimeCatalogJson() {
  const baseJson = await readRuntimeText("catalog.json");
  const approved = await store.listApprovedPublishRequests();
  return new Response(
    renderCatalogJsonWithApprovedPublishes(baseJson, approved, {
      mode: "fail-soft",
      onIssue: reportCatalogIssue("catalog.json"),
      ...(await catalogRenderContext(approved)),
    }),
    { headers: runtimeCatalogHeaders("application/json; charset=utf-8") },
  );
}

async function readRuntimeText(fileName: "registry.toml" | "catalog.json") {
  const distFile = Bun.file(new URL(fileName, distRoot));
  if (await distFile.exists()) return distFile.text();
  return Bun.file(new URL(`../public/${fileName}`, import.meta.url)).text();
}

function runtimeCatalogHeaders(contentType: string) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=60",
  };
}

async function serveStatic(url: URL) {
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const relativePath = path === "/" ? "/index.html" : path;
  const fileUrl = new URL(`.${relativePath}`, distRoot);
  if (fileUrl.pathname.startsWith(distRoot.pathname)) {
    const file = Bun.file(fileUrl);
    if (await file.exists()) return fileResponse(file, relativePath);
  }
  return fileResponse(Bun.file(new URL("index.html", distRoot)), "/index.html");
}

}

export function createRegistryServer(dependencies: RegistryAppDependencies) {
  return Bun.serve({
    port: dependencies.config.port,
    fetch: createRegistryFetchHandler(dependencies),
  });
}

function fileResponse(file: Bun.BunFile, path: string) {
  const headers = new Headers();
  const type = contentType(path);
  if (type) headers.set("Content-Type", type);
  if (path === "/registry.toml" || path === "/catalog.json") {
    headers.set("Cache-Control", "public, max-age=60");
  } else if (path === "/index.html") {
    headers.set("Cache-Control", "no-cache");
  } else if (/\.(?:css|js|mjs|ico|svg|png|jpg|jpeg|gif|webp|woff2?)$/i.test(path)) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return new Response(file, { headers });
}

function contentType(path: string) {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".toml":
      return "text/plain; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    default:
      return undefined;
  }
}
