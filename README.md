# Registry

Website for the Gas City pack registry. It reads the public `registry.toml`
catalog used by `gc pack registry search/show` and presents Clawhub-style
browse and detail pages for packs, README content, releases, install commands,
and trust metadata.

Pack authors can submit direct publish requests from a pushed GitHub commit.
The registry validates the upstream pack, stores a synthetic registry-entry
preview for staff review, and merges approved releases into the runtime
aggregate. The older `sources.toml` pointer model remains available as a
manual fallback.

`public/registry.toml` stays compatible with the Gas City registry
implementation. Website-only data such as README content and Open Graph preview
images is synthesized into `public/catalog.json` and `public/og/`.

## Local Development

```bash
bun install
bun run dev
```

`bun run dev` regenerates the aggregate catalog, starts the Bun API on
`127.0.0.1:8081`, and starts Vite on `127.0.0.1:5173`. Vite proxies `/api/*`
to the Bun server, so the browser runs the real account and review API while
frontend edits stay fast.

Local development needs no external services:

- Reviews, sessions, stars, and profile edits are stored in
  `.registry-data/registry.local.json`.
- API tokens are generated from the Account page and stored hashed in the same
  local JSON file.
- Publish requests and staff approvals use the same local JSON store.
- The `Dev sign in` button creates a stable fake Gas City identity.
- Direct publish validation uses `gc pack release hash`; install `gc` locally
  or set `REGISTRY_GC_BIN=/path/to/gc`.
- Set `REGISTRY_DATA_PATH=/path/to/file.json` to use a different local state
  file.
- Set `REGISTRY_DEV_AUTH=0` to hide the auth stub when testing signed-out
  behavior.

Copy `.env.example` to a local untracked env file if you need to test a
non-default configuration. Keep real production values in OpenBao or GitHub
secrets; do not commit them.

To exercise the publish and moderation flows by hand (web form and the `gc` CLI,
including pointing `gc` at a local registry), see
[`docs/manual-testing.md`](docs/manual-testing.md).

## Quality Gates

```bash
bun audit
bun run test:unit
bun run generate:check
bun run typecheck
bun run build
bun run test:e2e
```

## Deployment

The registry runs as a container on the Gas City product Kubernetes cluster,
deployed via GitOps — there is no Railway. `.github/workflows/image.yml` publishes
GHCR images on every push to `main`:
`ghcr.io/gascity/gascity-registry:main-<epoch>` for the standalone site
(`registry.gascity.com`) and `:apex-main-<epoch>` for the panel mounted at
`works.gascity.com/registry/` (the same image built with
`REGISTRY_WEB_BASE=/registry/`). The cluster's Flux image automation rolls out the
newest tag. Postgres runs in-cluster and the app self-migrates on boot. The
Deployments, routing, secrets, and rollout policy live in the infra repo — this
repository carries no Kubernetes manifests.

- `main` is the tested integration branch. CI runs on pushes to `main` and on
  pull requests.
- The scheduled aggregate refresh (`update-registry.yml`) commits generated catalog
  updates back to `main`.

Production runtime configuration and secrets are delivered from OpenBao (via
External Secrets), never committed here. The runtime expects roughly:

```text
APP_URL=https://registry.gascity.com
DATABASE_URL=postgres://...
SESSION_SECRET=<random secret>
REGISTRY_AUTH_PROVIDER=oidc
OIDC_ISSUER=https://auth.gascity.com/realms/<realm>
OIDC_CLIENT_ID=<registry client id>
OIDC_CLIENT_SECRET=<registry client secret>
OIDC_GASCITY_USER_ID_CLAIM=gascity_user_id
OIDC_GASCITY_ACCOUNT_ID_CLAIM=gascity_account_id
OIDC_ENFORCE_BROKER_BOUNDARY=true
REGISTRY_ACCOUNTS_BASE_URL=http://accounts.accounts.svc.cluster.local
REGISTRY_ACCOUNTS_RESOLVER_TOKEN=<registry-identity secret>
REGISTRY_ACCOUNTS_RESOLVE_TIMEOUT_MS=3000
GITHUB_APP_SLUG=<registry GitHub App slug>
GITHUB_APP_CLIENT_ID=<registry GitHub App client id>
GITHUB_APP_CLIENT_SECRET=<registry GitHub App client secret>
GITHUB_APP_WEBHOOK_SECRET=<registry GitHub App webhook secret>
REGISTRY_GC_BIN=/usr/local/bin/gc
```

