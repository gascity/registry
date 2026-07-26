import { afterEach, expect, test } from "bun:test";
import { ApiError, apiRequest, type PublishRequestRow } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("ApiError carries a durable publish request returned with a validation failure", async () => {
  const publishRequest = {
    id: "request_failed",
    status: "validation_failed",
    requestedName: "acme/pack",
    requestedVersion: "1.2.3",
  } as PublishRequestRow;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "PACK_NAME_MISMATCH",
          message: "pack.toml declares a different name.",
        },
        publishRequest,
      }),
      {
        status: 422,
        headers: { "Content-Type": "application/json" },
      },
    )) as unknown as typeof fetch;

  try {
    await apiRequest("/api/publish-requests?validate=1", { method: "POST" });
    throw new Error("Expected apiRequest to reject.");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("PACK_NAME_MISMATCH");
    expect((error as ApiError).publishRequest).toEqual(publishRequest);
  }
});
