import { createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

// A self-signed Ed25519 certificate for the service's TLS key, made inside the enclave at boot. No authority vouches
// for it: callers pin its key against the attestation token, which binds its SHA-256 (src/keyhouse.mjs). Node can't
// write certificates, so this encodes the few DER structures one needs; nothing is parsed from outside.

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
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const oid = (hex) => tlv(0x06, Buffer.from(hex, "hex"));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const utcTime = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z", "ascii"));
const ED25519 = seq(oid("2b6570")); // 1.3.101.112
const CN = "550403"; // 2.5.4.3

export function selfSignedEd25519(commonName, now = new Date(), days = 30) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const serial = randomBytes(16);
  // Positive, and with a non-zero first byte: DER refuses a leading zero byte that isn't needed for the sign, which
  // made about one boot in 256 fail to load its own certificate.
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const name = seq(set(seq(oid(CN), utf8(commonName))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, serial),
    ED25519,
    name,
    seq(utcTime(new Date(now.getTime() - 60_000)), utcTime(new Date(now.getTime() + days * 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign(null, tbs, privateKey);
  const der = seq(tbs, ED25519, tlv(0x03, Buffer.from([0]), signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }), spki: createPublicKey(privateKey).export({ type: "spki", format: "der" }) };
}
