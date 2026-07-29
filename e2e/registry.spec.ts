import { expect, test, type Route } from "@playwright/test";
import { expectHealthyPage, expectNoHorizontalOverflow, trackRuntimeErrors } from "./runtimeErrors";

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function feedbackSummary(id: string, requestedName: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "pending_review",
    nextStep: "respond_to_feedback",
    actionRequiredBy: "submitter",
    requestedName,
    requestedVersion: "1.0.0",
    repository: { host: "github.com", owner: "e2e", name: requestedName, fullName: `e2e/${requestedName}` },
    packPath: ".",
    commit: "a".repeat(40),
    unread: false,
    submitterUnreadAt: null,
    createdAt: "2026-07-26T10:00:00.000Z",
    updatedAt: "2026-07-26T11:00:00.000Z",
    ...overrides,
  };
}

function feedbackDetail(id: string, requestedName: string, overrides: Record<string, unknown> = {}) {
  return {
    ...feedbackSummary(id, requestedName),
    repoUrl: `https://github.com/e2e/${requestedName}`,
    sourceUrl: `https://github.com/e2e/${requestedName}/tree/main`,
    comments: [], ...overrides,
  };
}

test("home exposes copyable registry endpoint and real pack links", async ({ page, context, baseURL }) => {
  const errors = trackRuntimeErrors(page);
  await context.grantPermissions(["clipboard-write"], { origin: baseURL ?? "http://127.0.0.1:48177" });

  await page.goto("/");
  const endpoint = `${baseURL ?? "http://127.0.0.1:48177"}/registry.toml`;
  await expect(page.getByLabel("CLI registry endpoint").getByText(endpoint)).toBeVisible();

  const endpointCopy = page.getByRole("button", { name: "Copy registry TOML endpoint" });
  await endpointCopy.click();
  await expect(endpointCopy).toContainText("Copied");

  // Target the gascity pack link by href, not by accessible name: other packs
  // (e.g. "contributing") mention "gascity" in their card text and can sort ahead of it,
  // so a name-based `.first()` would grab the wrong link.
  const packLink = page.locator('a[href^="/packs/gascity"]').first();
  await expect(packLink).toHaveAttribute("href", /\/packs\/gascity/);
  await packLink.click();
  await expect(page).toHaveURL(/\/packs\/gascity/);
  await expectHealthyPage(page, errors);
});

test("home search filters catalog results", async ({ page }) => {
  const errors = trackRuntimeErrors(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Registry" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Featured packs" })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search registry packs" }).fill("slack-full");

  await expect(page).toHaveURL(/q=slack-full/);
  await expect(
    page.locator(".browseResults .packListItem").filter({ hasText: "slack-full" }),
  ).toHaveCount(1);

  // #82: searching collapses the sections above the results...
  await expect(page.getByRole("heading", { name: "Featured packs" })).toBeHidden();
  await expect(page.getByLabel("CLI registry endpoint")).toBeHidden();
  // ...so the results render directly under the search input. "slack-full" is a broad
  // substring match (name + readme + release notes), so the first row is another pack;
  // what the bug is about is that the results toolbar count and the top result now sit
  // on screen without scrolling (pre-fix they were ~1300px down). This assumes the
  // header + hero fit in the default 720px viewport, so a future header that grows past
  // that reads as that, not as a #82 regression.
  await expect(page.locator(".resultsToolbar span[role='status']")).toBeInViewport();
  await expect(page.locator(".browseResults .packListItem").first()).toBeInViewport();

  // Clearing the query restores the full homepage.
  await page.getByRole("searchbox", { name: "Search registry packs" }).fill("");
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByRole("heading", { name: "Featured packs" })).toBeVisible();
  await expectHealthyPage(page, errors);
});

test("mobile filters open, show active state, and clear", async ({ page }) => {
  const errors = trackRuntimeErrors(page);

  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(page.getByRole("button", { name: "Close filters" })).toBeFocused();
  await page.getByRole("button", { name: "Integrations" }).click();
  await expect(page).toHaveURL(/category=integration/);
  await page.getByRole("button", { name: "Close filters" }).click();
  await expect(page.getByLabel("Active filters").getByText("Integrations")).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page).not.toHaveURL(/category=integration/);
  await expectHealthyPage(page, errors);
});

