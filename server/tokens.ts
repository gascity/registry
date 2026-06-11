import { randomToken, sha256 } from "./crypto";

export const API_TOKEN_PREFIX = "gcr_";

export function generateApiToken() {
  const token = `${API_TOKEN_PREFIX}${randomToken(32)}`;
  return {
    token,
    prefix: token.slice(0, 12),
    tokenHash: hashApiToken(token),
  };
}

export function hashApiToken(token: string) {
  return sha256(token.trim());
}

export function parseBearerToken(header: string | null) {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}