Production auth is OIDC/Keycloak (`auth.gascity.com`); the `registry-staff` (admin)
and `registry-member` (org publisher) roles ride the id_token. Production also requires the
signed, per-session `idp_connection` claim. GitHub and validated customer `sso-*` brokers remain
nonstaff; privileged roles are honored only on the Gas City SSO rail.
A configured Accounts resolver maps the verified OIDC `sub` to the stable Accounts `user_id`, so
native Registry sessions and Gasworks STS assertions select the same principal. Only an explicit
Accounts unknown-subject response falls back to native-only identity; resolver failures fail login.
The credential is accepted only by Accounts' dedicated `/v0/resolve/registry-user` read seam. When
proxy environment variables are present, the effective `no_proxy` must be `*` so that credential is
never sent through an ambient proxy.
A legacy WorkOS provider still exists in the code (`REGISTRY_AUTH_PROVIDER=workos`) but is not
the deployed path.

When `DATABASE_URL` is absent the server intentionally falls back to the local JSON
store, which is suitable for development but not for production.

The registry stores reviews against `gascity_user_id` — the OIDC `gascity_user_id`
claim when present, otherwise the OIDC `sub`.

Pack ownership uses a GitHub App verification flow. The app should be configured
with:

```text
Callback URL: https://registry.gascity.com/api/ownership/github/callback
Setup URL: https://registry.gascity.com/
Webhook URL: https://registry.gascity.com/api/github/webhook
Repository permissions: Metadata read-only
Webhooks: installation, installation_repositories
Request user authorization during installation: enabled
```

The source code is safe to publish as long as environment values stay out of
git. `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_WEBHOOK_SECRET`, `OIDC_CLIENT_SECRET`,
`DATABASE_URL`, and `SESSION_SECRET` are secrets. The GitHub App slug and client
id are identifiers, but they still live in environment configuration so the same
code can run in local, staging, and production. The registry discards GitHub user
access tokens after each ownership verification and stores only immutable GitHub
owner/repository ids plus the local publisher mapping.

The official GitHub App install URL is:

```text
https://github.com/apps/gas-city-registry-verifier/installations/select_target
```

See [docs/verify-pack-ownership.md](docs/verify-pack-ownership.md) for the
maintainer-facing verification flow.

Direct publishing uses registry API tokens. Authors can let the CLI create and
store a revocable token with the normal registry sign-in flow:

```bash
gc pack registry login
gc pack registry publish path/to/pack
```

The publish endpoint also accepts a short-lived Gasworks STS assertion with
audience `registry` and scope `registry:publish`. This lets a Gasworks-authenticated
CLI publish without creating or storing a second Registry token. The two formats
are dispatched strictly: `gcr_` credentials are checked only by the Registry token
store, while every other bearer is checked only as an STS assertion.

Headless environments can use `gc pack registry login --device`, or pass an existing
token with `GC_REGISTRY_TOKEN`. GitHub Actions can publish without a stored
secret by granting OIDC:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v4
  - run: gc pack registry publish path/to/pack
```

The CLI exchanges GitHub's OIDC token for a 10-minute registry publish token
scoped to the exact repo, commit, pack path, name, and version. The registry
stores only token hashes, short prefixes, labels, optional expiry and scope
metadata, and usage timestamps. Revoked or expired tokens can no longer
authenticate publish requests. Browser sessions remain cookie + CSRF
authenticated; bearer credentials are accepted only by routes that explicitly opt in,
currently `/api/me` introspection and direct publish request creation.

The app defaults to the generated aggregate JSON:

```text
public/catalog.json
```

`public/registry.toml` is generated too, so `gc` can consume the same aggregate
as a normal pack registry. At runtime, approved direct publish requests are
merged into `/registry.toml` and `/catalog.json` before those endpoints are
served. Set `VITE_CATALOG_URL` at build time to point at another generated JSON
catalog, or `VITE_REGISTRY_URL` to control the TOML fallback.

## Adding A Registry Source

Add one source pointer:

```toml
[[source]]
name = "example"
url = "https://raw.githubusercontent.com/example/gascity-packs/main/registry.toml"
```

Then run:

```bash
bun run generate
```

CI checks that `public/registry.toml` and `public/catalog.json` match
`sources.toml`, including generated files in `public/og/`. The scheduled
`Update Aggregate Registry` workflow refreshes the aggregate and commits
changes when upstream registries publish new releases.