test("pack detail exposes README and tabbed metadata", async ({ page }) => {
  const errors = trackRuntimeErrors(page);

  await page.goto("/packs/gascity");
  await expect(page.getByRole("heading", { name: "gascity" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /README/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: /Gas City Build Pack/ })).toBeVisible();

  await page.getByRole("tab", { name: /Releases/ }).click();
  await expect(page).toHaveURL(/#releases/);
  await expect(page.getByText("Refresh Gas City planning pack release pin.")).toBeVisible();

  await page.getByRole("tab", { name: /Metadata/ }).click();
  await expect(page.locator("#pack-tabpanel-metadata").getByText("gascity-packs")).toBeVisible();
  await expect(page.locator("#pack-tabpanel-metadata").getByText("Aggregated")).toBeVisible();

  await page.getByRole("tab", { name: /Source/ }).click();
  await expect(page.getByRole("link", { name: /github.com\/gastownhall\/gascity-packs/ })).toBeVisible();

  await page.getByRole("tab", { name: /Trust/ }).click();
  await expect(page.getByText(/content-addressed/)).toBeVisible();
  await expect(page.getByText("Source attribution")).toBeVisible();
  await expect(page.getByText("Unverified source")).toBeVisible();
  await expect(page.getByRole("link", { name: /How verification works/ })).toHaveAttribute(
    "href",
    "/verify",
  );
  await expectHealthyPage(page, errors);
});

test("footer links expose source, verifier, and publishing pages", async ({ page }) => {
  const errors = trackRuntimeErrors(page);

  await page.goto("/");
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: /Source/ })).toHaveAttribute(
    "href",
    "https://github.com/gascity/registry",
  );

  await footer.getByRole("link", { name: "Verification flow" }).click();
  await expect(page).toHaveURL(/\/verify$/);
  await expect(page.getByRole("heading", { name: "Pack Ownership Verification" })).toBeVisible();
  await expect(page.getByText("Iv23libht048ujfs7SL4")).toBeVisible();
  await expect(page.getByText("Token exchange error")).toHaveCount(0);

  await page.getByRole("contentinfo").getByRole("link", { name: "Publish a pack" }).click();
  await expect(page).toHaveURL(/\/publish$/);
  await expect(page.getByRole("heading", { name: "Publish a Pack" })).toBeVisible();
  await expect(page.locator(".docsCode code").filter({ hasText: "gc pack registry publish ." })).toBeVisible();
  const workflow = page.locator(".docsCode code").filter({ hasText: "name: Publish pack" });
  await expect(workflow).toContainText("on:");
  await expect(workflow).toContainText("jobs:");
  await expect(workflow).toContainText("runs-on: ubuntu-latest");
  await expect(workflow).toContainText("actions/checkout@v4");
  await expect(workflow).toContainText("brew install");
  await expect(workflow).toContainText("GITHUB_PATH");
  await expect(workflow).toContainText("id-token: write");
  await expect(page.getByText("PACK_NAME_MISMATCH", { exact: true })).toBeVisible();
  await expect(page.getByText("GITHUB_ACTIONS_WORKFLOW_DENIED", { exact: true })).toBeVisible();
  await expect(page.getByText("make registry-publish")).toHaveCount(0);
  await expectHealthyPage(page, errors);
});

test("publish checklist prose stays in one flex item at phone width", async ({ page }) => {
  const errors = trackRuntimeErrors(page);

  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/publish");

  const checklistItems = page.locator(".docsPage .checkList li");
  await expect(checklistItems).toHaveCount(12);

  for (const item of await checklistItems.all()) {
    const body = item.locator(":scope > span");
    await expect(body).toHaveCount(1);

    const itemBox = await item.boundingBox();
    const bodyBox = await body.boundingBox();
    expect(itemBox).not.toBeNull();
    expect(bodyBox).not.toBeNull();
    expect(bodyBox!.width).toBeGreaterThan(itemBox!.width * 0.8);
  }

  await expectHealthyPage(page, errors);
});

