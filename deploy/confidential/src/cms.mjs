import { constants, createDecipheriv, privateDecrypt } from "node:crypto";

// Opens what KMS returns to an attested enclave (CiphertextForRecipient): a CMS EnvelopedData (RFC 5652) whose content
// key is encrypted to the RSA key in the enclave's attestation document (RSAES-OAEP with SHA-256) and whose content is
// AES-CBC. Node has the ciphers but no CMS parser, so this reads the few BER structures one needs, definite or
// indefinite lengths and chunked strings alike, and refuses anything else. The input comes from KMS over TLS; the
// key never leaves this process.

const OID = {
  envelopedData: "2a864886f70d010703",
  rsaesOaep: "2a864886f70d010107",
  "aes-128-cbc": "608648016503040102",
  "aes-192-cbc": "608648016503040116",
  "aes-256-cbc": "60864801650304012a",
};

class CmsError extends Error {}

// One BER element at `at`: its tag byte, whether it's constructed, its content (primitive) or children (constructed).
function read(buf, at, depth = 0) {
  if (depth > 32 || at + 2 > buf.length) throw new CmsError("truncated");
  const tag = buf[at];
  if ((tag & 0x1f) === 0x1f) throw new CmsError("high tag numbers aren't used here");
  const constructed = (tag & 0x20) !== 0;
  let i = at + 1;
  const first = buf[i++];
  if (first === 0x80) {
    if (!constructed) throw new CmsError("indefinite length on a primitive");
    const children = [];
    while (true) {
      if (i + 2 > buf.length) throw new CmsError("unterminated");
      if (buf[i] === 0 && buf[i + 1] === 0) return { tag, constructed, children, end: i + 2 };
      const c = read(buf, i, depth + 1);
      children.push(c);
      i = c.end;
    }
  }
  let len = first;
  if (first & 0x80) {
    const n = first & 0x7f;
    if (n === 0 || n > 4 || i + n > buf.length) throw new CmsError("bad length");
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[i++];
  }
  const end = i + len;
  if (end > buf.length) throw new CmsError("truncated");
  if (!constructed) return { tag, constructed, content: buf.subarray(i, end), end };
  const children = [];
  while (i < end) {
    const c = read(buf, i, depth + 1);
    children.push(c);
    i = c.end;
  }
  if (i !== end) throw new CmsError("overrun");
  return { tag, constructed, children, end };
}

// An OCTET STRING's bytes (or an implicitly tagged one's), joining the chunks of a constructed one.
const octets = (e) => (e.constructed ? Buffer.concat(e.children.map(octets)) : Buffer.from(e.content));
const oidHex = (e) => {
  if (e?.tag !== 0x06) throw new CmsError("expected an object identifier");
  return Buffer.from(e.content).toString("hex");
};
const child = (e, i, tag) => {
  const c = e?.children?.[i];
  if (!c || (tag !== undefined && c.tag !== tag)) throw new CmsError("unexpected structure");
  return c;
};

export function openEnvelopedData(der, rsaPrivateKey) {
  const buf = Buffer.from(der);
  const info = read(buf, 0);
  if (info.end !== buf.length) throw new CmsError("trailing bytes");
  if (oidHex(child(info, 0)) !== OID.envelopedData) throw new CmsError("not enveloped data");
  const env = child(child(info, 1, 0xa0), 0, 0x30);
  const recipients = env.children.find((c) => c.tag === 0x31);
  const encrypted = env.children[env.children.indexOf(recipients) + 1];
  if (!recipients || encrypted?.tag !== 0x30) throw new CmsError("no recipients or content");
  const ktri = child(recipients, 0, 0x30);
  if (recipients.children.length !== 1) throw new CmsError("expected exactly one recipient");
  const keyAlg = ktri.children.at(-2);
  if (oidHex(child(keyAlg, 0)) !== OID.rsaesOaep) throw new CmsError("the content key isn't RSAES-OAEP");
  const encryptedKey = octets(ktri.children.at(-1));
  const contentAlg = child(encrypted, 1, 0x30);
  const cipher = Object.keys(OID).find((k) => k.startsWith("aes-") && OID[k] === oidHex(child(contentAlg, 0)));
  if (!cipher) throw new CmsError("unsupported content cipher");
  const iv = octets(child(contentAlg, 1, 0x04));
  const body = encrypted.children[2];
  if (!body || (body.tag !== 0x80 && body.tag !== 0xa0)) throw new CmsError("no encrypted content");
  const key = privateDecrypt({ key: rsaPrivateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, encryptedKey);
  try {
    const d = createDecipheriv(cipher, key, iv);
    return Buffer.concat([d.update(octets(body)), d.final()]);
  } finally {
    key.fill(0);
  }
}
