// A fresh idempotency key for one user action (a click that writes): Mynt and the studio's routes
// take each key once.
export const newIdempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "")