test("detail tabs support keyboard navigation", async ({ page }) => {
  const errors = trackRuntimeErrors(page);

  await page.goto("/packs/gascity");
  const readme = page.getByRole("tab", { name: /README/ });
  await expect(readme).toHaveAttribute("aria-selected", "true");
  await readme.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Install/ })).toBeFocused();
  await expect(page.getByRole("tab", { name: /Install/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: /Trust/ })).toBeFocused();
  await expect(page).toHaveURL(/#trust/);
  await page.keyboard.press("Home");
  await expect(readme).toBeFocused();
  await expectHealthyPage(page, errors);
});

test("install tab copies commands with visible feedback", async ({ page, context, baseURL }) => {
  const errors = trackRuntimeErrors(page);
  await context.grantPermissions(["clipboard-write"], { origin: baseURL ?? "http://127.0.0.1:48177" });

  await page.goto("/packs/gascity#install");
  await expect(page.getByRole("tab", { name: /Install/ })).toHaveAttribute("aria-selected", "true");

  const copyButton = page.getByRole("button", { name: "Copy This version or later command" });
  await copyButton.click();
  await expect(copyButton).toContainText("Copied");
  await expectHealthyPage(page, errors);
});

test("dev auth can create and persist a local review", async ({ page }, testInfo) => {
  const errors = trackRuntimeErrors(page);
  const handle = `e2e-${Date.now()}-${testInfo.workerIndex}`;
  const title = `E2E local review ${Date.now()}`;
  const reviewBody = "Local file-backed reviews work without external auth or database services.";

  await page.goto(`/api/dev/sign-in?handle=${handle}&redirect=/packs/gascity`);
  await expect(page.getByRole("button", { name: /e2e-/ })).toBeVisible();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("textbox", { name: "Review" }).fill(reviewBody);
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(page.getByText("Review saved.")).toBeVisible();
  // The form collapses after a confirmed save — no stale editable input remains.
  await expect(page.getByRole("textbox", { name: "Review" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit review" })).toBeVisible();

  await page.reload();
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit review" })).toBeVisible();

  // Edit re-opens a pre-filled form — proof the values survived until a confirmed save.
  await page.getByRole("button", { name: "Edit review" }).click();
  await expect(page.getByLabel("Title")).toHaveValue(title);
  await page.getByLabel("Title").fill(`${title} updated`);

  // AC#3: a failed save preserves the entered values and keeps the form open. One-shot
  // PUT 500; the follow-up GET refetch (and any other verb) falls through untouched.
  await page.route(
    "**/api/reviews",
    (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
        : route.fallback(),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(page.locator(".formError")).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue(`${title} updated`);
  await expect(page.getByRole("textbox", { name: "Review" })).toHaveValue(reviewBody);

  // The retry succeeds and the form collapses again with the updated review listed.
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(page.getByText("Review saved.")).toBeVisible();
  await expect(page.getByText(`${title} updated`)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Review" })).toHaveCount(0);

  // Chromium logs the deliberate 500 above as a failed-resource console error; drop
  // that one expected entry so the health check still catches anything unexpected.
  const expectedFailure =
    "console:Failed to load resource: the server responded with a status of 500 (Internal Server Error)";
  const failureIndex = errors.indexOf(expectedFailure);
  if (failureIndex !== -1) errors.splice(failureIndex, 1);
  await expectHealthyPage(page, errors);
});

test("dev auth can submit and inspect a publish request", async ({ page }, testInfo) => {
  const errors = trackRuntimeErrors(page);
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const handle = `publisher-${stamp}`;
  const requestedName = `e2e-pack-${stamp}`;

  await page.goto(`/api/dev/sign-in?handle=${handle}&redirect=/account`);
  await expect(page.getByRole("button", { name: /publisher-/ })).toBeVisible();

  const result = await page.evaluate(async (name) => {
    const meResponse = await fetch("/api/me", { headers: { Accept: "application/json" } });
    const me = await meResponse.json();
    const response = await fetch("/api/publish-requests", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": me.csrfToken,
      },
      body: JSON.stringify({
        repoUrl: "https://github.com/gastownhall/gascity-packs",
        commit: "0123456789abcdef0123456789abcdef01234567",
        packPath: "packs/example",
        requestedName: name,
        requestedVersion: "0.1.0",
        requestedRef: "refs/tags/v0.1.0",
      }),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  }, requestedName);

  expect(result.status).toBe(201);
  expect(result.body.requestedName).toBe(requestedName);

  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Publish requests" })).toBeVisible();
  const request = page.locator(".accountRequestList article").filter({
    hasText: `${requestedName} 0.1.0`,
  });
  await expect(request).toBeVisible();
  await expect(page.getByText("Pending Validation")).toBeVisible();
  await expect(page.getByText("Awaiting validation.")).toBeVisible();
  await expect(request.getByRole("button", { name: "Validate" })).toBeVisible();
  await expectHealthyPage(page, errors);
});

test("account publish feedback is lazy, durable, accessible, and responsive", async ({ page }, testInfo) => {
  const stamp = Date.now() + "-" + testInfo.workerIndex;
  const requestId = "prq-feedback-" + stamp;
  const otherRequestId = "prq-feedback-other-" + stamp;
  const maxLengthRequestedName = "p".repeat(64);
  const requestLabel = maxLengthRequestedName + " 1.0.0";
  const otherRequestLabel = "other-pack 1.0.0";
  const unreadVersion = "2026-07-26T11:00:00.000Z";
  const existingCommentTime = "2026-07-26T10:30:00.000Z";
  const newCommentTime = "2026-07-26T11:10:00.000Z";
  let unreadAt: string | null = unreadVersion;
  let status = "pending_review";
  let listCalls = 0;
  let detailCalls = 0;
  let commentCalls = 0;
  const readPayloads: unknown[] = [];
  const comments = [{
    id: "prc-existing",
    authorHandle: "registry-reviewer",
    authorRole: "registry",
    body: "Please clarify the runtime requirement.",
    createdAt: existingCommentTime,
  }];
  let releaseList!: () => void;
  let releaseStaleDetail!: () => void;
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  const staleDetailGate = new Promise<void>((resolve) => { releaseStaleDetail = resolve; });

  await page.route("**/api/v1/me/publish-requests**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const summary = feedbackSummary(requestId, maxLengthRequestedName, {
      status,
      nextStep: status === "approved" ? "published" : "respond_to_feedback",
      actionRequiredBy: status === "approved" ? "registry" : "submitter",
      unread: unreadAt !== null,
      submitterUnreadAt: unreadAt,
      updatedAt: status === "approved" ? newCommentTime : unreadVersion,
    });

    if (method === "GET" && url.pathname.endsWith("/publish-requests")) {
      listCalls += 1;
      if (listCalls === 1) {
        await listGate;
        await fulfillJson(route, {
          error: { code: "UNAVAILABLE", message: "Publish requests unavailable." },
        }, 503);
        return;
      }
      await fulfillJson(route, {
        publishRequests: [
          summary,
          feedbackSummary(otherRequestId, "other-pack", {
            nextStep: "await_registry_review",
            actionRequiredBy: "registry",
          }),
        ],
        unreadCount: unreadAt === null ? 0 : 1,
      });
      return;
    }

    if (method === "GET" && url.pathname.endsWith("/" + otherRequestId)) {
      await fulfillJson(route, {
        publishRequest: feedbackDetail(otherRequestId, "other-pack", {
          nextStep: "await_registry_review",
          actionRequiredBy: "registry",
          comments: [{
            id: "prc-other",
            authorHandle: "other-reviewer",
            authorRole: "registry",
            body: "Request B detail stays selected.",
            createdAt: existingCommentTime,
          }],
        }),
      });
      return;
    }

    if (method === "GET") {
      detailCalls += 1;
      if (detailCalls === 3) await staleDetailGate;
      await fulfillJson(route, {
        publishRequest: feedbackDetail(requestId, maxLengthRequestedName, {
          ...summary,
          comments,
        }),
      });
      return;
    }

    if (method === "POST" && url.pathname.endsWith("/read")) {
      const payload = route.request().postDataJSON();
      readPayloads.push(payload);
      if (payload.observedUnreadAt === unreadAt) unreadAt = null;
      await route.fulfill({ status: 204 });
      return;
    }

    if (method === "POST" && url.pathname.endsWith("/comments")) {
      commentCalls += 1;
      const body = route.request().postDataJSON().body;
      const comment = {
        id: "prc-reply-" + commentCalls,
        authorHandle: "feedback-author",
        authorRole: "submitter",
        body,
        createdAt: newCommentTime,
      };
      comments.push(comment);
      if (commentCalls === 2) status = "approved";
      await fulfillJson(route, { comment }, 201);
      return;
    }

    await route.fulfill({ status: 500, body: "Unexpected feedback request." });
  });

  await page.setViewportSize({ width: 320, height: 1100 });
  await page.goto("/api/dev/sign-in?handle=feedback-" + stamp + "&redirect=/account");

  const listLoading = page.getByRole("status").filter({ hasText: "Loading publish requests…" });
  await expect(listLoading).toHaveAttribute("aria-busy", "true");
  releaseList();
  await expect(page.getByRole("alert")).toContainText("Publish requests unavailable.");
  await page.getByRole("button", { name: "Retry publish requests" }).click();

  await expect(page.getByRole("heading", { name: "Publish requests (1 unread)" })).toBeVisible();
  await expect(page.locator(".publishFeedbackBanner")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

  const request = page.locator(".accountRequestList > article").filter({ hasText: requestLabel });
  await expect(request).toHaveCount(1);
  await expect(request.getByText("Unread", { exact: true })).toBeVisible();
  expect(detailCalls).toBe(0);

  const openConversation = request.getByRole("button", {
    name: "Open conversation for " + requestLabel,
  });
  const conversationId = await openConversation.getAttribute("aria-controls");
  expect(conversationId).toBeTruthy();
  await openConversation.click();
  const conversation = page.getByLabel("Conversation for " + requestLabel);
  await expect(conversation).toHaveAttribute("id", conversationId ?? "");
  await expect(conversation.getByText("Please clarify the runtime requirement.")).toBeVisible();
  await expect(conversation.locator("time")).toHaveAttribute("datetime", existingCommentTime);
  await expect.poll(() => readPayloads).toEqual([{ observedUnreadAt: unreadVersion }]);
  await expect.poll(() => listCalls).toBe(3);
  await expect(page.getByRole("heading", { name: "Publish requests", exact: true })).toBeVisible();

  const reply = page.getByLabel("Reply to " + requestLabel);
  await expectNoHorizontalOverflow(page);
  await reply.fill("😀");
  await expect(page.getByText("3999 characters remaining")).toBeVisible();
  await reply.fill("The runtime requirement is now documented.");
  const detailCallsBeforeReply = detailCalls;
  const listCallsBeforeReply = listCalls;
  await page.getByRole("button", { name: "Send reply" }).click();

  const newComment = page.locator(".publishComment").filter({ hasText: "The runtime requirement is now documented." });
  await expect(newComment).toBeFocused();
  await expect(newComment.locator("time")).toHaveAttribute("datetime", newCommentTime);
  expect(commentCalls).toBe(1);
  await expect.poll(() => detailCalls).toBe(detailCallsBeforeReply + 1);
  await expect.poll(() => listCalls).toBe(listCallsBeforeReply + 1);

  await reply.fill("A second reply with a delayed detail refresh.");
  const detailCallsBeforeRace = detailCalls;
  const listCallsBeforeRace = listCalls;
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect.poll(() => detailCalls).toBe(detailCallsBeforeRace + 1);

  const otherRequest = page.locator(".accountRequestList > article").filter({
    hasText: otherRequestLabel,
  });
  await otherRequest.getByRole("button", {
    name: "Open conversation for " + otherRequestLabel,
  }).click();
  const otherConversation = page.getByLabel("Conversation for " + otherRequestLabel);
  await expect(otherConversation.getByText("Request B detail stays selected.")).toBeVisible();
  releaseStaleDetail();
  await expect.poll(() => listCalls).toBe(listCallsBeforeRace + 1);
  await expect(otherConversation.getByText("Request B detail stays selected.")).toBeVisible();

  await otherRequest.getByRole("button", {
    name: "Close conversation for " + otherRequestLabel,
  }).click();
  await request.getByRole("button", {
    name: "Open conversation for " + requestLabel,
  }).click();
  await expect(page.getByLabel("Conversation for " + requestLabel)).toContainText(
    "This request is terminal and cannot receive replies.",
  );
  await expect(page.getByLabel("Reply to " + requestLabel)).toHaveCount(0);

  await expectNoHorizontalOverflow(page);
});

test("dev auth publish page exposes GitHub import and manual fallback", async ({ page }, testInfo) => {
  const errors = trackRuntimeErrors(page);
  const handle = `web-publish-${Date.now()}-${testInfo.workerIndex}`;

  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto(`/api/dev/sign-in?handle=${handle}&redirect=/publish`);
  await expect(page.getByRole("heading", { name: "Install the GitHub App, then Find packs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Find Packs From GitHub" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find packs" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Install app/ })).toHaveAttribute("href", /github\.com\/apps/);
  await expect(page.getByText("Manual publish request")).toBeVisible();
  await page.getByText("Manual publish request").click();
  await expect(page.getByLabel("GitHub repository")).toBeVisible();
  await expect(page.getByLabel("Commit SHA")).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit publish request" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectHealthyPage(page, errors);
});

test("publish page retains a durable request from a non-2xx validation response", async ({ page }, testInfo) => {
  // This deliberately fulfills the create request with HTTP 422, which browsers may report as a
  // failed resource even though the UI handles the structured response.
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const name = `e2e-fixture/failed-${stamp}`;
  const commit = "d".repeat(40);
  await page.goto(`/api/dev/sign-in?handle=failed-${stamp}&redirect=/publish`);
  await page.route("**/api/publish-requests?validate=1", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "PACK_NAME_MISMATCH",
          message: "pack.toml declares a different name.",
        },
        publishRequest: {
          id: `failed-${stamp}`,
          status: "validation_failed",
          repository: {
            host: "github.com",
            owner: "e2e-fixture",
            name: "failed-pack",
            fullName: "e2e-fixture/failed-pack",
          },
          repoUrl: "https://github.com/e2e-fixture/failed-pack",
          sourceUrl: `https://github.com/e2e-fixture/failed-pack/tree/${commit}`,
          packPath: ".",
          commit,
          requestedName: name,
          requestedVersion: "0.1.0",
          validationError: "pack.toml declares a different name.",
          createdAt: "2026-07-26T00:00:00.000Z",
          updatedAt: "2026-07-26T00:00:00.000Z",
          submittedBy: {
            id: `failed-${stamp}`,
            handle: `failed-${stamp}`,
            displayName: `failed-${stamp}`,
            role: "user",
          },
          submissionMethod: "web_session",
        },
      }),
    });
  });

  await page.getByText("Manual publish request").click();
  await page.getByLabel("GitHub repository").fill("https://github.com/e2e-fixture/failed-pack");
  await page.getByLabel("Commit SHA").fill(commit);
  await page.getByLabel("Pack name").fill(name);
  await page.getByLabel("Version").fill("0.1.0");
  await page.getByRole("button", { name: "Submit publish request" }).click();

  await expect(page.getByText("Validation failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Manual web form")).toBeVisible();
  await expect(page.getByText("Claim only", { exact: true })).toBeVisible();
  await expect(page.getByText("Validation: pack.toml declares a different name.")).toBeVisible();
  await expect(page.getByText("Unable to submit publish request.")).toHaveCount(0);
});

test("publish sign-in keeps the author on the publish page", async ({ page }) => {
  const errors = trackRuntimeErrors(page);

  await page.goto("/publish");
  await expect(page.getByRole("heading", { name: "Install the GitHub App, then Find packs" })).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "Dev sign in" }).click();
  await expect(page).toHaveURL(/\/publish$/);
  await expect(page.getByRole("heading", { name: "Find Packs From GitHub" })).toBeVisible();
  await expectHealthyPage(page, errors);
});

