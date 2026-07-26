# syntax=docker/dockerfile:1
# Stage 1: build the gc binary used for publish request validation.
FROM golang:1.26.5-alpine AS gc-build
WORKDIR /src/gascity
# gascity v1.3.3 — includes `gc … --dev-auth` (#3343), which the CLI e2e + manual-testing
# doc rely on. The previous pin predated that flag. Bump in lockstep with the CLI contract.
ARG GASCITY_REF=c954582e7ee3e7ca3b6e05cde0be17729b6c2cd9
RUN apk add --no-cache ca-certificates git
RUN set -eux; \
  git clone --filter=blob:none https://github.com/gastownhall/gascity.git /src/gascity; \
  git checkout "$GASCITY_REF"; \
  CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/gc ./cmd/gc; \
  /out/gc pack release hash --help >/dev/null

# Stage 2: build the website and typecheck the server.
FROM oven/bun:1 AS build
WORKDIR /app
# .npmrc maps @gascity/* to GitHub Packages + reads ${NODE_AUTH_TOKEN}; pass the
# token as a BuildKit secret (never baked into a layer).
COPY package.json bun.lock .npmrc ./
RUN --mount=type=secret,id=gh_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/gh_token)" bun install --frozen-lockfile
COPY . .
ARG VITE_CATALOG_URL
ARG VITE_REGISTRY_URL
# Mount prefix baked into the SPA at build time: "/" -> standalone image
# (registry.gascity.com + the CLI contract); "/registry/" -> the apex-panel image
# framed at works.gascity.com/registry/. CI builds both from this one Dockerfile.
ARG REGISTRY_WEB_BASE=/
RUN REGISTRY_WEB_BASE="$REGISTRY_WEB_BASE" bun run build
# Fail loudly if an apex build (base != "/") didn't actually prefix its assets —
# otherwise a dropped build-arg silently ships the asset-escaping standalone image.
RUN if [ "$REGISTRY_WEB_BASE" != "/" ]; then \
      grep -q "\"${REGISTRY_WEB_BASE}assets/" dist/index.html \
        || { echo "ERROR: build did not emit ${REGISTRY_WEB_BASE}assets/* (REGISTRY_WEB_BASE not applied)" >&2; exit 1; }; \
    fi

# Stage 3: serve static assets and /api through the Bun BFF.
FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV REGISTRY_GC_BIN=/usr/local/bin/gc
RUN apk add --no-cache ca-certificates git
COPY --from=gc-build /out/gc /usr/local/bin/gc
RUN /usr/local/bin/gc pack release hash --help >/dev/null
COPY package.json bun.lock .npmrc ./
RUN --mount=type=secret,id=gh_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/gh_token)" bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
EXPOSE 8080
CMD ["bun", "server/index.ts"]
