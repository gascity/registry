# Contributing to Gas City Registry

Gas City Registry is the public website and aggregate catalog for Gas City
packs. It accepts small, focused contributions for source pointers, catalog
generation, UI, account/review behavior, and operational hardening.

## Getting Started

1. Fork the repository.
2. Clone your fork.
3. Install dependencies: `bun install`
4. Start local development: `bun run dev`
5. Open the printed Vite URL.

Local development needs no external services. The API uses
`.registry-data/registry.local.json`, and the UI exposes a dev sign-in path when
`REGISTRY_DEV_AUTH=1`.

## Development Workflow

We use a direct-to-main workflow for trusted maintainers. External contributors
should:

1. Create a feature branch from `main`.
2. Make one focused change.
3. Run the quality gates that match the change.
4. Open a pull request.

Never open a PR from your fork's `main` branch. Use a dedicated branch per PR:

```bash
git checkout -b fix/review-validation upstream/main
git checkout -b docs/ownership-verification upstream/main
```

Suggested prefixes:

- `fix/*`
- `feat/*`
- `refactor/*`
- `docs/*`
- `chore/*`

## Quality Gates

Run these before opening a PR that changes application code, generated catalog
behavior, or dependencies:

```bash
bun audit
bun run generate:check
bun run typecheck
bun run build
bun run test:e2e
```

For source pointer changes, run:

```bash
bun run generate
```

and commit the generated `public/registry.toml`, `public/catalog.json`, and
`public/og/` updates.

## Code Style

- Prefer existing React, Bun, and server patterns.
- Keep route handlers and UI components focused.
- Validate all external input at the API or generator boundary.
- Parameterize database access through the existing store layer.
- Add tests for behavior changes.
- Add comments only when the logic is not self-evident.

## Security

Do not open public issues or PRs for vulnerabilities. Follow
[SECURITY.md](SECURITY.md).

Do not commit secrets. The `.env.example` file documents names only; actual
values belong in OpenBao, Railway, GitHub secrets, or local untracked env files.

## Commit Messages

- Use present tense.
- Keep the first line under 72 characters when practical.
- Use a conventional prefix such as `feat:`, `fix:`, `docs:`, `test:`, or
  `chore:`.