test("dev auth can create a token for bearer publish requests", async ({ page }, testInfo) => {
  const errors = trackRuntimeErrors(page);
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const handle = `token-${stamp}`;
  const tokenLabel = `E2E token ${stamp}`;
  const requestedName = `bearer-pack-${stamp}`;

  await page.goto(`/api/dev/sign-in?handle=${handle}&redirect=/account`);
  await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();
  await page.getByLabel("Label").fill(tokenLabel);
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("API token created.")).toBeVisible();
  const rawToken = (await page.locator(".tokenReveal > code").textContent())?.trim() ?? "";
  expect(rawToken.startsWith("gcr_")).toBe(true);

  const result = await page.evaluate(
    async ({ name, token }) => {
      const response = await fetch("/api/publish-requests", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repoUrl: "https://github.com/gastownhall/gascity-packs",
          commit: "0123456789abcdef0123456789abcdef01234567",
          packPath: "packs/example",
          requestedName: name,
          requestedVersion: "0.1.0",
        }),
      });
      return {
        status: response.status,
        body: await response.json(),
      };
    },
    { name: requestedName, token: rawToken },
  );

  expect(result.status).toBe(201);
  expect(result.body.requestedName).toBe(requestedName);

  const tokenRow = page.locator(".accountTokenList article").filter({ hasText: tokenLabel });
  await expect(tokenRow.getByText("Active")).toBeVisible();
  await tokenRow.getByRole("button", { name: "Revoke" }).click();
  await expect(tokenRow.getByText("Revoked")).toBeVisible();
  await expectHealthyPage(page, errors);
});

