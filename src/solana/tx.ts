import { base58Decode, base58Encode, pubkeyBytes } from "./codec.js";

// Legacy Solana transactions, compiled by hand: the message (header, accounts, blockhash, instructions) and the
// signatures in front of it. Plus the instructions Mynt itself sends: the system program's create-account and
// the upgradeable BPF loader's buffer, deploy, upgrade and close.

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SYSVAR_RENT = "SysvarRent111111111111111111111111111111111";
export const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";

// The most a serialized transaction may be.
export const PACKET_DATA_SIZE = 1232;

export interface AccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}
export interface Instruction {
  programId: string;
  keys: AccountMeta[];
  data: Uint8Array;
}

export function shortVec(n: number): number[] {
  const out: number[] = [];
  let rem = n;
  for (;;) {
    let elem = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(elem);
      return out;
    }
    elem |= 0x80;
    out.push(elem);
  }
}

export interface CompiledMessage {
  bytes: Uint8Array;
  signers: string[]; // in the order their signatures go
}

// Payer first, then writable signers, read-only signers, writable and read-only others.
export function compileMessage(payer: string, instructions: Instruction[], recentBlockhash: string): CompiledMessage {
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const note = (k: string, signer: boolean, writable: boolean) => {
    const m = metas.get(k) ?? { signer: false, writable: false };
    metas.set(k, { signer: m.signer || signer, writable: m.writable || writable });
  };
  note(payer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) note(k.pubkey, k.isSigner, k.isWritable);
    note(ix.programId, false, false);
  }
  const rest = [...metas.entries()].filter(([k]) => k !== payer);
  const group = (signer: boolean, writable: boolean) => rest.filter(([, m]) => m.signer === signer && m.writable === writable).map(([k]) => k);
  const keys = [payer, ...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const numSigners = 1 + group(true, true).length + group(true, false).length;
  const index = new Map(keys.map((k, i) => [k, i]));
  const out: number[] = [numSigners, group(true, false).length, group(false, false).length, ...shortVec(keys.length)];
  for (const k of keys) out.push(...pubkeyBytes(k));
  const hash = base58Decode(recentBlockhash);
  if (hash.length !== 32) throw new Error("Bad blockhash");
  out.push(...hash, ...shortVec(instructions.length));
  for (const ix of instructions) {
    out.push(index.get(ix.programId)!, ...shortVec(ix.keys.length), ...ix.keys.map((k) => index.get(k.pubkey)!), ...shortVec(ix.data.length), ...ix.data);
  }
  return { bytes: Uint8Array.from(out), signers: keys.slice(0, numSigners) };
}

// The wire form: signatures (zeros where none is given, e.g. for a simulation) then the message.
export function serializeTransaction(message: CompiledMessage, signatures: Map<string, Uint8Array>): Uint8Array {
  const out: number[] = [...shortVec(message.signers.length)];
  for (const s of message.signers) out.push(...(signatures.get(s) ?? new Uint8Array(64)));
  out.push(...message.bytes);
  return Uint8Array.from(out);
}

export const signatureOf = (tx: Uint8Array) => base58Encode(tx.subarray(1, 65));

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return [...b];
};
const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return [...b];
};

const meta = (pubkey: string, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });

export const system = {
  createAccount(from: string, newAccount: string, lamports: bigint | number, space: number, owner: string): Instruction {
    return {
      programId: SYSTEM_PROGRAM,
      keys: [meta(from, true, true), meta(newAccount, true, true)],
      data: Uint8Array.from([...u32(0), ...u64(lamports), ...u64(space), ...pubkeyBytes(owner)]),
    };
  },
  // For an address someone already sent lamports to: top it up, size it and hand it to its owner program, as the
  // Solana CLI does, instead of a create-account that would fail.
  transfer(from: string, to: string, lamports: bigint | number): Instruction {
    return { programId: SYSTEM_PROGRAM, keys: [meta(from, true, true), meta(to, false, true)], data: Uint8Array.from([...u32(2), ...u64(lamports)]) };
  },
  allocate(account: string, space: number): Instruction {
    return { programId: SYSTEM_PROGRAM, keys: [meta(account, true, true)], data: Uint8Array.from([...u32(8), ...u64(space)]) };
  },
  assign(account: string, owner: string): Instruction {
    return { programId: SYSTEM_PROGRAM, keys: [meta(account, true, true)], data: Uint8Array.from([...u32(1), ...pubkeyBytes(owner)]) };
  },
};

// Sizes of the loader's accounts: a buffer's header (enum tag, an authority option) and the program data's.
export const BUFFER_HEADER = 37;
export const PROGRAM_ACCOUNT_SIZE = 36;
export const PROGRAMDATA_HEADER = 45;

export const loader = {
  initializeBuffer(buffer: string, authority: string): Instruction {
    return { programId: UPGRADEABLE_LOADER, keys: [meta(buffer, false, true), meta(authority, false, false)], data: Uint8Array.from(u32(0)) };
  },
  write(buffer: string, authority: string, offset: number, bytes: Uint8Array): Instruction {
    return {
      programId: UPGRADEABLE_LOADER,
      keys: [meta(buffer, false, true), meta(authority, true, false)],
      data: Uint8Array.from([...u32(1), ...u32(offset), ...u64(bytes.length), ...bytes]),
    };
  },
  deployWithMaxDataLen(o: { payer: string; programData: string; program: string; buffer: string; authority: string; maxDataLen: number }): Instruction {
    return {
      programId: UPGRADEABLE_LOADER,
      keys: [
        meta(o.payer, true, true),
        meta(o.programData, false, true),
        meta(o.program, false, true),
        meta(o.buffer, false, true),
        meta(SYSVAR_RENT, false, false),
        meta(SYSVAR_CLOCK, false, false),
        meta(SYSTEM_PROGRAM, false, false),
        meta(o.authority, true, false),
      ],
      data: Uint8Array.from([...u32(2), ...u64(o.maxDataLen)]),
    };
  },
  upgrade(o: { programData: string; program: string; buffer: string; spill: string; authority: string }): Instruction {
    return {
      programId: UPGRADEABLE_LOADER,
      keys: [
        meta(o.programData, false, true),
        meta(o.program, false, true),
        meta(o.buffer, false, true),
        meta(o.spill, false, true),
        meta(SYSVAR_RENT, false, false),
        meta(SYSVAR_CLOCK, false, false),
        meta(o.authority, true, false),
      ],
      data: Uint8Array.from(u32(3)),
    };
  },
  close(account: string, recipient: string, authority: string): Instruction {
    return { programId: UPGRADEABLE_LOADER, keys: [meta(account, false, true), meta(recipient, false, true), meta(authority, true, false)], data: Uint8Array.from(u32(5)) };
  },
};

// The most program bytes one Write can carry: one signature (the authority pays), three accounts (authority,
// buffer, loader), the blockhash and the Write's own header, under the packet limit.
export const WRITE_CHUNK = PACKET_DATA_SIZE - (1 + 64) - (3 + 1 + 3 * 32 + 32) - (1 + 1 + 1 + 2 + 2 + 16);
