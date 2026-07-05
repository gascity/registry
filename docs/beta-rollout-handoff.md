# Registry Beta Rollout — Session Handoff

Handoff for continuing the registry beta rollout + e2e-testing work. This session delivered
**P0, P1, P2, P3.1, P3.2** (all verified against real dependencies); **P3.3, P3.4, P4 remain**
(fully designed). Read this doc + `docs/beta-rollout-plan.md` (esp. its "Session progress"
section) before touching code.

---

## 1. Environment & state (verify first)

- **Worktree:** `/data/projects/registry/.claude/worktrees/prod` — run everything from here. Do NOT
  `cd` to the main checkout.
- **Branch:** `worktree-prod`. **Base for the eventual PR:** `main` (last commit `f412c83`).
- **Uncommitted:** ~27 files (18 modified, 9 new). **Nothing is committed** — the user has not yet
  said to commit. Do not commit/push without an explicit go; if asked, branch off `main`.
- **Real Postgres:** docker container `registry-pgtest` on `127.0.0.1:5434`
  (`user=registry pass=registry db=registry`, superuser — the tests `CREATE DATABASE` per suite).
  If it's gone, restart it:
  ```bash
  docker run -d --name registry-pgtest -e POSTGRES_PASSWORD=registry -e POSTGRES_USER=registry \
    -e POSTGRES_DB=registry -p 5434:5432 postgres:16-alpine
  # wait: docker exec registry-pgtest pg_isready -U registry -d registry
  ```
- **Tooling present:** `gc` on PATH (real-gc e2e), Playwright chromium cached, docker available.

## 2. The verification gate (run the relevant subset after every change; ALL must stay green)

```bash
bun run typecheck
bun run test:unit                       # file-store lanes; fast
# real-Postgres tier (the whole point of P1 — never skip when touching store/auth/publish):
REGISTRY_TEST_DATABASE_URL=postgres://registry:registry@127.0.0.1:5434/registry \
  REGISTRY_TEST_REQUIRE_POSTGRES=1 \
  bun test server/store-conformance.test.ts server/publish-integration.test.ts
bun run test:e2e                        # Playwright; boots server/index.harness.ts
bun run test:cli                        # real gc against the harness (real-gc mode)
bun run build
```
- **After anything that runs `bun run generate` / `build` / `test:e2e`,** `git checkout -- public/catalog.json`
  — `generate` re-fetches live upstream and rewrites it; that file is cron-owned, keep it out of the diff.
