# Registry

Website for the Gas City pack registry. It reads the public `registry.toml`
catalog used by `gc pack registry search/show` and presents Clawhub-style
browse and detail pages for packs and releases.

## Local Development

```bash
bun install
bun run dev
```

## Quality Gates

```bash
bun run typecheck
bun run build
```

## Railway

Railway builds this repository from `Dockerfile` via `railway.toml`.
The runtime image serves the Vite build with Nginx and listens on Railway's
`PORT` environment variable.

The app defaults to the checked-in first-party catalog snapshot:

```text
public/registry.toml
```

Set `VITE_REGISTRY_URL` at build time to point at another registry catalog, for
example:

```text
https://raw.githubusercontent.com/gastownhall/gascity-packs/main/registry.toml
```

If the configured catalog cannot be fetched, the app tries the canonical raw
GitHub catalog as a fallback.
