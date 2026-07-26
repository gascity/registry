import { expect, test } from "@playwright/test";
import { expectHealthyPage, expectNoHorizontalOverflow, trackRuntimeErrors } from "./runtimeErrors";

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

  await page.goto(`/api/dev/sign-in?handle=${handle}&redirect=/packs/gascity`);
  await expect(page.getByRole("button", { name: /e2e-/ })).toBeVisible();
  await page.getByLabel("Title").fill(title);
  await page
    .getByRole("textbox", { name: "Review" })
    .fill("Local file-backed reviews work without external auth or database services.");
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(page.getByText("Review saved.")).toBeVisible();

  await page.reload();
  await expect(page.getByText(title)).toBeVisible();
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
  await expect(page.getByText(`${requestedName} 0.1.0`)).toBeVisible();
  await expect(page.getByText("Pending validation")).toBeVisible();
  await expect(page.getByText("Manual web form")).toBeVisible();
  await expect(page.getByText("Claim only", { exact: true })).toBeVisible();
  await expect(page.getByText(/What happens next:/)).toBeVisible();
  await expectHealthyPage(page, errors);
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
