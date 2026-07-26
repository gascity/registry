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

async function submitPublishRequest(
  page: Page,
  name: string,
  repoUrl: string,
  version = "0.1.0",
) {
  return page.evaluate(
    async ({ name, repoUrl, commit, version }) => {
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
          requestedVersion: version,
          requestedRef: "refs/heads/main",
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { name, repoUrl, commit, version },
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
  await expect(row.getByText("Manual web form")).toBeVisible();
  await expect(row.getByText("Claim only", { exact: true })).toBeVisible();
  await expect(row.getByText(/audited override/)).toBeVisible();

  // A claim-only (web_session) request without verified ownership is blocked, and the
  // actionable message stays visible...
  await row.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/lacks proof of source-repository ownership/i)).toBeVisible();

  // ...until staff supply an audited override reason.
  await row.getByLabel(`Ownership override reason for ${name}`).fill("e2e approved out of band");
  await row.getByRole("button", { name: "Approve", exact: true }).click();
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
  await row.getByRole("button", { name: "Approve", exact: true }).click();
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
  await row.getByRole("button", { name: "Approve", exact: true }).click();
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

// The two staff name levers, driven through the UI. Before this slice both were curl-only: the
// queue page sent ownershipOverrideReason on approve and a bare reason on withdraw, so
// namePinOverrideReason and releaseNameClaim were unreachable from the browser. Each lever moves or
// frees a GLOBAL pack name, so what is under test is not only that the field reaches the server but
// that the consequence is on screen and that a mis-click cannot pull it.

test("web publish: re-pinning a claimed name needs the refusal, a reason and the typed name", async ({ page }, testInfo) => {
  // No expectHealthyPage: the first approve deliberately 409s, which Chromium logs as a failed
  // resource load.
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const slug = `e2e-repin-${stamp}`;
  const name = packNameFor(slug);
  const originalRepo = repoUrlFor(`${slug}-original`);
  const migratedRepo = repoUrlFor(`${slug}-migrated`);

  await page.goto(`/api/dev/sign-in?handle=owner-${stamp}&redirect=/account`);
  expect(await seedOwnership(page, originalRepo)).toBe(201);
  expect(await seedOwnership(page, migratedRepo)).toBe(201);
  const first = await submitPublishRequest(page, name, originalRepo);
  expect(first.body.publishRequest.status).toBe("pending_review");
  // Same name, same owner scope, DIFFERENT repo — the pack "moved repos".
  const moved = await submitPublishRequest(page, name, migratedRepo, "0.2.0");
  expect(moved.body.publishRequest.status).toBe("pending_review");

  await page.goto(`/api/dev/sign-in?handle=admin-${stamp}&role=admin&redirect=/admin/publish-requests`);
  const originalRow = page.locator("article").filter({ hasText: `${name} 0.1.0` });
  const movedRow = page.locator("article").filter({ hasText: `${name} 0.2.0` });
  await expect(originalRow).toBeVisible();

  // The first release mints the claim.
  await originalRow.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(originalRow.getByText("Approved", { exact: true })).toBeVisible();

  // Until the server has refused, there is no lever at all: staff cannot re-pin a name without
  // first being told which repository holds it.
  await expect(movedRow.getByText("Re-pin the pack name")).toBeHidden();

  await movedRow.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/releases must come from that repository/i)).toBeVisible();

  // Now the lever appears, and it states the consequence in the concrete.
  await expect(movedRow.getByText("Re-pin the pack name")).toBeVisible();
  await expect(movedRow.getByText(/Approving MOVES/)).toBeVisible();
  await expect(movedRow.getByText(/loses it/)).toBeVisible();

  // Both halves of the arming condition are probed INDEPENDENTLY and in both orders. Probing them
  // only in one order lets either half shadow the other: with a reason already filled, dropping the
  // reason requirement changes nothing, and vice versa.
  const repin = movedRow.getByRole("button", { name: "Re-pin and approve" });
  const reason = movedRow.getByLabel(`Name re-pin reason for ${name}`);
  const confirm = movedRow.getByLabel(`Confirm pack name to re-pin ${name}`);
  await expect(repin).toBeDisabled();

  // The exact name typed, but NO reason -> still disabled. (Kills the required-reason half.)
  await confirm.fill(name);
  await expect(repin).toBeDisabled();

  // A reason, but NO confirmation -> still disabled. (Kills the typed-confirmation half.)
  await confirm.fill("");
  await reason.fill("repo migration, ticket #77");
  await expect(repin).toBeDisabled();

  // A near-miss confirmation is not a confirmation. (Kills a prefix/substring compare.)
  await confirm.fill(`${name}x`);
  await expect(repin).toBeDisabled();
  await confirm.fill(name.slice(0, -1));
  await expect(repin).toBeDisabled();

  // A whitespace-only reason is not a reason. (Kills dropping the .trim().)
  await confirm.fill(name);
  await reason.fill("   ");
  await expect(repin).toBeDisabled();

  await reason.fill("repo migration, ticket #77");
  await expect(repin).toBeEnabled();

  // A second ordinary Approve still sends no override, so it still 409s — the plain button can
  // never re-pin by accident.
  await movedRow.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/releases must come from that repository/i)).toBeVisible();
  await expect(movedRow.getByText("Pending review", { exact: true })).toBeVisible();

  await movedRow.getByRole("button", { name: "Re-pin and approve" }).click();
  await expect(movedRow.getByText("Approved", { exact: true })).toBeVisible();

  const { packs } = await readCatalog(page);
  expect(packs).toContainEqual(expect.objectContaining({ name, latest: "0.2.0" }));
});

