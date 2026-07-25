import { expect, test, type Page } from "@playwright/test";
import { expectHealthyPage, trackRuntimeErrors } from "./runtimeErrors";

// Drives the full direct-publish loop through the RUNNING harness server (hermetic fakes):
// submit -> validate -> staff approve/reject -> assert the served /catalog.json + /registry.toml.
// This is the browser twin of the flow a beta tester will exercise by hand.

const commit = "c".repeat(40);

// Every direct publish is SCOPED `owner/pack`, where owner is the GitHub owner of the source repo
// (all fixture repos live under `e2e-fixture`). An unscoped name is reserved and would be refused
// at approve with PUBLISH_NAME_RESERVED.
const scope = "e2e-fixture";

// Each test uses its OWN source repo (derived from its unique pack slug). The harness runs a
// single shared store across all parallel workers, and pack ownership is keyed per-repo — so a
// shared repo makes concurrent seed-ownership calls clobber one another's verified owner,
// spuriously tripping the approval gate on whichever test approves second.
function repoUrlFor(slug: string) {
  return `https://github.com/${scope}/${slug}`;
}

function packNameFor(slug: string) {
  return `${scope}/${slug}`;
}

async function submitPublishRequest(page: Page, name: string, repoUrl: string) {
  return page.evaluate(
    async ({ name, repoUrl, commit }) => {
      const me = await (await fetch("/api/me", { headers: { Accept: "application/json" } })).json();
      const response = await fetch("/api/publish-requests?validate=1", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": me.csrfToken,
        },
        body: JSON.stringify({
          repoUrl,
          commit,
          packPath: `packs/${name}`,
          requestedName: name,
          requestedVersion: "0.1.0",
          requestedRef: "refs/heads/main",
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { name, repoUrl, commit },
  );
}

async function seedOwnership(page: Page, repoUrl: string) {
  return page.evaluate(
    async ({ repoUrl }) => {
      const me = await (await fetch("/api/me", { headers: { Accept: "application/json" } })).json();
      const response = await fetch("/api/dev/seed-ownership", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": me.csrfToken,
        },
        body: JSON.stringify({ repoUrl }),
      });
      return response.status;
    },
    { repoUrl },
  );
}

async function readCatalog(page: Page) {
  const packs = (await (await page.request.get("/catalog.json")).json()) as {
    packs: Array<{ name: string; latest: string; registry: string }>;
  };
  const toml = await (await page.request.get("/registry.toml")).text();
  return { packs: packs.packs, toml };
}

test("web publish: claim-only submit -> ownership gate -> override approve -> served", async ({ page }, testInfo) => {
  // No expectHealthyPage here: this test deliberately triggers a 403, which Chromium logs
  // to the console as a failed-resource error.
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const slug = `e2e-loop-${stamp}`;
  const name = packNameFor(slug);
  const repoUrl = repoUrlFor(slug);

  await page.goto(`/api/dev/sign-in?handle=pub-${stamp}&redirect=/account`);
  const submitted = await submitPublishRequest(page, name, repoUrl);
  expect(submitted.status).toBe(201);
  // The hermetic fake gc validated it synchronously.
  expect(submitted.body.publishRequest.status).toBe("pending_review");
  expect(submitted.body.publishRequest.registryEntry.release.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

  await page.goto(`/api/dev/sign-in?handle=admin-${stamp}&role=admin&redirect=/admin/publish-requests`);
  const row = page.locator("article").filter({ hasText: `${name} 0.1.0` });
  await expect(row).toBeVisible();

  // A claim-only (web_session) request without verified ownership is blocked, and the
  // actionable message stays visible...
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/lacks proof of source-repository ownership/i)).toBeVisible();

  // ...until staff supply an audited override reason.
  await row.getByLabel(`Ownership override reason for ${name}`).fill("e2e approved out of band");
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByText("Approved", { exact: true })).toBeVisible();

  const { packs, toml } = await readCatalog(page);
  expect(packs).toContainEqual(
    expect.objectContaining({ name, latest: "0.1.0", registry: "direct" }),
  );
  expect(toml).toContain(`name = "${name}"`);
});

test("web publish: verified ownership approves without an override", async ({ page }, testInfo) => {
  const errors = trackRuntimeErrors(page);
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const slug = `e2e-owned-${stamp}`;
  const name = packNameFor(slug);
  const repoUrl = repoUrlFor(slug);

  await page.goto(`/api/dev/sign-in?handle=owner-${stamp}&redirect=/account`);
  expect(await seedOwnership(page, repoUrl)).toBe(201); // the dev ownership seam binds this user to the repo
  const submitted = await submitPublishRequest(page, name, repoUrl);
  expect(submitted.body.publishRequest.status).toBe("pending_review");

  await page.goto(`/api/dev/sign-in?handle=admin-${stamp}&role=admin&redirect=/admin/publish-requests`);
  const row = page.locator("article").filter({ hasText: `${name} 0.1.0` });
  await expect(row).toBeVisible();
  // No override needed — the merge gate sees the submitter's verified repo ownership.
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByText("Approved", { exact: true })).toBeVisible();

  const { packs } = await readCatalog(page);
  expect(packs.some((pack) => pack.name === name)).toBe(true);
  await expectHealthyPage(page, errors);
});

