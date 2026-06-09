import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32) {
  return base64Url(randomBytes(bytes));
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function signValue(value: string, secret: string) {
  const signature = createHmac("sha256", secret).update(value).digest();
  return `${value}.${base64Url(signature)}`;
}

export function verifySignedValue(signedValue: string, secret: string) {
  const split = signedValue.lastIndexOf(".");
  if (split <= 0) return null;
  const value = signedValue.slice(0, split);
  const signature = signedValue.slice(split + 1);
  const expected = base64Url(createHmac("sha256", secret).update(value).digest());
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return null;
  if (!timingSafeEqual(left, right)) return null;
  return value;
}

export function base64Url(input: Buffer | Uint8Array | string) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

export function pkceChallenge(verifier: string) {
  return base64Url(createHash("sha256").update(verifier).digest());
}
