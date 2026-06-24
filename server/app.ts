import { extname, normalize } from "node:path";
import {
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
import { requireCatalogPackSource } from "./catalog";
import { PublishRequestValidationError, normalizePublishRequestInput } from "./publish";
import { validatePublishRequestForRegistry } from "./publish-validation";
import { StoreConflictError, StoreValidationError } from "./store";
import { RequestError, assertOrigin, errorJson, json, readJsonBody } from "./http";
import { enforceRateLimit, withSecurityHeaders } from "./security";
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
  PublishRegistryEntry,
  PublishRequestInput,
  PublishRequestRow,
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

  async function fetch(request: Request) {
    let response: Response;
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        response = new Response("ok\n");
      } else if (request.method === "GET" && url.pathname === "/registry.toml") {
        response = await serveRuntimeRegistryToml();
      } else if (request.method === "GET" && url.pathname === "/catalog.json") {
        response = await serveRuntimeCatalogJson();
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
  const apiTokenAuth = await getRequestApiTokenAuth(request, store);
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
    enforceRateLimit(request, "dev-sign-in", { windowMs: 10 * 60 * 1000, max: 20 });
    return await createDevSession(request, config, store);
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
    await requireCatalogPackSource(packKey, sourceUrl);
    const sourceRepository = parseGitHubSource(sourceUrl);
    const ownership = await store.getPackOwnership(packKey, sourceUrl);
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
    const pack = await requireCatalogPackSource(packKey, sourceUrl);
    const sourceRepository = parseGitHubSource(sourceUrl);
    if (!sourceRepository) {
      throw new RequestError(422, "UNSUPPORTED_SOURCE", "Only GitHub source repositories can be verified.");
    }
    const state = signGitHubClaimState(config, {
      userId: session!.user.id,
      packKey,
      sourceUrl,
      redirectTo: `/packs/${encodeURIComponent(pack.name)}#trust`,
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
    await requireCatalogPackSource(claim.packKey, claim.sourceUrl);
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
    const publishRequest = await store.createPublishRequest(
      session!.user.id,
      publishInputFromGitHubCandidate(candidate, body),
    );
    return json(await validateAndStorePublishRequest(publishRequest.id), { status: 201 });
  }

  if (request.method === "POST" && url.pathname === "/api/publish-requests") {
    const actor = requirePublishRequestActor(request, session, apiTokenAuth);
    enforceRateLimit(request, "publish-request-create", { windowMs: 60 * 60 * 1000, max: 20 }, session);
    const body = await readJsonBody<PublishRequestInput>(request, 16 * 1024);
    if (actor.kind === "api_token" && actor.token.constraints) {
      assertPublishTokenAllows(actor.token.constraints, body);
    }
    const publishRequest = await store.createPublishRequest(actor.user.id, body);
    if (url.searchParams.get("validate") === "1" || url.searchParams.get("validate") === "true") {
      return json(await validateAndStorePublishRequest(publishRequest.id), { status: 201 });
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
    /^\/api\/publish-requests\/([^/]+)\/(validate|approve|reject)$/,
  );
  if (request.method === "POST" && publishRequestActionMatch?.[1] && publishRequestActionMatch[2]) {
    requireCsrf(request, session);
    const id = decodeURIComponent(publishRequestActionMatch[1]);
    const action = publishRequestActionMatch[2];
    const publishRequest = await requirePublishRequestAccess(id, session);
    if (action === "validate") {
      enforceRateLimit(request, "publish-request-validate", { windowMs: 60 * 60 * 1000, max: 12 }, session);
      return json(await validateAndStorePublishRequest(publishRequest.id));
    }
    requireRegistryStaff(session);
    if (action === "approve") {
      await assertPublishRequestCanMerge(publishRequest);
      return json({ publishRequest: await store.approvePublishRequest(session!.user.id, id) });
    }
    const body = await readJsonBody<{ reason?: string }>(request);
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

async function validateAndStorePublishRequest(id: string) {
  const publishRequest = await store.getPublishRequest(id);
  if (!publishRequest) throw new RequestError(404, "NOT_FOUND", "Publish request not found.");
  try {
    const entry = await validatePublishRequest(publishRequest, config);
    return { publishRequest: await store.markPublishRequestValidated(id, entry) };
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
    return { publishRequest: await store.markPublishRequestValidationFailed(id, message) };
  }
}

async function assertPublishRequestCanMerge(publishRequest: Awaited<ReturnType<typeof store.getPublishRequest>>) {
  if (!publishRequest?.registryEntry) {
    throw new RequestError(422, "PUBLISH_NOT_VALIDATED", "Publish request must be validated before approval.");
  }
  const baseToml = await readRuntimeText("registry.toml");
  const approved = await store.listApprovedPublishRequests();
  try {
    renderRegistryTomlWithApprovedPublishes(baseToml, [
      ...approved,
      { ...publishRequest, status: "approved" },
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publish request conflicts with the aggregate.";
    throw new RequestError(409, "PUBLISH_CONFLICT", message);
  }
}

async function serveRuntimeRegistryToml() {
  const baseToml = await readRuntimeText("registry.toml");
  const approved = await store.listApprovedPublishRequests();
  return new Response(renderRegistryTomlWithApprovedPublishes(baseToml, approved), {
    headers: runtimeCatalogHeaders("text/plain; charset=utf-8"),
  });
}

async function serveRuntimeCatalogJson() {
  const baseJson = await readRuntimeText("catalog.json");
  const approved = await store.listApprovedPublishRequests();
  return new Response(renderCatalogJsonWithApprovedPublishes(baseJson, approved), {
    headers: runtimeCatalogHeaders("application/json; charset=utf-8"),
  });
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
