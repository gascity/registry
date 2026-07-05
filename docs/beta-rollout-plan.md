# Registry Beta — Rollout & E2E Testing Plan

Status: proposal (2026-07-04). Backlog for taking the Gas City pack registry to beta.
Grounded in a full-repo audit; `file:line` references are to the state at that date.

## Session progress (2026-07-05) — uncommitted on `fix/registry-mount-base-spa`

**LANDED, red-teamed, and verified** (typecheck · unit · **real-Postgres conformance+integration**
· Playwright e2e · real-`gc` CLI · build — all green):

- **P0** — admin ownership-override UI; **fail-closed dev-auth** (a red-team caught + we fixed a
  HIGH fail-open — see [[registry-devauth-failclosed]]); manual-test doc.
- **P1** — prod-safe fake-injecting harness (`server/index.harness.ts`) + `/api/dev/seed-ownership`;
  **real Postgres in CI + File↔Postgres conformance** (`store-conformance.test.ts`, `test-db.ts`);
  Playwright full publish→moderate→serve + reject; real-`gc` CLI e2e (`e2e/cli-publish.test.ts`).
- **P2** — `registry-member` realm role → live-synced `org_member` (both stores) → publish
  merge-gate accept (publisher-only, no admin), with de-provision + `ownershipBasis` audit;
  userinfo-spoof defense extracted + tested. IdP handoff documented below.
- **P3.1** — **fail-soft catalog render**: one poisoned approved entry can no longer 500
  `/catalog.json`+`/registry.toml`; strict stays at the approve-time gate (`aggregate.ts`,
  `aggregate.test.ts`).
- **P3.2** — **`/health` DB readiness** (`store.ping()`; 503 when DB down; 5s cache + 2s timeout;
  body carries `catalogRenderIssues`).

**REMAINING (designed by Fable, specs ready — safest done in a fresh session to avoid context decay):**

- **P3.3 — ingest resilience + offline `generate:check`.** Extract `scripts/generate-registry.lib.ts`;
  skip-and-warn at the finest failing unit (pack/release skip; source-level fatal; cross-source
  collision first-in-`sources.toml`-wins); `--strict`/`--sources`/`--out-dir` flags; `generate:check`
  goes **offline** (round-trip vs committed `catalog.json` + sources set-equality) so upstream
  moving can't red unrelated PRs; new `scripts/generate-registry.test.ts`; **`package.json` test
  glob must add `scripts/*.test.ts`** or the tests never run in CI.
- **P3.4 — gated auto main→production (decision: gated auto-promote).** LOAD-BEARING PREREQ found:
  `update-registry.yml` pushes with `GITHUB_TOKEN`, which **does not trigger** CI/image builds — so
  the hourly commits run neither today; needs a `REGISTRY_BOT_TOKEN` for the cron checkout. New
  `promote.yml`: on CI success on `main`, require image-build green + last production-smoke green,
  **fast-forward-only** main→production, concurrency + one-click kill switch. `image.yml` builds the
  `production` branch too (`prod-<epoch>`/`apex-prod-<epoch>`) so both surfaces follow `production`.
  Extend `production-smoke.yml` with an OIDC-minted **seeded write-path** smoke (must be
  `runs-on: ubuntu-latest` — the registry rejects self-hosted-runner OIDC). External handoff:
  bot-token secret, `production` branch protection, Flux `ImagePolicy` switch in `gascity/infra`,
  README rollback runbook. Verify in-repo via `actionlint`.
- **P4 — moderation robustness.** Unpublish/withdraw (+ the `withdrawn` flag `aggregate.ts` already
  models) — pairs with P3.1's fail-soft; approve-concurrency transaction/lock; CLI token
  expiry/scoping + device-flow hardening; review-report moderation surface (list/hide).

**Enable-order guardrail:** land P3.1–P3.3 to production BEFORE enabling `promote.yml` — the
auto-promotion firehose must not turn on until fail-soft serve + resilient ingest + real readiness
are already live.

