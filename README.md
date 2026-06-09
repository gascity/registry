# Registry

Website for the Gas City pack registry. It reads the public `registry.toml`
catalog used by `gc pack registry search/show` and presents Clawhub-style
browse and detail pages for packs and releases.

Pack authors do not publish directly into this repository. They publish their
own `registry.toml`, then add one pointer to `sources.toml`. The aggregate
catalogs in `public/` are generated from those pointers.

## Local Development

```bash
bun install
bun run generate
bun run dev
```

## Quality Gates

```bash
bun run generate:check
bun run typecheck
bun run build
```

## Railway

Railway builds this repository from `Dockerfile` via `railway.toml`.
The runtime image serves the Vite build with Nginx and listens on Railway's
`PORT` environment variable.

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
`sources.toml`. The scheduled `Update Aggregate Registry` workflow refreshes
the aggregate and commits changes when upstream registries publish new releases.