test("web publish: reject terminates the request and never serves the pack", async ({ page }, testInfo) => {
  // No expectHealthyPage: the approve-after-reject probe deliberately triggers a 4xx, which
  // Chromium logs to the console.
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const slug = `e2e-reject-${stamp}`;
  const name = packNameFor(slug);
  const repoUrl = repoUrlFor(slug);

  await page.goto(`/api/dev/sign-in?handle=pub-${stamp}&redirect=/account`);
  const submitted = await submitPublishRequest(page, name, repoUrl);
  expect(submitted.body.publishRequest.status).toBe("pending_review");

  await page.goto(`/api/dev/sign-in?handle=admin-${stamp}&role=admin&redirect=/admin/publish-requests`);
  const row = page.locator("article").filter({ hasText: `${name} 0.1.0` });
  await expect(row).toBeVisible();
  await row.getByLabel(`Reject reason for ${name}`).fill("e2e rejected");
  await row.getByRole("button", { name: "Reject" }).click();
  await expect(row.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(row.getByText("e2e rejected")).toBeVisible();

  // Terminal: a rejected request cannot be resurrected into the catalog. Attempt an approve
  // directly against the API (the UI hides the button once rejected) and assert it's refused,
  // so the "never serves" assertion below isn't vacuously true.
  const reapprove = await page.evaluate(
    async ({ id }) => {
      const me = await (await fetch("/api/me", { headers: { Accept: "application/json" } })).json();
      const res = await fetch(`/api/publish-requests/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": me.csrfToken },
        body: JSON.stringify({ ownershipOverrideReason: "should not work" }),
      });
      return res.status;
    },
    { id: submitted.body.publishRequest.id },
  );
  expect(reapprove).toBeGreaterThanOrEqual(400);

  const { packs, toml } = await readCatalog(page);
  expect(packs.some((pack) => pack.name === name)).toBe(false);
  expect(toml).not.toContain(`name = "${name}"`);
});

test("web publish: staff withdraw takes an approved pack off the served catalog", async ({ page }, testInfo) => {
  // No expectHealthyPage: the terminal re-validate probe deliberately triggers a 4xx, which
  // Chromium logs to the console.
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const slug = `e2e-withdraw-${stamp}`;
  const name = packNameFor(slug);
  const repoUrl = repoUrlFor(slug);

  await page.goto(`/api/dev/sign-in?handle=owner-${stamp}&redirect=/account`);
  expect(await seedOwnership(page, repoUrl)).toBe(201);
  const submitted = await submitPublishRequest(page, name, repoUrl);
  expect(submitted.body.publishRequest.status).toBe("pending_review");

  await page.goto(`/api/dev/sign-in?handle=admin-${stamp}&role=admin&redirect=/admin/publish-requests`);
  const row = page.locator("article").filter({ hasText: `${name} 0.1.0` });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByText("Approved", { exact: true })).toBeVisible();

  // Live in the served catalog before takedown.
  expect((await readCatalog(page)).packs.some((pack) => pack.name === name)).toBe(true);

  // Staff takedown of the approved release drops it from the runtime catalog immediately.
  await row.getByLabel(`Withdraw reason for ${name}`).fill("e2e takedown");
  await row.getByRole("button", { name: "Withdraw" }).click();
  await expect(row.getByText("Withdrawn", { exact: true })).toBeVisible();
  await expect(row.getByText("e2e takedown")).toBeVisible();

  // Terminal: a withdrawn request cannot be re-validated back to life (the UI hides its actions,
  // so probe the API directly) — proving the catalog drop below isn't a transient merge artifact.
  const revalidate = await page.evaluate(
    async ({ id }) => {
      const me = await (await fetch("/api/me", { headers: { Accept: "application/json" } })).json();
      const res = await fetch(`/api/publish-requests/${encodeURIComponent(id)}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": me.csrfToken },
      });
      return res.status;
    },
    { id: submitted.body.publishRequest.id },
  );
  expect(revalidate).toBeGreaterThanOrEqual(400);

  const { packs, toml } = await readCatalog(page);
  expect(packs.some((pack) => pack.name === name)).toBe(false);
  expect(toml).not.toContain(`name = "${name}"`);
});
