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
