# Manual Testing the Registry (web form + `gc` CLI)

How to exercise the direct-publish and moderation flows by hand against a local registry.
For the broader beta plan see [beta-rollout-plan.md](./beta-rollout-plan.md).

## Prerequisites

- **`gc` on `PATH`** (or set `REGISTRY_GC_BIN=/path/to/gc`). Publish *validation* shells out
  to `gc pack release hash` on the registry host, so without `gc` a submission lands in
  `validation_failed` (with a reason) rather than a clean success.
- **Network** to `github.com` and `raw.githubusercontent.com` — validation fetches the
  upstream `pack.toml`/README at the pinned commit and hashes the repo contents.
- A **local registry running** (below). Local state is a file-backed JSON store; no Postgres,
  WorkOS, or GitHub App is required for the dev-auth path.

## 1. Stand up a local registry

```bash
bun install
bun run dev
```

- App (Vite): `http://127.0.0.1:5173` — proxies `/api`, `/registry.toml`, `/catalog.json`.
- API (Bun): `http://127.0.0.1:8081`.
- State: `.registry-data/registry.local.json` (override with `REGISTRY_DATA_PATH`).
- Dev sign-in is on (`REGISTRY_DEV_AUTH=1`). It is **loopback-only** — the server
  force-disables it in production, on Railway, and on any non-loopback origin.

Sign in with the **Dev sign in** button, or hit the endpoint directly to pick a role:

```
http://127.0.0.1:5173/api/dev/sign-in?role=admin      # staff (moderation queue)
http://127.0.0.1:5173/api/dev/sign-in?role=moderator
http://127.0.0.1:5173/api/dev/sign-in?handle=alice     # a plain user
```

## 2. Web form: publish → moderate

**Pack names are partitioned.** Ingested (first-party) packs are bare-named; every direct publish
must be **scoped** `owner/pack`, where `owner` is the lowercase GitHub owner of the source repo.
Approving anything else is refused:

- `403 PUBLISH_NAME_RESERVED` — an unscoped name with no existing claim. There is no override;
  first-party packs arrive through `sources.toml` ingest, not through publish.
- `403 PUBLISH_SCOPE_MISMATCH` — the scope segment is not the source repo's owner.
- `409 PUBLISH_NAME_OWNER_MISMATCH` — the name is already claimed by a different repo. Releases
  must come from the claimed repo; staff can re-point the claim with a **Name re-pin reason**
  (`namePinOverrideReason`), which is audited with the old and new binding.

So while testing, publish `alice/my-pack` from `github.com/alice/anything`, not `my-pack`.

1. Open `/publish`.
   - **Find packs from GitHub** (recommended) is repo-proven — it approves straight through.
   - **Manual publish request** is *claim-only* — it needs verified ownership or a staff
     override to be approved (see below).
2. Submitting runs validation: on success the request moves to `pending_review`; on failure
   it becomes `validation_failed` with a reason. Note: a failed validation still returns HTTP
   `201`, so **read the status label, not the HTTP code**.
3. Sign in as `admin`, open **Review** (`/admin/publish-requests`), and use Validate / Approve
   / Reject.
   - Repo-proven requests (GitHub import / Actions OIDC) approve with one click.
   - Claim-only requests (manual web form / API token) show an **Ownership override reason**
     field next to Approve. Fill it to approve a pack whose source-repo ownership isn't
     verified — the reason is audited. (Without it you get a `403 OWNERSHIP_NOT_VERIFIED`.)
4. Approved packs appear immediately in `/registry.toml` and `/catalog.json`, tagged
   `registry = "direct"`.
   - **Reject** is offered only on *pre-approval* states (pending validation / validation failed /
     pending review). An already-approved release is taken down with **Withdraw**, not Reject, so
     it can't be silently un-published out from under pinned clients.
5. **Withdraw (takedown)** an approved pack: on an `approved` request, staff get a **Withdraw**
   button with a **Takedown reason** field. Withdrawing flips it to `withdrawn`, drops it from
   `/registry.toml` and `/catalog.json` on the next request, and records the reason + reviewer in
   the audit log. The `registry_entry` is retained (takedown evidence + input to the reinstatement
   guard). A withdrawn request is terminal — Validate / Approve / Reject are all refused on it.
