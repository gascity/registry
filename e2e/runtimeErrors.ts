import { expect, type Page } from "@playwright/test";

export function trackRuntimeErrors(page: Page) {
  const errors: string[] = [];

  page.on("pageerror", (error) => {
    errors.push(`pageerror:${error.message}`);
  });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (ignoredConsoleError(text)) return;
    errors.push(`console:${text}`);
  });

  return errors;
}

function ignoredConsoleError(text: string) {
  // Chromium can emit this when host networking changes during parallel test runs.
  return text === "Failed to load resource: net::ERR_NETWORK_CHANGED";
}

export async function expectHealthyPage(page: Page, errors: string[]) {
  await expect
    .poll(() => errors, {
      message: `Unexpected runtime errors on ${page.url() || "unknown page"}`,
      timeout: 1_000,
    })
    .toEqual([]);
}

export async function expectNoHorizontalOverflow(page: Page) {
  const innerWidth = await page.evaluate(() => window.innerWidth);

  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth,
          offenders: Array.from(document.querySelectorAll("body *"))
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName,
                className: typeof element.className === "string" ? element.className : "",
                text: (element.textContent || "").trim().slice(0, 80),
                left: rect.left,
                right: rect.right,
                width: rect.width,
              };
            })
            .filter((item) => item.width > 1 && (item.left < -1 || item.right > innerWidth + 1))
            .slice(0, 10),
      })),
      { message: `Unexpected horizontal overflow on ${page.url() || "unknown page"}` },
    )
    .toEqual({ scrollWidth: innerWidth, innerWidth, offenders: [] });
}
