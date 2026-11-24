import { createPublicKey, randomBytes, verify } from "node:crypto";
import { buildFigures, canonicalJson, FLOWS_BASIS, fingerprintOf } from "./figures.js";
import { openSealedStatement } from "./envelope.js";
// One product-health snapshot from a partner's sealed statement, computed where the statement can be opened: inside the
// confidential service, or in-process on the local host until it's deployed. Pure (node:crypto and ./ only), and the
// same file in both places. The statement's plaintext never leaves this function: what comes back is the report (the
// figures for this one product, exactly what product-health.ts would have computed), its fingerprint and a signature
// over the fingerprint by the host's health-attester key.
//
// The statement is checked here as partner-ledger/contract.ts checks a plain one: the firm, the environment, the
// request it answers, the firm's registered key (and never its key for the other environment), a fresh as_of, a reason
// for every null. A statement that fails is a ledger error, never figures.
export const STATEMENT_SCHEMA_ID = "mynt.partner_ledger.v1";
export const HEALTH_ATTESTATION_DOMAIN = "mynt.health_enclave.v1";
export const HEALTH_ATTESTER_KEY = "health-attester";
const MAX_CLOCK_SKEW_MS = 300_000;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s) {
    let n = 0n;
    for (const c of s) {
        const i = B58.indexOf(c);
        if (i < 0)
            throw new Error("not base58");
        n = n * 58n + BigInt(i);
    }
    const bytes = [];
    while (n > 0n) {
        bytes.unshift(Number(n % 256n));
        n /= 256n;
    }
    for (const c of s) {
        if (c !== "1")
            break;
        bytes.unshift(0);
    }
    return Uint8Array.from(bytes);
}
const ed25519 = (raw) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
export function statementMessage(statement) {
    const { signature: _drop, ...unsigned } = statement;
    return Buffer.concat([Buffer.from(STATEMENT_SCHEMA_ID, "utf8"), Buffer.from([0]), Buffer.from(canonicalJson(unsigned), "utf8")]);
}
export const healthAttestationMessage = (fingerprint) => Buffer.concat([Buffer.from(HEALTH_ATTESTATION_DOMAIN, "utf8"), Buffer.from([0]), Buffer.from(fingerprint, "utf8")]);
const isInt = (v) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
// The first failed check's code, or null when the statement can be used.
export function checkOpenedStatement(body, x, now) {
    const s = body;
    if (!s || typeof s !== "object" || s.schema !== STATEMENT_SCHEMA_ID || !Array.isArray(s.products) || typeof s.as_of !== "string" || !s.signature || typeof s.signature.public_key !== "string" || typeof s.signature.value !== "string")
        return "statement_schema";
    for (const p of s.products)
        if (!p || typeof p.product_id !== "string" || !isInt(p.reserves_held_cents) || !isInt(p.customer_obligations_cents))
            return "statement_schema";
    if (s.provider_entity_id !== x.entity_id || s.environment !== x.environment || s.request_id !== x.request_id)
        return "statement_identity";
    if (new Set(s.products.map((p) => p.product_id)).size !== s.products.length)
        return "statement_identity";
    if (!x.public_key || s.signature.public_key !== x.public_key || (x.other_key && s.signature.public_key === x.other_key))
        return "statement_signature";
    let ok = false;
    try {
        ok = verify(null, statementMessage(s), ed25519(base58Decode(x.public_key)), Buffer.from(s.signature.value, "hex"));
    }
    catch {
        ok = false;
    }
    if (!ok)
        return "statement_signature";
    const asOf = new Date(s.as_of).getTime();
    if (Number.isNaN(asOf) || asOf - now.getTime() > MAX_CLOCK_SKEW_MS || now.getTime() - asOf > x.max_age_ms)
        return "statement_clock";
    for (const p of s.products)
        if ((p.reserves_held_cents === null || p.customer_obligations_cents === null) && !(typeof p.reason === "string" && p.reason.trim()))
            return "statement_null_handling";
    return null;
}
export async function computeSealedHealth(input, keys) {
    const now = new Date(input.now);
    let reading;
    let opened = null;
    try {
        opened = openSealedStatement(input.envelope, keys.ingest);
    }
    catch {
        opened = null;
    }
    const code = opened === null ? "statement_unreadable" : input.envelope.provider_entity_id !== input.expect.entity_id || input.envelope.request_id !== input.expect.request_id ? "statement_identity" : checkOpenedStatement(opened, input.expect, now);
    if (code)
        reading = { error: { code, message: "The partner's sealed statement didn't pass the enclave's checks" } };
    else {
        const s = opened;
        const p = s.products.find((x) => x.product_id === input.report.product_id);
        reading = p
            ? { reserves_held_cents: p.reserves_held_cents, customer_obligations_cents: p.customer_obligations_cents, as_of: s.as_of, reason: p.reason }
            : { reserves_held_cents: null, customer_obligations_cents: null, as_of: s.as_of, reason: "The partner's statement didn't cover this product" };
    }
    opened = null;
    const failed = "error" in reading;
    const source = failed ? "unavailable" : "partner_ledger";
    const figures = buildFigures({ reading, flows: input.flows.flows, flowsReason: input.flows.reason, partial: input.flows.partial, withdrawals: input.withdrawals });
    const report = {
        ...input.report,
        salt: randomBytes(32).toString("hex"),
        source,
        live: input.report.live && source === "partner_ledger",
        ledger_as_of: failed ? null : reading.as_of,
        flows_basis: FLOWS_BASIS,
        flows_not_measured: input.flows.not_measured,
        figures,
        notes: [`Computed inside the confidential service (${input.host}) from the partner's sealed statement.`],
    };
    const canonical = canonicalJson(report);
    const fingerprint = fingerprintOf(canonical);
    const signed = await keys.sign(healthAttestationMessage(fingerprint));
    return { report, canonical, fingerprint, ledger_error: code, attestation: { key_name: HEALTH_ATTESTER_KEY, ...signed } };
}