## Goals

- **G1 — auto-release of gascity-packs.** Everything in `gastownhall/gascity-packs`
  is available in the registry via the auto-release pipeline (`sources.toml` → poll →
  aggregate).
- **G2 — org access.** Anyone in the `@gascity` org (`org_internal`) gets writer/owner
  rights for logged-in mutations.
- **G3 — manual testing.** Direct submissions via the web publish form and the `gc` CLI.
- **G4 — e2e harness.** Stand up a local registry and exercise CLI + UI submit / modify /
  moderate to de-risk the manual pass.

## Decisions (locked 2026-07-04)

| # | Decision | Chosen | Implication |
|---|---|---|---|
| D1 | Beta auth provider | **OIDC / Keycloak** (auth.gascity.com) | The `registry-staff` realm-role machinery is live; G2 rides the same rail. Reconcile the stale `.env.example` note ("WorkOS is used in production today"). WorkOS path is not the beta target. |
| D2 | "@gascity → writer/owner" means | **Publisher / writer only** | Org membership satisfies the publish **merge/ownership gate** for the member's own submissions. It does **not** grant `admin`/`moderator` (no access to the staff moderation queue). Smallest blast radius. |
| D3 | Auto-release → production | **Fully automatic to production** | Design auto-promotion (auto `main`→`production` and/or Flux auto-bump), gated on CI green + smoke. Raises the importance of fail-soft catalog render, readiness probe, and post-deploy write-path smoke. |
| D4 | G4 harness fidelity | **Real Postgres in CI + conformance** | Provision ephemeral Postgres in CI; prove `FileStore`↔`PostgresStore` parity; run the harness on Postgres. Closes the core gap. |

Residual sub-decisions (safe defaults chosen; revisit if wrong):
- **D2a — do org publishers auto-merge or still get staff-reviewed?** Default: org
  membership satisfies the ownership gate but **staff approval stays in the loop for beta**
  (relax to auto-merge later). Revisit if org self-serve publish must be instant.
- **D2b — org-claim name (resolved 2026-07-05): `registry-member`.** A Keycloak realm role
  asserted only to verified `@gascity` members, mirroring how `registry-staff` is minted. The
  registry side is implemented; the IdP handoff is under P2 below.

## How it works today (grounded map)

- **Auto-release (G1).** `sources.toml` → `scripts/generate-registry.ts` fetches each
  source's `registry.toml`, validates/normalizes, fetches READMEs + OG, writes
  `public/registry.toml` + `public/catalog.json`. `.github/workflows/update-registry.yml`
  runs it hourly (`17 * * * *`) and commits to **`main`**. All 11 gascity-packs packs are
  already in the committed catalog.
- **Serving.** `/registry.toml` and `/catalog.json` are rendered at request time
  (`app.ts:749-763`) as **baked base file (from sources, in `dist/`) + DB-merged approved
  direct-publishes** (`aggregate.ts:renderRegistryTomlWithApprovedPublishes`). So sources
  packs need a rebuild+deploy to change; direct-publishes go live on approval.
- **Deploy.** `registry.gascity.com` = Railway from the **`production`** branch (rebuilds the
  Dockerfile from source). `works.gascity.com/registry` (apex) = GHCR image from `main` +
  Flux. `main`→`production` merge is the release. `production-smoke.yml` polls read endpoints.
- **Authz.** Roles `user`/`moderator`/`admin` (`types.ts:7`). `admin` only via the SSO
  `registry-staff` realm role (`auth.ts:352`, promote-only `store.ts:772`). Per-pack
  ownership via GitHub-App-verified `pack_ownerships` + `publisher_members`. Org id
  (`gasCityAccountId`) is captured at login but **never used for authz**; `publisher_members`
  is written but never read for authz.
