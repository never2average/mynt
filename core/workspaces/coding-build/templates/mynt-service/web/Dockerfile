# Build context: the project root. Serves the status page and forwards Mynt's requests to the api service.
# Base images are pinned by digest, so every build of this commit starts from the same bytes. To update one, change
# the tag and the digest together (docker buildx imagetools inspect <image>:<tag> prints the digest).
FROM caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
# Caddy ships with a file capability to bind low ports; it listens on a high one, and with all capabilities
# dropped and no-new-privileges the kernel won't exec a binary that asks for one, so strip it.
# Alpine's security updates since the base image was built come first.
RUN apk upgrade --no-cache && apk add --no-cache libcap && setcap -r /usr/bin/caddy && apk del libcap
COPY web/index.html web/status.js /srv/
COPY web/Caddyfile /etc/caddy/Caddyfile
# The container's filesystem is read-only (compose.yaml's x-hardening) and /tmp is its only writable place, so
# Caddy keeps its config autosave and instance id there instead of /config and /data.
ENV XDG_CONFIG_HOME=/tmp/caddy/config XDG_DATA_HOME=/tmp/caddy/data
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/ || exit 1
