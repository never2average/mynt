# Mynt app

One Docker Compose project:

| Part | What it is | Holds |
|---|---|---|
| `api/` | the server (Node, TypeScript) | the app key; mints client sessions, handles webhooks |
| `web/` | the web app (React, Vite) | a client session only |
| `mobile/` | the mobile app (Expo React Native) | a client session only |
| `packages/mynt-sdk/` | the Mynt SDK generated for this app's products | — |

```sh
cp .env.example .env   # your sandbox app key
docker compose up --build              # api + web on http://localhost:8080
docker compose --profile mobile up     # also the Expo web export
```

The device flow: web or mobile asks `POST /api/session` → the api mints a client session for the signed-in
customer with only the actions the app needs → the device runs offers, documents, consents and journeys on it,
and the provider's hosted flows do the regulated steps.

## Pinned dependencies

- `rollup` is pinned to 4.68.5 (`overrides` in `package.json`): 4.68.6 fails to parse `react-dom/client` on Alpine (musl), which the web image builds on ("Code is nested too deeply"). Remove the override once a later Rollup builds the web image again.
- Base images in the Dockerfiles are pinned by digest (`image:tag@sha256:…`), so every build of a commit starts from the same bytes. To move one, change its tag and its digest together: `docker buildx imagetools inspect <image>:<tag>` prints the digest. The stage that ships also takes Alpine's security updates (`apk upgrade`).
- Commit `package-lock.json`: the images install with `npm ci` when it is there, so they get the versions that were tested.

## Checks

`npm run audit` is the dependency gate: `npm audit --omit=dev --audit-level=high`, which fails on a high or critical advisory in a production dependency. Mynt runs the same command on every build, whatever flags the installs use, and also builds these images, lists what is in them (an SBOM each) and scans them: a high or critical vulnerability that a package upgrade or a newer base image would fix stops the build.