test("web publish: the release lever frees a scoped name, and is withheld while a sibling is served", async ({ page }, testInfo) => {
  // No expectHealthyPage: the post-release re-claim probe drives a 409 before the release.
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const slug = `e2e-unclaim-${stamp}`;
  const name = packNameFor(slug);
  const firstRepo = repoUrlFor(`${slug}-first`);
  const secondRepo = repoUrlFor(`${slug}-second`);

  await page.goto(`/api/dev/sign-in?handle=owner-${stamp}&redirect=/account`);
  expect(await seedOwnership(page, firstRepo)).toBe(201);
  expect(await seedOwnership(page, secondRepo)).toBe(201);
  await submitPublishRequest(page, name, firstRepo);
  await submitPublishRequest(page, name, firstRepo, "0.2.0");

  await page.goto(`/api/dev/sign-in?handle=admin-${stamp}&role=admin&redirect=/admin/publish-requests`);
  const rowOne = page.locator("article").filter({ hasText: `${name} 0.1.0` });
  const rowTwo = page.locator("article").filter({ hasText: `${name} 0.2.0` });
  await rowOne.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(rowOne.getByText("Approved", { exact: true })).toBeVisible();
  await rowTwo.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(rowTwo.getByText("Approved", { exact: true })).toBeVisible();

  // Two approved releases: releasing the claim now would unclaim a live, served name (and the next
  // boot's grandfather backfill would silently re-mint it). The server refuses that, so the UI
  // explains instead of offering a checkbox that always 422s.
  await expect(rowTwo.getByText(/is still served/)).toBeVisible();
  await expect(rowTwo.getByLabel(`Release the name claim for ${name}`)).toBeHidden();

  // Take the sibling down without releasing; now exactly one release is served and the lever appears.
  await rowTwo.getByLabel(`Withdraw reason for ${name}`).fill("e2e sibling takedown");
  await rowTwo.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(rowTwo.getByText("Withdrawn", { exact: true })).toBeVisible();

  const release = rowOne.getByLabel(`Release the name claim for ${name}`);
  await expect(release).toBeVisible();
  // Unchecked, the button is an ordinary takedown and sends no releaseNameClaim.
  await expect(rowOne.getByRole("button", { name: "Withdraw", exact: true })).toBeVisible();
  await release.check();
  // Checked, the label changes and the consequence is spelled out.
  await expect(rowOne.getByRole("button", { name: "Withdraw and unclaim" })).toBeVisible();
  await expect(rowOne.getByText(/returns to unclaimed/)).toBeVisible();

  await rowOne.getByLabel(`Withdraw reason for ${name}`).fill("e2e squat takedown");
  await rowOne.getByRole("button", { name: "Withdraw and unclaim" }).click();
  await expect(rowOne.getByText("Withdrawn", { exact: true })).toBeVisible();

  // The lever actually did something: a DIFFERENT repository can now claim the freed name. Without
  // releaseNameClaim in the body this approve would 409 PUBLISH_NAME_OWNER_MISMATCH.
  await page.goto(`/api/dev/sign-in?handle=owner-${stamp}&redirect=/account`);
  const reclaim = await submitPublishRequest(page, name, secondRepo, "0.3.0");
  expect(reclaim.body.publishRequest.status).toBe("pending_review");
  await page.goto(`/api/dev/sign-in?handle=admin-${stamp}&role=admin&redirect=/admin/publish-requests`);
  const rowThree = page.locator("article").filter({ hasText: `${name} 0.3.0` });
  await rowThree.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(rowThree.getByText("Approved", { exact: true })).toBeVisible();
});

