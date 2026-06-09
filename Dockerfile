# Stage 1: build the static website.
FROM oven/bun:1 AS frontend
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ARG VITE_CATALOG_URL
ARG VITE_REGISTRY_URL
RUN bun run build

# Stage 2: serve through Nginx, using Railway's PORT value.
FROM nginx:1.27-alpine
ENV PORT=8080
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=frontend /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
