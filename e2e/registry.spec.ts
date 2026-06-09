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

  const packLink = page.getByRole("link", { name: /gascity/i }).first();
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
  await expect(page.getByRole("heading", { name: "Gas City Planning Skills" })).toBeVisible();

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
