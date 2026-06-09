import { extname, normalize } from "node:path";
import { loadConfig } from "./config";
import {
  clearSession,
  createDevSession,
  finishLogin,
  getRequestSession,
  requireCsrf,
  startLogin,
  AuthError,
} from "./auth";
import { createStore, StoreValidationError } from "./store";
import { RequestError, assertOrigin, errorJson, json, readJsonBody } from "./http";
import type { ReviewInput } from "./types";

const config = loadConfig();
const store = createStore(config.databaseUrl, config.localDataPath);
await store.init();

const distRoot = new URL("../dist/", import.meta.url);

const server = Bun.serve({
  port: config.port,
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok\n");
      if (url.pathname.startsWith("/api/")) return await handleApi(request);
      return await serveStatic(url);
    } catch (error) {
      if (error instanceof AuthError || error instanceof RequestError) {
        return errorJson(error.status, error.code, error.message);
      }
      if (error instanceof StoreValidationError) {
        return errorJson(error.status, error.code, error.message);
      }
      console.error("[registry] unhandled request error", error);
      return errorJson(500, "INTERNAL_ERROR", "Internal server error.");
    }
  },
});

console.log(
  `[registry] listening on :${server.port} with ${store.kind} store (${config.devAuthEnabled ? "dev auth on" : "dev auth off"})`,
);

process.on("SIGTERM", () => {
  void store.close().finally(() => process.exit(0));
});

async function handleApi(request: Request) {
  assertOrigin(request, config);
  const url = new URL(request.url);
  const session = await getRequestSession(request, store);

  if (request.method === "GET" && url.pathname === "/api/me") {
    return json({
      user: session?.user ?? null,
      csrfToken: session?.csrfToken ?? null,
      authConfigured: Boolean(config.oidc),
      devAuthEnabled: config.devAuthEnabled,
      store: store.kind,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/auth/login") {
    return await startLogin(request, config);
  }
  if (request.method === "GET" && url.pathname === "/api/auth/callback") {
    return await finishLogin(request, config, store);
  }
  if (request.method === "GET" && url.pathname === "/api/dev/sign-in") {
    return await createDevSession(request, config, store);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    if (session) requireCsrf(request, session);
    return await clearSession(request, config, store);
  }

  if (request.method === "GET" && url.pathname === "/api/reviews") {
    const packKey = requirePackKey(url);
    return json(await store.listReviews(packKey, session?.user.id));
  }
  if (request.method === "PUT" && url.pathname === "/api/reviews") {
    requireCsrf(request, session);
    const body = await readJsonBody<ReviewInput>(request);
    return json(await store.upsertReview(session!.user.id, body));
  }
  if (request.method === "DELETE" && url.pathname === "/api/reviews") {
    requireCsrf(request, session);
    await store.deleteReview(session!.user.id, requirePackKey(url));
    return new Response(null, { status: 204 });
  }
  const reportMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/report$/);
  if (request.method === "POST" && reportMatch?.[1]) {
    requireCsrf(request, session);
    const body = await readJsonBody<{ reason?: string }>(request);
    return json(await store.reportReview(session!.user.id, decodeURIComponent(reportMatch[1]), body.reason ?? ""));
  }

  if (request.method === "GET" && url.pathname === "/api/account/reviews") {
    requireCsrf(request, session);
    return json({ reviews: await store.listAccountReviews(session!.user.id) });
  }
  if (request.method === "PUT" && url.pathname === "/api/account/profile") {
    requireCsrf(request, session);
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
