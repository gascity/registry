# syntax=docker/dockerfile:1
# Stage 1: build the gc binary used for publish request validation.
FROM golang:1.26.4-alpine AS gc-build
WORKDIR /src/gascity
ARG GASCITY_REF=5e9e27f3d4400f808adbc28c7987c1c4900646b7
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
RUN bun run build

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
EXPOSE 8080
CMD ["bun", "server/index.ts"]