- **Discipline (non-negotiable, from the user's directives):** do not claim a task done until its
  verification command has run and you've read the result. Verify against the **real dependency**
  (real Postgres, real gc), not a fake.

## 3. What's DONE (verified) — file pointers

- **P0** — `src/routes/AdminPublishPage.tsx` + `src/lib/api.ts` (ownership-override field for claim-only
  approve); `server/config.ts` (**fail-closed dev-auth** — see gotcha #1); `.env.example`, `package.json`
  dev scripts, `server/index.ts` (provider log), `docs/manual-testing.md`.
- **P1** — `server/index.harness.ts` (fake-injecting e2e entrypoint, triple-guarded vs prod) +
  `/api/dev/seed-ownership` in `server/app.ts`; `server/store-conformance.test.ts` + `server/test-db.ts`
  (File↔Postgres conformance, fresh DB per suite); `.github/workflows/ci.yml` (`services: postgres` +
  `REGISTRY_TEST_REQUIRE_POSTGRES` gate + extract-pinned-gc + `test:cli`); `e2e/publish-flow.spec.ts`
  (full loop + reject); `e2e/cli-publish.test.ts` (real gc); `playwright.config.ts` (boots harness,
  scoped to `*.spec.ts`).
- **P2** — `server/auth.ts` (`REGISTRY_MEMBER_REALM_ROLE`, `identityFromOidcTokenResponse` spoof-defense),
  `server/types.ts` (`assertedOrgMember`, `PublishApprovalDecision`, `isOrgMember`), `server/store.ts`
  (`org_member` column + live-sync in both stores + `isOrgMember` + `ownershipBasis` audit),
  `server/app.ts` (org-member is a 4th accept path in `assertPublishRequestCanMerge`),
  `server/staff-sso.test.ts` + conformance + integration tests. **IdP handoff** is documented in
  `docs/beta-rollout-plan.md` P2 section (external Keycloak realm-as-code — NOT done, can't be verified here).
- **P3.1** — `server/aggregate.ts` (fail-soft render: `RenderOptions {mode, onIssue}`, per-entry
  validate-then-skip, base-artifact fallback; strict is default) + `server/app.ts` (serve paths opt
  into fail-soft, per-handler `reportedCatalogIssues` log-once) + `server/aggregate.test.ts`.
- **P3.2** — `server/types.ts`/`server/store.ts` (`ping()` both impls) + `server/app.ts` (`serveHealth`:
  503 when DB down, 5s cache, 2s timeout, body has `catalogRenderIssues`) + `server/health.test.ts` +
  conformance ping case.

## 4. What REMAINS (designed; specs in `docs/beta-rollout-plan.md` "Session progress")

**Do them in this order. Land P3.3 before enabling any auto-promotion (P3.4).**

### P3.3 — ingest resilience + offline `generate:check` (fully in-repo verifiable)
- Extract `scripts/generate-registry.lib.ts` from the 680-line `scripts/generate-registry.ts` (pure,
  parametric: `readSources(path)`, `aggregateSources`, `normalizeCatalog`, render fns, validators;
  add `IngestWarning`/`AggregateResult` types). `scripts/generate-registry.ts` becomes a thin CLI with
  `--check`/`--strict`/`--sources <path>`/`--out-dir <path>`.
- **Policy:** pack/release-level failure → skip-and-warn (keep the pack's other valid releases);
  source-level failure (fetch/parse/schema) → FATAL; cross-source name collision → first source in
  `sources.toml` order wins (add a precedence comment there). Default exit 0 with warnings on stderr +
  `$GITHUB_STEP_SUMMARY`; `--strict` promotes warnings to exit 1.
- **`generate:check` goes offline:** round-trip vs committed `public/catalog.json` (it embeds every
  fetched byte) + assert `catalog.json` `sources[]` set-equals `sources.toml`. Move the live check to
  `update-registry.yml` (add a `bun run generate:check` self-check step after `generate`).
- New `scripts/generate-registry.test.ts` (good/bad-pack/bad-release/collision/fatal/`--strict` +
  round-trip determinism with `fetch` stubbed to throw). **`package.json`: `test:unit` MUST become**
  `bun test server/*.test.ts scripts/*.test.ts` or the new tests never run in CI.
- Fixtures use `file://` sources (already supported) with `source = "https://example.com/..."` pack
  sources so **zero network** (README enrichment only fetches for `github.com` sources).

### P3.4 — gated auto main→production (decision: **gated auto-promote**) — code + external handoff
- **LOAD-BEARING PREREQ (a real bug the design found):** `update-registry.yml` checks out + pushes with
  the default `GITHUB_TOKEN`, and **GitHub suppresses workflow triggers for `GITHUB_TOKEN` pushes** — so
  the hourly aggregate commits currently run **neither CI nor the image build**. Any "auto-promote on
  green" is a no-op until a `REGISTRY_BOT_TOKEN` (GitHub App / fine-grained PAT, `contents:write`) is
  used for the cron checkout. This is external (create the secret) + a 1-line workflow change.
- New `.github/workflows/promote.yml`: `on: workflow_run [CI] completed, branch main`; require the
  SHA's image build green + last `production-smoke` green; **fast-forward-only** push `main`→`production`
  (halt loudly on divergence); `concurrency` + `workflow_dispatch` kill switch.
- `.github/workflows/image.yml`: build the `production` branch too (`prod-<epoch>`/`apex-prod-<epoch>`
  tags) so BOTH surfaces (Railway from `production`, apex GHCR+Flux) follow `production`, not `main`.
- `.github/workflows/production-smoke.yml`: add a **seeded write-path smoke** — mint a scoped token via
  the existing `POST /api/publish-tokens/github-actions/mint` (GitHub OIDC; **`runs-on: ubuntu-latest`**
  because `server/github-actions.ts` rejects self-hosted-runner OIDC), then create a publish request +
  introspect (proves prod Postgres writes). Leaves one clearly-named `pending` smoke row per run
  (accepted for beta).
- **External handoff (can't verify here):** create `REGISTRY_BOT_TOKEN`; `production` branch protection
  to allow the bot push; switch the Flux `ImagePolicy` in `gascity/infra` from `main-*` to `prod-*`;
  README rollback runbook. Verify in-repo with `actionlint`.

### P4 — moderation robustness (all in-repo verifiable)
- Unpublish/withdraw mutation (the `withdrawn` flag already exists in `aggregate.ts`) — pairs with the
  P3.1 fail-soft render.
- Approve-concurrency: do the conflict/ownership check + status write under one transaction/lock
  (two concurrent conflicting approves can currently both pass the pre-check).
- CLI token expiry + real scoping (device/browser tokens are non-expiring + advertise a cosmetic scope)
  + device-flow phishing context.
- Review-report moderation surface (reports are write-only today; `viewerCanDelete` for moderators has
  no backing endpoint).

## 5. Process & conventions (follow these)
- **Pipeline per phase:** Fable design → Opus implement → **Fable red-team before merge** → fix findings
  → verify. Model routing: **design agents `model: 'fable'`, implementation is the Opus main loop,
  red-team is a Fable-based `Workflow`**. The red-team has already caught a HIGH bug in P0, P1, and P2
  each — do NOT skip it, especially for P3.4 (auth/deploy) and P4 (moderation authz).
- **Phased execution:** ≤5 files per phase, verify between phases (the design docs give explicit phasing).
- **Two divergent stores** (`PostgresRegistryStore` / `FileRegistryStore`): any store change goes in BOTH
  and must pass `store-conformance.test.ts` on BOTH lanes.

## 6. Gotchas / landmines that bit this session
1. **`server/config.ts` dev-auth MUST fail closed** (see memory `registry-devauth-failclosed`): a red-team
   found the first attempt inferred "local" from the *absence* of deploy signals → armed the admin
   backdoor on a bare deploy. Now requires an explicitly-set loopback `APP_URL` + no platform env; `.env.example`
   ships `REGISTRY_DEV_AUTH=0`. Don't loosen without keeping the `dev-session.test.ts` cases green.
2. **`server/app.ts` helpers are hoisted function declarations AFTER an early `return`** inside
   `createRegistryFetchHandler`. Any per-handler `const`/`let` (like `reportedCatalogIssues`,
   `healthCache`) MUST be declared *before* that return, or it's dead code → `ReferenceError` at runtime
   (typecheck won't catch it; a handler-level test will).
3. **`generate` rewrites `public/catalog.json`** from live upstream — revert it after any run.
4. **`res.json()` is typed `unknown` in Bun** — cast when asserting on the body in tests.
5. **Postgres `Row` metadata** — the audit `metadata` jsonb reads as `any`; fine, but `?.` chaining on
   an empty rows[0] needs an existence check.

## 7. Locked decisions (do not re-litigate)
- **D1** auth provider = **OIDC/Keycloak** (not WorkOS). **D2** `@gascity` → **publisher only** (no admin;
  staff approval stays in the loop, D2a). **D2b** org role name = **`registry-member`**.
- **D3** auto-release → **fully automatic to production**, implemented as **gated auto-promote** (CI+image
  green AND last production-smoke green; fast-forward-only; kill switch).
- **D4** e2e backend = **real Postgres in CI + File↔Postgres conformance** (done).

## 8. Resume prompt
See `docs/beta-rollout-resume-prompt.md` (or the prompt the user pastes) — it points here.
