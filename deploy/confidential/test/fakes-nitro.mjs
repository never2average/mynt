import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createPublicKey, publicEncrypt, constants, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CborMap, CborTag, decodeCbor, encodeCbor } from "../src/shared/cbor.js";

// Stand-ins for the Nitro side, for tests only: a security module that signs attestation documents (COSE_Sign1, ES384)
// with a test authority's chain instead of AWS's, and a KMS that enforces a PCR0 condition the way the key policy
// does and answers attested calls with CMS EnvelopedData. Core's tests (core/test/confidential.test.js) use these too.

export const PCRS = { pcr0: "a0".repeat(48), pcr1: "a1".repeat(48), pcr2: "a2".repeat(48) };
export const KEY_ARN = "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";

// A root, an intermediate and a signing certificate, P-384, made with the openssl CLI.
export function testNitroChain() {
  const dir = mkdtempSync(join(tmpdir(), "nitro-chain-"));
  const ssl = (...a) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  writeFileSync(join(dir, "leaf.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n");
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-384", "-nodes"];
  ssl("req", "-x509", ...ec, "-keyout", "root.key", "-out", "root.crt", "-days", "2", "-subj", "/CN=test-nitro-root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  ssl("req", ...ec, "-keyout", "inter.key", "-out", "inter.csr", "-subj", "/CN=test-nitro-intermediate");
  ssl("x509", "-req", "-in", "inter.csr", "-CA", "root.crt", "-CAkey", "root.key", "-CAcreateserial", "-out", "inter.crt", "-days", "2", "-extfile", "ca.ext");
  ssl("req", ...ec, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=test-nitro-enclave");
  ssl("x509", "-req", "-in", "leaf.csr", "-CA", "inter.crt", "-CAkey", "inter.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "1", "-extfile", "leaf.ext");
  const der = (f) => execFileSync("openssl", ["x509", "-in", f, "-outform", "DER"], { cwd: dir });
  return { rootPem: readFileSync(join(dir, "root.crt"), "utf8"), root: der("root.crt"), intermediate: der("inter.crt"), leaf: der("leaf.crt"), leafKey: readFileSync(join(dir, "leaf.key"), "utf8") };
}

// A security module: documents over `pcrs` (all-zero in debug mode), with the caller's three fields. `over` tampers.
export function fakeNsm({ chain = testNitroChain(), pcrs = PCRS, over = {} } = {}) {
  const issued = [];
  const document = ({ nonce = null, userData = null, publicKey = null }) => {
    const pcrMap = new CborMap();
    for (let i = 0; i < 16; i++) pcrMap.set(i, Buffer.from([pcrs.pcr0, pcrs.pcr1, pcrs.pcr2][i] ?? "00".repeat(48), "hex"));
    const payload = new CborMap([
      ["module_id", "i-0123456789abcdef0-enc0123456789abcdef"],
      ["digest", "SHA384"],
      ["timestamp", over.timestamp ?? Date.now()],
      ["pcrs", pcrMap],
      ["certificate", chain.leaf],
      ["cabundle", over.cabundle ?? [chain.root, chain.intermediate]],
      ["public_key", publicKey ? Buffer.from(publicKey) : null],
      ["user_data", userData ? Buffer.from(userData) : null],
      ["nonce", nonce ? Buffer.from(nonce) : null],
    ]);
    const protectedHeader = encodeCbor(new CborMap([[1, -35]]));
    const body = encodeCbor(payload);
    const toBeSigned = encodeCbor(["Signature1", protectedHeader, new Uint8Array(0), body]);
    let signature = sign("sha384", toBeSigned, { key: over.signingKey ?? chain.leafKey, dsaEncoding: "ieee-p1363" });
    if (over.flipSignature) signature = Buffer.from(signature.map((b, i) => (i === 0 ? b ^ 1 : b)));
    return encodeCbor(new CborTag(18, [protectedHeader, new CborMap(), body, signature]));
  };
  return {
    chain,
    issued,
    async attest(fields) {
      issued.push(fields);
      return document(fields);
    },
  };
}

// ---- CMS EnvelopedData, as KMS returns it to an attested enclave ----

const len = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const ber = (tag, ...parts) => Buffer.concat([Buffer.from([tag, 0x80]), ...parts, Buffer.from([0, 0])]);
const oid = (hex) => tlv(0x06, Buffer.from(hex, "hex"));

// `indefinite`: the BER form (indefinite lengths, the content in chunks), which a parser must also accept.
export function envelopedData(plaintext, rsaPublicKey, { indefinite = false } = {}) {
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-cbc", key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const encKey = publicEncrypt({ key: rsaPublicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  const cons = indefinite ? ber : tlv;
  const oaep = tlv(0x30, oid("2a864886f70d010107"), tlv(0x30, tlv(0xa0, tlv(0x30, oid("608648016503040201"))), tlv(0xa1, tlv(0x30, oid("2a864886f70d010108"), tlv(0x30, oid("608648016503040201"))))));
  const ktri = tlv(0x30, tlv(0x02, Buffer.from([2])), tlv(0x80, randomBytes(20)), oaep, tlv(0x04, encKey));
  const content = indefinite ? ber(0xa0, tlv(0x04, ct.subarray(0, 7)), tlv(0x04, ct.subarray(7))) : tlv(0x80, ct);
  const eci = cons(0x30, oid("2a864886f70d010701"), tlv(0x30, oid("60864801650304012a"), tlv(0x04, iv)), content);
  return cons(0x30, oid("2a864886f70d010703"), cons(0xa0, cons(0x30, tlv(0x02, Buffer.from([2])), tlv(0x31, ktri), eci)));
}

// ---- KMS, as the key policy makes it behave ----

// Allows Decrypt and GenerateDataKey on `keyArn` only with a Recipient whose document reports `allowedPcr0` (the policy's
// kms:RecipientAttestation:ImageSha384 condition), and answers only in CiphertextForRecipient. A request without one
// is denied, as the policy's Deny statement makes it. Documents aren't verified here: the fake trusts its fake module.
export function fakeNitroKms({ allowedPcr0 = PCRS.pcr0, keyArn = KEY_ARN, indefinite = false } = {}) {
  const wrap = randomBytes(32);
  const calls = [];
  const deny = (type) => ({ status: 400, text: JSON.stringify({ __type: `com.amazonaws.kms#${type}`, message: "denied" }) });
  const post = async (headers, body) => {
    const target = headers["x-amz-target"];
    const j = JSON.parse(body);
    calls.push({ target, signed: /^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/[a-z0-9-]+\/kms\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(headers.authorization ?? ""), recipient: !!j.Recipient, context: j.EncryptionContext });
    if (j.KeyId !== keyArn) return deny("NotFoundException");
    if (!j.Recipient?.AttestationDocument || j.Recipient.KeyEncryptionAlgorithm !== "RSAES_OAEP_SHA_256") return deny("AccessDeniedException");
    let top = decodeCbor(Buffer.from(j.Recipient.AttestationDocument, "base64"));
    if (top instanceof CborTag) top = top.value;
    const doc = decodeCbor(top[2]);
    if (Buffer.from(doc.get("pcrs").get(0)).toString("hex") !== allowedPcr0) return deny("AccessDeniedException");
    const rsa = createPublicKey({ key: Buffer.from(doc.get("public_key")), format: "der", type: "spki" });
    const aad = Buffer.from(JSON.stringify(j.EncryptionContext ?? {}));
    const answer = (plaintext, extra = {}) => ({ status: 200, text: JSON.stringify({ KeyId: keyArn, CiphertextForRecipient: envelopedData(plaintext, rsa, { indefinite }).toString("base64"), ...extra }) });
    if (target === "TrentService.GenerateDataKey") {
      const dk = randomBytes(32);
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", wrap, iv);
      c.setAAD(aad);
      const ct = Buffer.concat([c.update(dk), c.final()]);
      return answer(dk, { CiphertextBlob: Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64") });
    }
    if (target === "TrentService.Decrypt") {
      try {
        const b = Buffer.from(j.CiphertextBlob, "base64");
        const d = createDecipheriv("aes-256-gcm", wrap, b.subarray(0, 12));
        d.setAAD(aad);
        d.setAuthTag(b.subarray(12, 28));
        return answer(Buffer.concat([d.update(b.subarray(28)), d.final()]));
      } catch {
        return deny("InvalidCiphertextException");
      }
    }
    return deny("UnsupportedOperationException");
  };
  return { post, calls };
}

export const fakeCredentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "not-a-real-secret", sessionToken: "session" });