test("dev admin can open the publish review queue", async ({ page }, testInfo) => {
  const errors = trackRuntimeErrors(page);
  const handle = `admin-${Date.now()}-${testInfo.workerIndex}`;

  await page.goto(`/api/dev/sign-in?handle=${handle}&role=admin&redirect=/admin/publish-requests`);
  await expect(page.getByRole("heading", { name: "Publish requests" })).toBeVisible();
  // The shell rail exposes the admin-gated "Review" section as a nav button.
  await expect(page.getByRole("button", { name: "Review" })).toBeVisible();
  await expectHealthyPage(page, errors);
});

test("admin opens durable publish conversation and assigns the next actor with a comment", async ({ page }, testInfo) => {
  const errors = trackRuntimeErrors(page);
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const requestId = `prq-admin-feedback-${stamp}`;
  let submittedComment: { body: string; actionRequiredBy: string } | null = null;
  let queueCalls = 0;
  let detailCalls = 0;
  const comments = [{
    id: "prc-existing",
    authorHandle: "pack-author",
    authorRole: "submitter",
    body: "The runtime requirement is documented in README.md.",
    createdAt: "2026-07-26T10:00:00.000Z",
  }];
  const request = {
    id: requestId,
    status: "pending_review",
    nextStep: "await_registry_review",
    actionRequiredBy: "registry",
    requestedName: "staff-feedback-pack",
    requestedVersion: "2.0.0",
    repository: { host: "github.com", owner: "e2e", name: "staff-feedback", fullName: "e2e/staff-feedback" },
    repoUrl: "https://github.com/e2e/staff-feedback",
    sourceUrl: "https://github.com/e2e/staff-feedback/tree/main",
    packPath: ".",
    commit: "b".repeat(40),
    createdAt: "2026-07-26T09:00:00.000Z",
    updatedAt: "2026-07-26T10:00:00.000Z",
    submittedBy: { id: "usr-submitter", handle: "pack-author", displayName: "Pack Author", role: "user" },
    submissionMethod: "github_import",
  };

  await page.route("**/api/admin/publish-requests", (route) => {
    queueCalls += 1;
    return fulfillJson(route, { publishRequests: [request] });
  });
  await page.route(`**/api/v1/admin/publish-requests/${requestId}**`, async (route) => {
    if (route.request().method() === "GET") {
      detailCalls += 1;
      await fulfillJson(route, { publishRequest: { ...request, comments } });
      return;
    }
    submittedComment = route.request().postDataJSON();
    const comment = {
      id: "prc-new",
      authorHandle: "admin",
      authorRole: "registry",
      body: submittedComment?.body ?? "",
      createdAt: "2026-07-26T11:00:00.000Z",
    };
    comments.push(comment);
    await fulfillJson(route, { comment }, 201);
  });

  await page.setViewportSize({ width: 390, height: 1100 });
  await page.goto(`/api/dev/sign-in?handle=admin-feedback-${stamp}&role=admin&redirect=/admin/publish-requests`);
  await page.getByRole("button", { name: "Open conversation for staff-feedback-pack 2.0.0" }).click();
  await expect(page.getByText("The runtime requirement is documented in README.md.")).toBeVisible();
  await expect(page.locator(".publishComment time")).toHaveAttribute(
    "datetime",
    "2026-07-26T10:00:00.000Z",
  );
  await page.getByLabel("Staff comment for staff-feedback-pack 2.0.0").fill("Thanks. Please make one final clarification.");
  await page.getByLabel("Next action for staff-feedback-pack 2.0.0").selectOption("submitter");
  await page.getByRole("button", { name: "Send comment for staff-feedback-pack 2.0.0" }).click();
  await expect(
    page.locator(".publishComment").filter({ hasText: "Thanks. Please make one final clarification." }),
  ).toBeFocused();
  expect(submittedComment).toEqual({
    body: "Thanks. Please make one final clarification.",
    actionRequiredBy: "submitter",
  });
  expect(detailCalls).toBe(2);
  expect(queueCalls).toBe(1);
  await expectNoHorizontalOverflow(page);
  await expectHealthyPage(page, errors);
});

