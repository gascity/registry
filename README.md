# Registry

Website for the Gas City pack registry. It reads the public `registry.toml`
catalog used by `gc pack registry search/show` and presents Clawhub-style
browse and detail pages for packs, README content, releases, install commands,
and trust metadata.

Pack authors do not publish directly into this repository. They publish their
own `registry.toml`, then add one pointer to `sources.toml`. The aggregate
catalogs in `public/` are generated from those pointers.

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
- The `Dev sign in` button creates a stable fake Gas City identity.
- Set `REGISTRY_DATA_PATH=/path/to/file.json` to use a different local state
  file.
- Set `REGISTRY_DEV_AUTH=0` to hide the auth stub when testing signed-out
  behavior.

## Quality Gates

```bash
bun run generate:check
bun run typecheck
bun run build
bun run test:e2e
```

## Railway

Railway builds this repository from `Dockerfile` via `railway.toml`.
The runtime image starts the Bun server, serves the built Vite assets, exposes
`/registry.toml` for the CLI, and listens on Railway's `PORT` environment
variable.

Production review/account state requires:

```text
APP_URL=https://registry.gascity.com
DATABASE_URL=postgres://...
SESSION_SECRET=<random secret>
OIDC_ISSUER=https://auth.gascity.com/realms/<realm>
OIDC_CLIENT_ID=<registry client id>
OIDC_CLIENT_SECRET=<registry client secret>
```

When `DATABASE_URL` is absent the server intentionally falls back to the local
JSON store, which is suitable for development but not for production.

The app defaults to the generated aggregate JSON:

```text
public/catalog.json
```

`public/registry.toml` is generated too, so `gc` can consume the same aggregate
as a normal pack registry. Set `VITE_CATALOG_URL` at build time to point at
another generated JSON catalog, or `VITE_REGISTRY_URL` to control the TOML
fallback.

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
