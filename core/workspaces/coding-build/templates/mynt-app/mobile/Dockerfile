# Build context: the project root. Serves the Expo web export for previews; store builds use your own pipeline.
FROM node:22.11-alpine AS build
WORKDIR /app
COPY . .
RUN npm install --no-audit --no-fund -w mynt-sdk-react-native -w mobile && npm run build -w mynt-sdk-react-native && npm run build -w mobile

FROM caddy:2.8-alpine
# Caddy ships with a file capability to bind low ports; it listens on a high one, and with all capabilities
# dropped and no-new-privileges the kernel won't exec a binary that asks for one, so strip it.
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy && apk del libcap
COPY --from=build /app/mobile/dist /srv
USER 1000
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8081/ || exit 1
CMD ["caddy", "file-server", "--root", "/srv", "--listen", ":8081"]