6. **Reinstate** a withdrawn `name@version` by re-submitting it (a fresh request — dedup ignores
   withdrawn rows):
   - Re-publishing the **identical** commit + hash + ref validates and approves normally; the pack
     is served again.
   - Re-publishing the **same `name@version` with different provenance** (changed commit / hash /
     ref) is refused at approve with `409 PUBLISH_VERSION_WITHDRAWN` — a takedown can't be quietly
     overwritten with swapped bits. This guard is scoped to the withdrawn release's **lineage**
     (same source repo, or same submitter), so a hostile publish-then-takedown cannot burn a
     version number for the repo that actually owns the name.
   - Withdraw also takes an optional `releaseNameClaim` flag, which unclaims the pack name in the
     same transaction. Use it only to free a squatted name — a content takedown should leave the
     name pinned to the repo that owns it.

## 3. CLI: `gc pack registry publish`

The CLI resolves the registry base URL from `--registry-url` → `GC_REGISTRY_URL` → the stored
login default → `https://registry.gascity.com`. Point it at the local API for testing.

**Easiest (localhost only):** `--dev-auth` creates a local dev-auth session before submitting,
pairing with `REGISTRY_DEV_AUTH=1`:

```bash
GC_REGISTRY_URL=http://127.0.0.1:8081 \
  gc pack registry publish <path-to-pack> --dev-auth
# --dev-auth-handle sets the identity (default: local-cli)
```

**Token-based (closer to production):** log in or mint a token, then publish:

```bash
gc pack registry login --registry-url http://127.0.0.1:8081 --device
# ...or create a token on the Account page and:
export GC_REGISTRY_URL=http://127.0.0.1:8081
export GC_REGISTRY_TOKEN=gcr_...
gc pack registry publish <path-to-pack>
```

Useful flags: `--dry-run` (preview the request without submitting), `--validate` (default
`true`; a rejected validation exits non-zero), and `--name` / `--version` / `--ref` /
`--description` overrides. `publish` requires a clean git checkout whose `HEAD` matches the
pack's configured upstream branch.

CLI-submitted packs are *claim-only* (`api_token`), so they need verified ownership or a staff
override at approve time — same as the manual web form.

## 4. Gotchas

- **`gc` missing / offline** → submissions land in `validation_failed` with a reason, not a
  hard error. Install `gc` or set `REGISTRY_GC_BIN`.
- **Rate limits** (per session/IP): publish-request create 20/hr, validate 12/hr, dev sign-in
  20/10min. A heavy manual loop will start getting `429`s.
- **CLI tokens are non-expiring and full-capability.** Revoke them on the Account page when
  you're done testing.
- **Dev-auth is localhost-only** — you cannot use `--dev-auth` (or `/api/dev/sign-in`) against
  `registry.gascity.com` or any deployed origin.

## 5. Aggregate ingest (`sources.toml` → `generate` / `generate:check`)

Separate from direct-publish: `scripts/generate-registry.ts` fetches each `sources.toml` source,
aggregates the packs, and writes `public/registry.toml` + `public/catalog.json` + `public/og/*`.
The hourly `update-registry.yml` cron runs it and commits the result.

- `bun run generate` — fetch upstream and rewrite the committed artifacts. **Resilient ingest:** a
  malformed pack or release is skipped with a `warning:` on stderr (the rest still publish); only a
  source-level failure (fetch / TOML parse / bad schema) is fatal. `--strict` turns any warning into
  a non-zero exit. Reverts note: this rewrites `public/catalog.json` from live upstream — run
  `git checkout -- public/catalog.json` after a local `generate` you didn't mean to keep.
- `bun run generate:check` — **offline**. It reconstructs the catalog from the committed
  `public/catalog.json`, re-renders every artifact, and asserts byte-equality (plus that
  `catalog.json` matches `sources.toml`). It is a **consistency** gate, not a **provenance** one: it
  verifies the committed files are mutually consistent and canonical, *not* that they match live
  upstream. Upstream freshness is the hourly cron's job, so an upstream change never reds an
  unrelated PR. Flags: `--sources <path>` / `--out-dir <path>` for testing against a fixture tree.

