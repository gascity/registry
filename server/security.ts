import type { ServerConfig } from "./config";
import { RequestError } from "./http";
import type { SessionRecord } from "./types";

type RateLimitOptions = {
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
  headers.set("X-Frame-Options", "DENY");
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

export function enforceRateLimit(
  request: Request,
  scope: string,
  options: RateLimitOptions,
  session?: SessionRecord | null,
) {
  const now = Date.now();
  if (now >= nextSweepAt) sweepExpiredBuckets(now);

  const actor = session?.user.id ?? clientAddress(request) ?? "unknown";
  const key = `${scope}:${actor}`;
  const current = buckets.get(key);
  if (!current || now >= current.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return;
  }
  if (current.count >= options.max) {
    throw new RequestError(429, "RATE_LIMITED", "Too many requests. Try again later.");
  }
  current.count += 1;
}

function contentSecurityPolicy(config: ServerConfig) {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
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
