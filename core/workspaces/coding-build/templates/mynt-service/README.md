# A service on Mynt

A service other builders plug into their products. It answers one of Mynt's standard service types at

```http
POST /mynt/services/<service type key>
```

and nothing else. Mynt lists it in the Marketplace once it passes Mynt's conformance test.

- `api/contract/service-contract.json` is the service type's contract from Mynt: the input and output JSON Schemas, the
  signature rule and fixture requests. The scaffold puts it there; don't edit it by hand.
- `api/src/handle-service.ts` is the one function to write: `handleService(input) → output`.
- `api/src/vendor-service.ts` does the rest and shouldn't need changing: it verifies `Mynt-Signature` (HMAC-SHA256 over
  `<t>.<raw body>`, at most 300 seconds old, compared in constant time) with `MYNT_VENDOR_SIGNING_SECRET`, checks the
  input against the input schema, calls `handleService`, checks the output against the output schema, and answers.
- `web/` is a small status page. A service has no customer screens.

The endpoint's only authentication is `Mynt-Signature`. It needs no Mynt app key and must never ask for one. Mynt sets
`MYNT_VENDOR_SIGNING_SECRET` on its hosting each time the service is put online; it is never committed.

```sh
npm install
npm run build
npm test        # the signature and schema tests
npm run audit   # the dependency gate (high or critical advisories fail); Mynt runs it on every build too
docker compose up --build
```
