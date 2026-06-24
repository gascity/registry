import type { ServerConfig } from "./config";

export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  maxAge?: number;
  path?: string;
};

export function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers as any);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorJson(status: number, code: string, message: string) {
  return json({ error: { code, message } }, { status });
}

export function redirect(location: string, headers?: Headers) {
  const responseHeaders = headers ?? new Headers();
  responseHeaders.set("Location", location);
  return new Response(null, { status: 302, headers: responseHeaders });
}

export function parseCookies(request: Request) {
  const header = request.headers.get("cookie") ?? "";
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || rawValue.length === 0) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join("=")));
  }
  return cookies;
}

export function appendCookie(headers: Headers, name: string, value: string, options: CookieOptions) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  headers.append("Set-Cookie", parts.join("; "));
}

// Cookies are scoped to the mount so the apex deploy's HttpOnly session is sent
// only to /registry/* — never to the apex shell or sibling products that share
// the works.gascity.com origin. "" standalone -> "/", "/registry" -> "/registry/".
export function cookiePath(config: ServerConfig) {
  return `${config.mountBase || ""}/`;
}

export function clearCookie(headers: Headers, name: string, config: ServerConfig) {
  appendCookie(headers, name, "", {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax",
    maxAge: 0,
    path: cookiePath(config),
  });
}

export async function readJsonBody<T>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
    throw new RequestError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new RequestError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

export function assertOrigin(request: Request, config: ServerConfig) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  // Origin-vs-origin compare (the browser Origin header has no path; appUrl is a
  // bare origin). Same-origin only — the apex frames registry same-origin.
  let ok = false;
  try {
    ok = new URL(origin).origin === new URL(config.appUrl).origin;
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new RequestError(403, "BAD_ORIGIN", "Request origin is not allowed.");
  }
}

export function safeRedirectPath(value: string | null | undefined) {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "https://registry.gascity.com");
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
