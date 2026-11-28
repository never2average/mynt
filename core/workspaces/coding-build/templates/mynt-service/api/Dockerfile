# Build context: the project root (compose.yaml).
# Base images are pinned by digest, so every build of this commit starts from the same bytes. To update one, change
# the tag and the digest together (docker buildx imagetools inspect <image>:<tag> prints the digest).
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /app
COPY . .
# npm ci when the lockfile is committed (the same versions everywhere this is built). --no-audit only leaves npm's
# advisory printout out of the install; the dependency gate is `npm run audit` (package.json), which fails on a high
# or critical advisory and which Mynt runs on every build.
# The last step installs again without the build tools, so only what the api runs with ships.
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund -w api; else npm install --no-audit --no-fund -w api; fi \
 && npm run build -w api \
 && npm ci --omit=dev --no-audit --no-fund -w api

FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
# Alpine's security updates since the base image was built. And only node runs here: npm, npx, corepack and yarn
# (and the packages they bundle) stay out of the shipped image.
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/contract ./api/contract
COPY --from=build /app/api/package.json ./api/package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "api/dist/server.js"]
