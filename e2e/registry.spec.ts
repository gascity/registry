import { expect, test } from "@playwright/test";
import { expectHealthyPage, expectNoHorizontalOverflow, trackRuntimeErrors } from "./runtimeErrors";

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

test("install tab copies commands with visible feedback", async ({ page, context }) => {
  const errors = trackRuntimeErrors(page);
  await context.grantPermissions(["clipboard-write"], { origin: "http://127.0.0.1:4177" });

  await page.goto("/packs/gascity#install");
  await expect(page.getByRole("tab", { name: /Install/ })).toHaveAttribute("aria-selected", "true");

  const copyButton = page.getByRole("button", { name: "Copy This version or later command" });
  await copyButton.click();
  await expect(copyButton).toContainText("Copied");
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
