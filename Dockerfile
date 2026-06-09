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
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY server ./server
EXPOSE 8080
CMD ["bun", "server/index.ts"]
