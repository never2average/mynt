// A fake Turnkey API, in-process on loopback: it checks every request's X-Stamp the way Turnkey documents it
// (base64url JSON {publicKey, scheme, signature}; ECDSA P-256 over SHA-256 of the exact body, DER, hex), and
// signs Solana transactions with real Ed25519 keys it holds, as a Turnkey wallet account would.
import http from "node:http";
import { ECDH, createECDH, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";

const { Keypair, base58Encode } = await import("../dist/solana/codec.js");

// A Turnkey API key pair, as `turnkey generate api-key` prints it: hex scalar and compressed public key.
export function apiKeyPair() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey("hex").padStart(64, "0"), publicKey: ecdh.getPublicKey("hex", "compressed") };
}

// The API key's public half, from the compressed hex in the stamp.
function p256Public(compressedHex) {
  const raw = Buffer.from(ECDH.convertKey(compressedHex, "prime256v1", "hex", "hex", "uncompressed"), "hex");
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") }, format: "jwk" });
}

function readShortVec(b, o) {
  let n = 0;
  let shift = 0;
  for (;;) {
    const x = b[o++];
    n |= (x & 0x7f) << shift;
    if (!(x & 0x80)) return [n, o];
    shift += 7;
  }
}

export async function fakeTurnkey({ organizationId = randomUUID(), apiKey = apiKeyPair() } = {}) {
  const wallet = Keypair.generate(); // the Solana wallet account Turnkey holds
  const state = {
    organizationId,
    apiKey,
    wallet,
    address: wallet.address,
    // How it answers sign requests: "sign" (correctly), "bad-signature", "other-key", "tamper", "reject", "consensus".
    mode: "sign",
    requests: [], // { path, body, headers }
    refusedStamps: 0,
    signed: 0,
    activities: new Map(),
  };
  const activity = (status, extra = {}) => {
    const a = { id: randomUUID(), organizationId, status, type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", ...extra };
    state.activities.set(a.id, a);
    return a;
  };
  const sign = (unsignedHex, signWith) => {
    const wire = Buffer.from(unsignedHex, "hex");
    const [nsig, o] = readShortVec(wire, 0);
    const message = wire.subarray(o + 64 * nsig);
    const signers = [];
    let [nkeys, p] = readShortVec(message, 3);
    for (let i = 0; i < message[0] && i < nkeys; i++, p += 32) signers.push(base58Encode(message.subarray(p, p + 32)));
    const slot = signers.indexOf(signWith);
    if (slot < 0) return null;
    let sig = state.mode === "other-key" ? Keypair.generate().sign(message) : wallet.sign(message);
    if (state.mode === "bad-signature") sig = randomBytes(64);
    const out = Buffer.from(wire);
    Buffer.from(sig).copy(out, o + 64 * slot);
    if (state.mode === "tamper") out[out.length - 1] ^= 1;
    state.signed++;
    return out.toString("hex");
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const reply = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      state.requests.push({ path: req.url, raw: raw.toString("utf8"), headers: req.headers });
      // The stamp: Turnkey checks it against the exact bytes it received.
      let stamp;
      try {
        stamp = JSON.parse(Buffer.from(String(req.headers["x-stamp"] ?? ""), "base64url").toString("utf8"));
      } catch {
        stamp = null;
      }
      const stampOk =
        stamp &&
        stamp.scheme === "SIGNATURE_SCHEME_TK_API_P256" &&
        stamp.publicKey === apiKey.publicKey &&
        typeof stamp.signature === "string" &&
        verify("sha256", raw, { key: p256Public(stamp.publicKey), dsaEncoding: "der" }, Buffer.from(stamp.signature, "hex"));
      if (!stampOk) {
        state.refusedStamps++;
        return reply(401, { code: 16, message: "could not verify api key signature" });
      }
      const body = JSON.parse(raw.toString("utf8"));
      if (body.organizationId !== organizationId) return reply(403, { code: 7, message: "organization mismatch" });
      if (req.method === "POST" && req.url === "/public/v1/submit/sign_transaction") {
        const prm = body.parameters ?? {};
        if (body.type !== "ACTIVITY_TYPE_SIGN_TRANSACTION_V2" || prm.type !== "TRANSACTION_TYPE_SOLANA" || !/^\d+$/.test(body.timestampMs ?? ""))
          return reply(400, { code: 3, message: "invalid request" });
        if (prm.signWith !== wallet.address) return reply(404, { code: 5, message: "wallet account not found" });
        if (state.mode === "reject") return reply(200, { activity: activity("ACTIVITY_STATUS_REJECTED", { failure: { message: "policy denied" } }) });
        const signed = sign(prm.unsignedTransaction, prm.signWith);
        if (!signed) return reply(400, { code: 3, message: "signWith isn't a signer of this transaction" });
        const result = { signTransactionResult: { signedTransaction: signed } };
        if (state.mode === "consensus") return reply(200, { activity: activity("ACTIVITY_STATUS_CONSENSUS_NEEDED", { pendingResult: result }) });
        return reply(200, { activity: activity("ACTIVITY_STATUS_COMPLETED", { result }) });
      }
      if (req.method === "POST" && req.url === "/public/v1/query/get_activity") {
        const a = state.activities.get(body.activityId);
        if (!a) return reply(404, { code: 5, message: "activity not found" });
        // Approved by the second time it's asked about.
        a.polls = (a.polls ?? 0) + 1;
        if (a.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED" && a.polls >= 2) Object.assign(a, { status: "ACTIVITY_STATUS_COMPLETED", result: a.pendingResult });
        const { pendingResult, polls, ...shown } = a;
        void pendingResult;
        void polls;
        return reply(200, { activity: shown });
      }
      reply(404, { code: 5, message: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.baseUrl = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((r) => server.close(r));
  return state;
}