- **Merge gate.** `assertPublishRequestCanMerge` (`app.ts:702`): repo-proven methods
  (`github_actions_oidc`, `github_import`) approve straight through; claim-only
  (`web_session`, `api_token`) need verified repo ownership **or** an
  `ownershipOverrideReason`. The admin Approve button sends no body
  (`AdminPublishPage.tsx:106`) → claim-only web-form publishes can't be approved in the UI.
- **CLI.** Device flow + browser/loopback flow mint `gcr_` personal tokens (non-expiring,
  unscoped despite advertising `scope:"registry:publish"`). Bearer tokens work only on
  `GET /api/me` and `POST /api/publish-requests`. Validation shells out to the real `gc`
  binary (`REGISTRY_GC_BIN`).
- **Store.** Two divergent impls — `PostgresRegistryStore` (`store.ts:470`),
  `FileRegistryStore` (`store.ts:1793`) — **no conformance test**. Every test runs File;
  prod runs Postgres; CI provisions no DB. File store lacks `audit_logs` and enforces no
  DB constraints.

## The e2e gap (why `TESTING.md` would fail this repo)

1. **No real-Postgres test anywhere.** Prod write paths never run against a DB in CI; the two
   "postgres" tests (`publish.test.ts:169`) regex-match SQL strings.
2. **`FileStore` is an unproven double** and silently divergent (no `audit_logs`, no
   constraint enforcement).
3. **The moderation loop has no automated twin.** `e2e/registry.spec.ts` submits without
   `?validate=1`, never approves/rejects, never asserts a pack reaches `/catalog.json`. The
   **reject** path is untested everywhere.
4. **The real `gc` CLI is never driven** (CI only runs `gc … --help`).
5. **Harness seams exist but are unwired.** `createRegistryFetchHandler` accepts injectable
   fakes (gc, GitHub) but the only running entrypoint `server/index.ts` wires none.
6. **Staging security landmines.** `.env.example` ships `REGISTRY_DEV_AUTH=1`; the dev
   backdoor `/api/dev/sign-in?role=admin` is off only when `isProduction`. Non-expiring,
   unscoped CLI tokens; device-code phishing surface.

## Backlog (phased)

Effort: S ≈ <1d, M ≈ 1–3d, L ≈ ~1wk, XL ≈ >1wk.

### P0 — Unblock the manual pass (do first)
- **[S] Web approve override.** Add an `ownershipOverrideReason` field to the admin Approve
  action (`AdminPublishPage.tsx`); server already accepts it. Unblocks the G3 web-form path.
- **[S] Lock the auth provider + kill the staging backdoor.** Assert `REGISTRY_AUTH_PROVIDER=oidc`
  at startup; add a guard/CI check that `REGISTRY_DEV_AUTH` is off in every non-local env;
  reconcile `.env.example`.
- **[S] Local manual-test doc.** `gc` on PATH, network needs, pointing `gc` at a local
  registry + minting a dev token, ownership/override expectations. (Confirm the CLI's
  registry base-URL config in the external `gascity` repo.)

### P1 — G4 harness (the infrastructure investment)
- **[L] Fake-injecting harness entrypoint** (`server/index.harness.ts`): wire the existing
  `createRegistryFetchHandler` seams (fake `gc`, fake GitHub OIDC/App/import/ownership) into
  a running server so out-of-process CLI/UI e2e can exercise validate→approve→merge.
- **[XL] Real Postgres in CI + conformance suite.** `services: postgres` in `ci.yml`; run the
  `publish-integration` assertions against **both** stores; delete the regex-SQL tests.
- **[L] Playwright full loop.** Submit `?validate=1` → approve → assert pack in
  `/catalog.json` + `/registry.toml`; plus a **reject** case. Assert observable state.
- **[L] Real-`gc` CLI e2e driver.** Device/browser login → `gc pack registry publish` →
  assert catalog. Use the CI image's pinned `gc` (`GASCITY_REF`).