## 6. Beta acceptance pass (G3) against production

The sections above use the localhost dev-auth path; the automated e2e suite (`bun run test:e2e`,
`e2e/publish-flow.spec.ts`) is their headless twin. The **acceptance pass** runs the same flows
against the deployed registry at `https://registry.gascity.com`, where the environment differs in
three ways that matter:

- **No dev-auth.** You sign in with **GitHub** (product login) — `/api/dev/sign-in` and the CLI
  `--dev-auth` flag are localhost-only and refused here.
- **Staff is SSO-asserted.** Moderation requires the `registry-staff` realm role; enter the staff
  surface via **`/staff`** (which routes the login through the staff IdP), then open
  `/admin/publish-requests`.
- **A real GitHub App does the ownership/import work.** The `gas-city-registry-verifier` App backs
  both *Find Packs From GitHub* (import) and Trust-tab ownership verification. The e2e/harness fakes
  the GitHub API, so this pass is the **first real exercise of that App's permissions** — the two
  features need different ones (see the publish steps).

Walk it end-to-end and note anything that surprises you (paste raw output/console errors — that
finds the real problem fastest):

- [ ] **Browse (signed out)** — home lists packs; a pack detail page renders README + versions;
      `GET /catalog.json` and `GET /registry.toml` both load, and `pack_count` agrees between them.
- [ ] **Sign in** with GitHub from the header; `/account` shows your handle.
- [ ] **Publish (web) — GitHub import** — `/publish` → **Find Packs From GitHub** → **Find packs**.
      This drives the `gas-city-registry-verifier` App: it scans repos where the App is installed and
      reads each repo's tree + `pack.toml`, which needs the App's **Contents: Read** permission.
      Confirm candidates appear and a submitted one shows `pending_review` and approves repo-proven
      (one click). If the list comes back **empty or errors**, it's almost always the App missing
      **Contents: Read**, or the App not installed on the repo (use the **Install the GitHub App**
      link) — ownership verification would still work, since that path only needs Metadata.
- [ ] **Publish (web) — manual/claim** — *Manual publish request* (claim-only). Confirm it shows
      `pending_review`, or `validation_failed` with a reason (HTTP is still `201` — read the label).
- [ ] **Namespace** — a scoped name matching the source repo's owner (`alice/my-pack` from
      `github.com/alice/...`) approves; an unscoped name is refused `PUBLISH_NAME_RESERVED`, and a
      foreign scope is refused `PUBLISH_SCOPE_MISMATCH`. Neither is overridable.
- [ ] **Verify ownership (Trust tab)** — open a published pack → **Trust** tab → verify via GitHub
      (hits `/api/ownership/github/start`; needs the App's **Metadata: Read** and you being repo
      **admin**). A claim-only request from a verified owner then approves **without** a staff
      override.
- [ ] **Publish (CLI)** — `gc pack registry login --registry-url https://registry.gascity.com
      --device` (or a `gcr_` token from the Account page), then
      `GC_REGISTRY_URL=https://registry.gascity.com gc pack registry publish <pack>`. Confirm the
      request lands in the queue as `api_token` (claim-only).
- [ ] **Moderate** — as staff via `/staff` → `/admin/publish-requests`: approve a repo-proven
      request (one click); approve a claim-only one by filling the **Ownership override reason**;
      reject one and confirm the reason shows and it never serves.
- [ ] **Approved is served** — the approved packs appear in `/catalog.json` + `/registry.toml`
      tagged `registry = "direct"`.
- [ ] **Withdraw** — on an approved request use **Withdraw** + a takedown reason; confirm the badge
      reads **Withdrawn** and the pack leaves `/catalog.json` and `/registry.toml`.
- [ ] **Reinstate** — re-publish the withdrawn `name@version` **identically** → approves and serves
      again; re-publish it with a **changed ref/commit** → refused with `PUBLISH_VERSION_WITHDRAWN`.
- [ ] **Authz** — a signed-in non-staff account cannot open `/admin/publish-requests` (403) and the
      withdraw / approve / reject endpoints refuse it (403).
