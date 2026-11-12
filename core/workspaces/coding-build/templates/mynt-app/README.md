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
