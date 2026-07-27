import { afterEach, expect, test } from "bun:test";
import {
  ApiError,
  apiRequest,
  getAdminPublishRequestFeedback,
  listPublishRequestFeedback,
  type PublishRequestFeedbackDetail,
  type PublishRequestFeedbackSummary,
  type PublishRequestRow,
  type StaffPublishRequestFeedbackDetail,
} from "./api";

const originalFetch = globalThis.fetch;

type ExpectFalse<Value extends false> = Value;
type OwnerSummaryIsNotLegacy = ExpectFalse<
  "repoUrl" extends keyof PublishRequestFeedbackSummary ? true : false
>;
type StaffDetailHidesReadTimestamps = ExpectFalse<
  "submitterUnreadAt" extends keyof StaffPublishRequestFeedbackDetail ? true : false
>;

const ownerSummaryIsNotLegacy: OwnerSummaryIsNotLegacy = false;
const staffDetailHidesReadTimestamps: StaffDetailHidesReadTimestamps = false;

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

test("listPublishRequestFeedback uses the unfiltered v1 collection", async () => {
  let requestedPath = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedPath = String(input);
    return new Response(
      JSON.stringify({ publishRequests: [], unreadCount: 0 }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  await listPublishRequestFeedback();

  expect(requestedPath).toContain("/api/v1/me/publish-requests");
  expect(requestedPath).not.toContain("?");
});

test("staff detail uses the safe v1 GET without a CSRF header", async () => {
  let requestedPath = "";
  let requestedHeaders = new Headers();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedPath = String(input);
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ publishRequest: { id: "prq_staff", comments: [] } }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  await getAdminPublishRequestFeedback("prq_staff");

  expect(requestedPath).toContain("/api/v1/admin/publish-requests/prq_staff");
  expect(requestedHeaders.get("X-CSRF-Token")).toBeNull();
});

test("feedback API contracts keep summary, owner detail, and staff detail shapes separate", () => {
  const ownerDetailKeys: Array<keyof PublishRequestFeedbackDetail> = [
    "submitterUnreadAt",
    "comments",
  ];
  const staffDetailKeys: Array<keyof StaffPublishRequestFeedbackDetail> = [
    "submittedBy",
    "comments",
  ];

  expect(ownerSummaryIsNotLegacy).toBe(false);
  expect(staffDetailHidesReadTimestamps).toBe(false);
  expect(ownerDetailKeys).toEqual(["submitterUnreadAt", "comments"]);
  expect(staffDetailKeys).toEqual(["submittedBy", "comments"]);
});
