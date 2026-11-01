# Build context: the project root. Serves the built app and proxies /api to the api service.
FROM node:22.11-alpine AS build
WORKDIR /app
COPY . .
RUN npm install --no-audit --no-fund -w mynt-sdk -w web && npm run build -w mynt-sdk && npm run build -w web

FROM caddy:2.8-alpine
# Caddy ships with a file capability to bind low ports; it listens on a high one, and with all capabilities
# dropped and no-new-privileges the kernel won't exec a binary that asks for one, so strip it.
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy && apk del libcap
COPY --from=build /app/web/dist /srv
COPY web/Caddyfile /etc/caddy/Caddyfile
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/ || exit 1
