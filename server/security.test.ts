import { describe, expect, test } from "bun:test";
import { RequestError } from "./http";
import { enforceRateLimit, tryConsumeRateLimit } from "./security";

// The buckets are module state shared by every test in the process, so each case keys on a fresh
// random scope. A test that reused a key would pass or fail depending on which other test ran first.
function scope(label: string) {
  return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

describe("rate limit buckets", () => {
  test("tryConsumeRateLimit allows up to the cap, then refuses without throwing", () => {
    const key = scope("consume");
    const options = { windowMs: 60_000, max: 3 };
    expect([
      tryConsumeRateLimit(key, options),
      tryConsumeRateLimit(key, options),
      tryConsumeRateLimit(key, options),
    ]).toEqual([true, true, true]);
    // The 4th is refused, and refusal is a RETURN VALUE. The auto-approve backstop degrades a
    // release to staff review on a false; if this threw, a runaway CI loop would get a 429 on a
    // perfectly valid publish instead.
    expect(tryConsumeRateLimit(key, options)).toBe(false);
    expect(tryConsumeRateLimit(key, options)).toBe(false);
  });

  test("tryConsumeRateLimit refills once the window rolls", async () => {
    const key = scope("window");
    const options = { windowMs: 30, max: 1 };
    expect(tryConsumeRateLimit(key, options)).toBe(true);
    expect(tryConsumeRateLimit(key, options)).toBe(false);
    await Bun.sleep(70);
    // A per-process, in-memory backstop: the window rolling is what makes it a backstop rather than
    // a permanent ban.
    expect(tryConsumeRateLimit(key, options)).toBe(true);
  });

  test("tryConsumeRateLimit keys are independent", () => {
    const options = { windowMs: 60_000, max: 1 };
    const first = scope("independent");
    const second = scope("independent");
    expect(tryConsumeRateLimit(first, options)).toBe(true);
    expect(tryConsumeRateLimit(first, options)).toBe(false);
    // One pack name exhausting its window must not defer another pack's release.
    expect(tryConsumeRateLimit(second, options)).toBe(true);
  });

  test("enforceRateLimit still throws 429 at the cap after the refactor", () => {
    const label = scope("http");
    const request = new Request("http://127.0.0.1/api/whatever", {
      headers: { "X-Real-Ip": "203.0.113.7" },
    });
    const options = { windowMs: 60_000, max: 2 };
    enforceRateLimit(request, label, options);
    enforceRateLimit(request, label, options);
    let thrown: unknown;
    try {
      enforceRateLimit(request, label, options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RequestError);
    expect((thrown as RequestError).status).toBe(429);
    expect((thrown as RequestError).code).toBe("RATE_LIMITED");
  });

  test("enforceRateLimit still separates actors by client address", () => {
    const label = scope("http-actor");
    const options = { windowMs: 60_000, max: 1 };
    const from = (ip: string) =>
      new Request("http://127.0.0.1/api/whatever", { headers: { "X-Real-Ip": ip } });
    enforceRateLimit(from("203.0.113.8"), label, options);
    expect(() => enforceRateLimit(from("203.0.113.8"), label, options)).toThrow();
    expect(() => enforceRateLimit(from("203.0.113.9"), label, options)).not.toThrow();
  });
});
