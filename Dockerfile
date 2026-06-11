# Stage 1: build the website and typecheck the server.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ARG VITE_CATALOG_URL
ARG VITE_REGISTRY_URL
RUN bun run build

# Stage 2: serve static assets and /api through the Bun BFF.
FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV REGISTRY_GC_BIN=/usr/local/bin/gc
ARG GASCITY_VERSION=1.2.1
RUN set -eux; \
  apk add --no-cache ca-certificates curl git tar; \
  case "$(uname -m)" in \
    x86_64) gc_arch="amd64" ;; \
    aarch64) gc_arch="arm64" ;; \
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
  esac; \
  gc_archive="gascity_${GASCITY_VERSION}_linux_${gc_arch}.tar.gz"; \
  curl -fsSL \
    "https://github.com/gastownhall/gascity/releases/download/v${GASCITY_VERSION}/${gc_archive}" \
    -o "/tmp/${gc_archive}"; \
  curl -fsSL \
    "https://github.com/gastownhall/gascity/releases/download/v${GASCITY_VERSION}/gascity_${GASCITY_VERSION}_checksums.txt" \
    -o /tmp/gascity_checksums.txt; \
  grep " ${gc_archive}$" /tmp/gascity_checksums.txt \
    | awk '{ print $1 "  /tmp/" $2 }' \
    | sha256sum -c -; \
  tar -xzf "/tmp/${gc_archive}" -C /tmp; \
  install -m 0755 /tmp/gc /usr/local/bin/gc; \
  rm -f "/tmp/${gc_archive}" /tmp/gascity_checksums.txt /tmp/gc
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY server ./server
EXPOSE 8080
CMD ["bun", "server/index.ts"]
