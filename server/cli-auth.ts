import { randomInt } from "node:crypto";
import type { ServerConfig } from "./config";
import { randomToken, sha256 } from "./crypto";
import { RequestError } from "./http";

export const CLI_DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
export const CLI_DEVICE_CODE_INTERVAL_SECONDS = 5;

const userCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function generateCliDeviceCodePair() {
  return {
    deviceCode: randomToken(32),
    userCode: generateUserCode(),
  };
}

export function hashCliDeviceCode(value: string) {
  return sha256(value.trim());
}

export function hashCliUserCode(value: string) {
  return sha256(normalizeCliCode(value));
}

export function normalizeCliUserCode(value: string) {
  const normalized = normalizeCliCode(value);
  if (normalized.length !== 8) return normalized;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export function validateCliLoopbackRedirectUri(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RequestError(422, "VALIDATION_ERROR", "CLI redirect URI is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new RequestError(422, "VALIDATION_ERROR", "CLI redirect URI is invalid.");
  }
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname)) {
    throw new RequestError(422, "VALIDATION_ERROR", "CLI redirect URI must use local loopback HTTP.");
  }
  if (!parsed.port) {
    throw new RequestError(422, "VALIDATION_ERROR", "CLI redirect URI must include a loopback port.");
  }
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

export function buildCliVerificationUris(config: ServerConfig, userCode: string) {
  const verificationUri = `${config.appUrl}/cli/device`;
  const complete = new URL(verificationUri);
  complete.searchParams.set("code", userCode);
  return {
    verificationUri,
    verificationUriComplete: complete.toString(),
  };
}

function normalizeCliCode(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function generateUserCode() {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += userCodeAlphabet[randomInt(0, userCodeAlphabet.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
