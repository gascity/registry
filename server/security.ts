import type { ServerConfig } from "./config";
import { RequestError } from "./http";
import type { SessionRecord } from "./types";

export type RateLimitOptions = {
  windowMs: number;
  max: number;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateLimitBucket>();
let nextSweepAt = 0;

export function withSecurityHeaders(response: Response, config: ServerConfig) {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", contentSecurityPolicy(config));
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  // SAMEORIGIN (not DENY): the apex cockpit embeds registry as a same-origin
  // iframe "Space". Cross-origin framing (clickjacking) is still blocked — see
  // `frame-ancestors 'self'` in the CSP below, which supersedes this for modern UAs.
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (config.isProduction) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Consume one token from `key`'s window, or report the window exhausted. Split out of
// enforceRateLimit so a non-HTTP backstop can share the same bucket bookkeeping instead of
// growing a second Map: the auto-approve backstop keys on a server-derived pack name, has no
// Request or session to derive an actor from, and must DEGRADE (fall back to staff review)
// rather than 429 a valid publish.
export function tryConsumeRateLimit(key: string, options: RateLimitOptions): boolean {
  const now = Date.now();
  if (now >= nextSweepAt) sweepExpiredBuckets(now);

  const current = buckets.get(key);
  if (!current || now >= current.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return true;
  }
  if (current.count >= options.max) return false;
  current.count += 1;
  return true;
}

export function enforceRateLimit(
  request: Request,
  scope: string,
  options: RateLimitOptions,
  session?: SessionRecord | null,
) {
  const actor = session?.user.id ?? clientAddress(request) ?? "unknown";
  if (!tryConsumeRateLimit(`${scope}:${actor}`, options)) {
    throw new RequestError(429, "RATE_LIMITED", "Too many requests. Try again later.");
  }
}

function contentSecurityPolicy(config: ServerConfig) {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // 'self' so the same-origin apex cockpit can frame registry as a Space;
    // any cross-origin framing is still rejected.
    "frame-ancestors 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self' https://events.gascity.com",
    "form-action 'self'",
  ];
  if (config.isProduction) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

function clientAddress(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    undefined
  );
}

function sweepExpiredBuckets(now: number) {
  nextSweepAt = now + 5 * 60 * 1000;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}