// A blocker can appear AFTER the box is ticked, because approving a sibling release is an ordinary
// next action in this same queue — and when it does, the explanation replaces the checkbox. If the
// armed intent were merely remembered rather than derived, this row's only takedown control would
// keep sending releaseNameClaim, 422 on every click with no visible control to disarm it, and the
// approved release could not be taken down at all from the review queue.
test("web publish: a ticked release lever disarms when a sibling release makes it illegal", async ({ page }, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const slug = `e2e-disarm-${stamp}`;
  const name = packNameFor(slug);
  const repoUrl = repoUrlFor(slug);

  await page.goto(`/api/dev/sign-in?handle=owner-${stamp}&redirect=/account`);
  expect(await seedOwnership(page, repoUrl)).toBe(201);
  await submitPublishRequest(page, name, repoUrl);
  await submitPublishRequest(page, name, repoUrl, "0.2.0");

  await page.goto(`/api/dev/sign-in?handle=admin-${stamp}&role=admin&redirect=/admin/publish-requests`);
  const rowOne = page.locator("article").filter({ hasText: `${name} 0.1.0` });
  const rowTwo = page.locator("article").filter({ hasText: `${name} 0.2.0` });

  // Only 0.1.0 is served, so the lever is legal and offered. Arm it.
  await rowOne.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(rowOne.getByText("Approved", { exact: true })).toBeVisible();
  await rowOne.getByLabel(`Release the name claim for ${name}`).check();
  await expect(rowOne.getByRole("button", { name: "Withdraw and unclaim" })).toBeVisible();

  // Approving the sibling makes the release illegal; the checkbox is replaced by the explanation.
  await rowTwo.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(rowTwo.getByText("Approved", { exact: true })).toBeVisible();
  await expect(rowOne.getByText(/is still served/)).toBeVisible();
  await expect(rowOne.getByLabel(`Release the name claim for ${name}`)).toBeHidden();

  // The armed intent went with it: the takedown is an ordinary withdraw again, and it WORKS.
  await expect(rowOne.getByRole("button", { name: "Withdraw and unclaim" })).toBeHidden();
  await expect(rowOne.getByRole("button", { name: "Withdraw", exact: true })).toBeVisible();
  await rowOne.getByLabel(`Withdraw reason for ${name}`).fill("e2e disarmed takedown");
  await rowOne.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(rowOne.getByText("Withdrawn", { exact: true })).toBeVisible();

  // And the claim survived the takedown, because nothing released it.
  await expect(rowTwo.getByText("Approved", { exact: true })).toBeVisible();
});

// The two-segment pack route, end to end through the real server SPA fallback. A scoped name is the
// only shape that can exercise it, and only a direct publish produces one.
test("scoped pack route: /packs/owner/pack deep-links, and the %2F form canonicalizes", async ({ page, browser, baseURL }, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const slug = `e2e-route-${stamp}`;
  const name = packNameFor(slug);
  const repoUrl = repoUrlFor(slug);

  await page.goto(`/api/dev/sign-in?handle=owner-${stamp}&redirect=/account`);
  expect(await seedOwnership(page, repoUrl)).toBe(201);
  await submitPublishRequest(page, name, repoUrl);
  await page.goto(`/api/dev/sign-in?handle=admin-${stamp}&role=admin&redirect=/admin/publish-requests`);
  const row = page.locator("article").filter({ hasText: `${name} 0.1.0` });
  await row.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(row.getByText("Approved", { exact: true })).toBeVisible();

  // Browse from a FRESH context. /catalog.json is served Cache-Control: public, max-age=60 and the
  // SPA fetches it on every mount, so the sign-in and approve navigations above already cached a
  // PRE-approval catalog in this page's HTTP cache — reusing it would render the not-found panel for
  // reasons that have nothing to do with routing.
  const context = await browser.newContext({ baseURL });
  const viewer = await context.newPage();
  const errors = trackRuntimeErrors(viewer);
  try {
    // Deep link, two real path segments. Before this slice the router read this as HOME and rendered
    // the catalog — a silently wrong page, not a 404.
    await viewer.goto(`/packs/${scope}/${slug}`);
    await expect(viewer.getByRole("heading", { name })).toBeVisible();
    // ...and it stays on the canonical URL after hydration (no bounce to the encoded form).
    await expect(viewer).toHaveURL(new RegExp(`/packs/${scope}/${slug}$`));

    // The legacy encoded form still resolves (already-shared links keep working) and is rewritten in
    // place to the canonical one, so a pack has exactly one URL.
    await viewer.goto(`/packs/${scope}%2F${slug}`);
    await expect(viewer.getByRole("heading", { name })).toBeVisible();
    await expect(viewer).toHaveURL(new RegExp(`/packs/${scope}/${slug}$`));

    // A hash survives the canonicalizing replaceState — the ownership-verification callback lands on
    // `#trust`, so dropping it would strand that redirect on the README tab.
    await viewer.goto(`/packs/${scope}%2F${slug}#trust`);
    await expect(viewer).toHaveURL(new RegExp(`/packs/${scope}/${slug}#trust$`));

    // The catalog's own pack links are two-segment anchors, crawlable and cmd-clickable.
    await viewer.goto("/");
    await expect(viewer.locator(`a[href^="/packs/${scope}/${slug}"]`).first()).toBeVisible();

    // A direct-published pack's detail page fires /api/ownership, which used to resolve packKey
    // against the COMMITTED catalog artifact only — and that never contains a `direct--` key, so
    // every direct publish 422'd there. It now resolves against pack_name_claims, so the page is
    // clean and this asserts the whole page rather than tolerating one known failure. (The previous
    // allowance would have passed vacuously once the 422 was gone, leaving the fix uncovered.)
    await expectHealthyPage(viewer, errors);
  } finally {
    await context.close();
  }
});
