---
name: backend
description: "Server-side API design guidance: REST/GraphQL/gRPC surface design, error contracts (RFC 7807), idempotency, pagination, rate limiting, server-side validation, and webhook design — language-agnostic."
license: MIT OR Apache-2.0
version: "1.0.0"
languages: ["TypeScript", "Python", "Go", "C#", "Rust", "Java"]
allowed-tools: ["view_window", "edit_lines", "execute_command", "tool_search"]
triggers:
  - rest api
  - api design
  - endpoint design
  - rfc 7807
  - openapi
  - graphql
  - grpc
  - rate limiting
  - idempotency
  - pagination
  - webhook
  - database schema
  - sql query
  - server-side validation
  - api rest
  - diseño de api
do-not-trigger-on:
  - react component
  - css layout
  - nginx reverse proxy
  - kubernetes manifest
  - electrical panel
  - lease agreement
  - trial balance
  - differential equation
---

# Backend pack


## Workflow

1. **Contract first**: name the resources and their lifecycle before
   writing handlers; the URL grammar is the contract
   (`/invoices/{id}/lines`, verbs via methods, not path segments).
2. **Errors**: one error document shape everywhere — RFC 7807
   problem+json for HTTP APIs. Failures carry `type`, `title`,
   `status`, and a stable machine-readable `code` clients can branch
   on. Never leak stack traces or driver messages.
3. **Idempotency**: all unsafe operations accept an idempotency key;
   replays return the original result, not a duplicate. State the
   retention window (>= 24h) in the API docs.
4. **Pagination**: cursor-based by default (opaque, stable ordering
   key); offset pagination only for small admin tables. Every
   collection response declares its page/cursor shape.
5. **Validation**: parse-then-validate at the boundary — untrusted
   input becomes a typed value once, at the edge; handlers receive
   typed values and never re-validate. Reject unknown fields on write
   endpoints unless the contract says otherwise.
6. **Rate limiting**: keyed by caller identity, answered with 429 +
   `Retry-After`; document limits per endpoint class.
7. **Webhooks**: signed payloads (HMAC with a documented header),
   delivered at-least-once with idempotent consumers, exponential
   backoff retry, and a replay endpoint.
8. **Schema**: migrations are code — reviewed, reversible, and additive
   first (expand → migrate → contract).

## Worked example

Request: *"Design the endpoint to resend a verification email."*

```http
POST /users/{userId}/verification-emails
Idempotency-Key: 7d1c9c3e-1f2a-4b6e

HTTP/1.1 201 Created
Content-Type: application/problem+json  ← only on errors;
                                          201 body is the resource:
{ "id": "ve_01H...", "expiresAt": "2026-09-14T09:00:00Z" }
```

Replaying with the same key returns the same 201 without sending
twice. Errors are problem+json: `429` with `Retry-After` when the user
hit the resend limit; `409` with code `email_already_verified` when
applicable.

## Eval scenario

Prompt: `"Design REST API error responses with RFC 7807 problem
details"`. Expected routing: `backend` (triggers: `rest api`,
`rfc 7807`). First actions: inspect the existing error handling, map
exception classes to problem types, propose one funnel (middleware or
equivalent) with a migration note for current ad-hoc shapes.