test("mobile detail has no horizontal overflow", async ({ page }) => {
  const errors = trackRuntimeErrors(page);

  await page.setViewportSize({ width: 390, height: 1100 });
  await page.goto("/packs/gascity");

  await expect(page.getByRole("tab", { name: /README/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectHealthyPage(page, errors);
});

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`visual smoke at ${width}px`, async ({ page }, testInfo) => {
    const errors = trackRuntimeErrors(page);
    await page.setViewportSize({ width, height: width < 700 ? 1100 : 900 });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Registry" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: true, path: testInfo.outputPath(`home-${width}.png`) });

    await page.goto("/packs/gascity#install");
    await expect(page.getByRole("heading", { name: "gascity" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: true, path: testInfo.outputPath(`gascity-${width}.png`) });
    await expectHealthyPage(page, errors);
  });
}

test("pack author is visible and links to the author's packs", async ({ page }) => {
  const errors = trackRuntimeErrors(page);

  // The hermetic harness serves the committed catalog whose sources are all
  // github.com/gastownhall/…, so "gastownhall" is the deterministic author.
  await page.goto("/packs/gascity");
  const author = page.getByRole("link", { name: "Browse packs by gastownhall" });
  await expect(author).toHaveText("by gastownhall");
  await author.click();

  await expect(page).toHaveURL(/\?author=gastownhall/);
  await expect(page).toHaveTitle("Packs by gastownhall | Gas City Registry");
  await expect(page.getByLabel("Active filters").getByText("Author: gastownhall")).toBeVisible();
  await expect(page.locator(".browseResults .packListItem").first()).toBeVisible();

  // A stale/hand-typed author with no matching packs falls through to the empty state.
  await page.goto("/?author=nobody-here");
  await expect(page.getByText("No packs found")).toBeVisible();

  // Clearing drops the author filter. Scope the click to the active-filters row: the desktop
  // sidebar's "Clear filters" button is also in the a11y tree and getByRole name-matches by
  // substring.
  await page.goto("/?author=gastownhall");
  await page.locator(".activeFilters").getByRole("button", { name: "Clear" }).click();
  await expect(page).not.toHaveURL(/author=/);
  await expectHealthyPage(page, errors);
});

test("embedded in an apex iframe renders just the window, not a nested cockpit", async ({ page }) => {
  // Load a same-origin host first (frame-ancestors 'self' rejects a cross-origin
  // about:blank parent), then frame registry the way the apex Space does.
  await page.goto("/");
  await page.evaluate(() => {
    const f = document.createElement("iframe");
    f.title = "registry";
    f.src = "/";
    f.style.cssText = "width:100%;height:680px;border:0";
    document.body.replaceChildren(f);
  });
  const panel = page.frameLocator('iframe[title="registry"]');

  // Embedded → the chromeless ProductShell (.gcs-product). The full standalone
  // cockpit (.gcs-shell with its top strip + product rail) must NOT be nested in.
  await expect(panel.locator(".gcs-product")).toBeVisible();
  await expect(panel.locator(".gcs-shell")).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Registry" })).toBeVisible();
});