- **[M] Dev seed seam.** Dev-only endpoint to seed verified ownership (and later org
  membership) so e2e sets up approvable requests without a real GitHub App.
- **[S] Playwright isolation.** Per-run data path + teardown; account for rate limits.

### P2 — G2 org authorization (publisher/writer)

**Registry side — LANDED (2026-07-05).** A verified `registry-member` realm role in the signed
id_token (recomputed from verified claims only, never userinfo — `auth.ts`) live-syncs onto
`users.org_member` in `ensureUser` (both store impls; losing the role de-provisions on next
login). `store.isOrgMember(userId)` is a 4th accept path in `assertPublishRequestCanMerge`
(`app.ts`): a verified org member's claim-only publish is approvable without a per-repo
ownership record or an override — **publisher-only, no `admin`/`moderator` grant**, and staff
approval stays in the loop (D2a). The approve audit stamps `ownershipBasis` (`org_member` etc.).
Covered by: `staff-sso.test.ts` (derivation + rail independence), `store-conformance.test.ts`
(live-sync + `isOrgMember`, both lanes), `publish-integration.test.ts` (allow + de-provision +
"staff routes still 403 for an org member"). Note vs the original sketch: the claim is **not**
carried on `SessionUser` — the merge gate reads the store, keeping the session payload/mappers
untouched.

**IdP side — REQUIRED HANDOFF (external `gasworks-customers` realm-as-code, not in this repo):**
1. Create realm role `registry-member` in the `gasworks-customers` realm.
2. Grant it to **exactly** verified `@gascity` org members — reuse the `gascity-sso` rail (a
   second hardcoded-role mapper) if that population equals org membership, or a role-bearing
   Keycloak group synced from the org roster if GitHub-logged-in members must also qualify.
3. Negative constraints (the security boundary): NOT a realm default role, NOT self-assignable,
   NOT reachable by a fresh external GitHub self-registration, no composite role grants it.
4. Emit it in `realm_access.roles` of the **id_token** for the `registry` client (rides the same
   `roles` scope mapper `registry-staff` already uses — zero client changes).
5. Revocation: removing the role de-provisions on the member's next registry login (no
   registry-side action).
6. Acceptance: a fresh external GitHub sign-up's decoded id_token has NO `registry-member`; a
   known org member's has it; a removed member loses it on next login.

### P3 — G1 auto-to-prod + rollout safety
- **[M] Auto-promotion.** Automate `main`→`production` (and/or Flux auto-bump on the
  `main-<epoch>` tags) gated on CI green + `production-smoke`. Reconcile the two prod surfaces.
- **[S] Decouple `generate:check` from live upstream.** Pin/snapshot; keep a scheduled
  real-upstream job.
- **[M] Ingest resilience.** Skip-and-report a bad upstream pack instead of stalling all;
  hermetic poller tests via a `file://` fixture source.
- **[M] Seeded write-path prod smoke.** Extend `production-smoke` to create a publish request
  and introspect it against prod Postgres.
- **[M] Fail-soft + readiness.** Catalog render falls back to base on a bad approved entry;
  `/health` pings Postgres; write a rollback runbook.

### P4 — Moderation & robustness (may trail beta)
- **[M] Unpublish/withdraw** mutation for approved direct-publishes (`aggregate.ts` already
  models a `withdrawn` flag).
- **[M] Approve concurrency** under one transaction/lock.
- **[M] CLI token expiry/scoping** + device-flow phishing hardening.
- **[L] Review-report moderation surface** (reports are write-only today).

## Proposed sequence

1. Land **P0** (unblocks hands-on testing immediately).
2. Build the **P1 harness** — one local stack (real Postgres + real `gc` + faked GitHub) that
   both the automated e2e and the manual pass run against.
3. Decide + build **G2 / P2** (needs the IdP realm change).
4. **G1 auto-to-prod + rollout safety (P3)**, then run the real manual pass against a staging
   env backed by the now-green harness.
