// The part of CBOR (RFC 8949) that attestation documents use, written here rather than added as a dependency: unsigned
// and negative integers, byte and text strings, arrays, maps, tags, true, false and null, with definite lengths only
// (an attestation document never uses anything else, and anything else is refused rather than guessed at). Pure, so
// the same file runs on Mynt's server, inside the confidential service and in core/scripts/verify-mynt-enclave.mjs.

export type Cbor = number | bigint | Uint8Array | string | Cbor[] | CborMap | CborTag | boolean | null;
export class CborMap extends Map<Cbor, Cbor> {}
export class CborTag {
  constructor(
    readonly tag: number,
    readonly value: Cbor,
  ) {}
}

export class CborError extends Error {}

const MAX_DEPTH = 32;

export function decodeCbor(input: Uint8Array): Cbor {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let i = 0;
  const need = (n: number) => {
    if (n < 0 || i + n > b.length) throw new CborError("truncated CBOR");
  };
  const head = (): [number, number | bigint, number] => {
    need(1);
    const ib = b[i++];
    const major = ib >> 5;
    const info = ib & 0x1f;
    if (info < 24) return [major, info, info];
    if (info === 24) return (need(1), [major, b[i++], info]);
    if (info === 25) return (need(2), (i += 2), [major, b.readUInt16BE(i - 2), info]);
    if (info === 26) return (need(4), (i += 4), [major, b.readUInt32BE(i - 4), info]);
    if (info === 27) {
      need(8);
      const v = b.readBigUInt64BE(i);
      i += 8;
      return [major, v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v, info];
    }
    throw new CborError("indefinite or reserved CBOR length");
  };
  const size = (n: number | bigint) => {
    if (typeof n === "bigint" || n > b.length) throw new CborError("CBOR length out of range");
    return n;
  };
  const item = (depth: number): Cbor => {
    if (depth > MAX_DEPTH) throw new CborError("CBOR nested too deeply");
    const [major, n, info] = head();
    switch (major) {
      case 0:
        return n;
      case 1:
        return typeof n === "bigint" ? -1n - n : n >= Number.MAX_SAFE_INTEGER ? -1n - BigInt(n) : -1 - n;
      case 2:
      case 3: {
        const len = size(n);
        need(len);
        const v = b.subarray(i, i + len);
        i += len;
        return major === 2 ? new Uint8Array(v) : new TextDecoder("utf-8", { fatal: true }).decode(v);
      }
      case 4: {
        const out: Cbor[] = [];
        for (let k = 0, len = size(n); k < len; k++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const out = new CborMap();
        for (let k = 0, len = size(n); k < len; k++) {
          const key = item(depth + 1);
          if (typeof key !== "string" && typeof key !== "number") throw new CborError("CBOR map keys must be text or integers");
          if (out.has(key)) throw new CborError("duplicate CBOR map key");
          out.set(key, item(depth + 1));
        }
        return out;
      }
      case 6:
        return new CborTag(Number(n), item(depth + 1));
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new CborError("unsupported CBOR simple value or float");
    }
  };
  const v = item(0);
  if (i !== b.length) throw new CborError("trailing bytes after CBOR");
  return v;
}

const headBytes = (major: number, n: number | bigint): Buffer => {
  const m = major << 5;
  const v = BigInt(n);
  if (v < 24n) return Buffer.from([m | Number(v)]);
  if (v < 0x100n) return Buffer.from([m | 24, Number(v)]);
  if (v < 0x10000n) {
    const out = Buffer.alloc(3);
    out[0] = m | 25;
    out.writeUInt16BE(Number(v), 1);
    return out;
  }
  if (v < 0x100000000n) {
    const out = Buffer.alloc(5);
    out[0] = m | 26;
    out.writeUInt32BE(Number(v), 1);
    return out;
  }
  const out = Buffer.alloc(9);
  out[0] = m | 27;
  out.writeBigUInt64BE(v, 1);
  return out;
};

// Encodes with definite lengths, map entries in insertion order (what Sig_structure and test fixtures need).
export function encodeCbor(v: Cbor): Buffer {
  if (v === null) return Buffer.from([0xf6]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  if (typeof v === "number" || typeof v === "bigint") {
    if (typeof v === "number" && !Number.isInteger(v)) throw new CborError("floats aren't supported");
    return BigInt(v) >= 0n ? headBytes(0, v) : headBytes(1, -1n - BigInt(v));
  }
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([headBytes(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([headBytes(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([headBytes(4, v.length), ...v.map(encodeCbor)]);
  if (v instanceof CborTag) return Buffer.concat([headBytes(6, v.tag), encodeCbor(v.value)]);
  if (v instanceof Map) return Buffer.concat([headBytes(5, v.size), ...[...v].flatMap(([k, x]) => [encodeCbor(k), encodeCbor(x)])]);
  throw new CborError("unsupported value");
}

export const cborMap = (entries: [Cbor, Cbor][]) => new CborMap(entries);
