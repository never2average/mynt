import { findProgramAddress, isAddress, base58Encode, pubkeyBytes } from "./codec.js";
import { anchorDiscriminator } from "./codec.js";

// Who can change a deployed program, judged for holding other people's money: nobody (immutable), or a Squads v4
// multisig vault whose members govern it (no config authority), needing at least two signatures, with a timelock
// between approval and execution long enough for depositors to leave. Anything else can swap the program at once.
//
// Squads v4 (github.com/Squads-Protocol/v4, audited by OtterSec and Neodyme) is read here from its account layout,
// not its code: the Multisig account (state/multisig.rs) is an Anchor account of
//   create_key: Pubkey, config_authority: Pubkey, threshold: u16, time_lock: u32, transaction_index: u64,
//   stale_transaction_index: u64, rent_collector: Option<Pubkey>, bump: u8, members: Vec<{ key: Pubkey, permissions: u8 }>
// and a vault is the PDA ["multisig", multisig, "vault", vault_index: u8] of the Squads program. Its config changes
// (members, threshold, time lock) go through the same proposals and time lock as anything else it signs.

export const SQUADS_V4_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const ZERO = "11111111111111111111111111111111";
// Permission bits of a member (Permission in state/multisig.rs).
const VOTE = 1 << 1;
// The vault indexes Mynt looks for an authority at.
export const MAX_VAULT_INDEX = 15;

export interface SquadsMultisig {
  create_key: string;
  config_authority: string;
  threshold: number;
  time_lock: number;
  members: { key: string; permissions: number }[];
}

export function decodeSquadsMultisig(data: Uint8Array): SquadsMultisig | null {
  const b = Buffer.from(data);
  const disc = Buffer.from(anchorDiscriminator("account", "Multisig"));
  if (b.length < 8 + 32 + 32 + 2 + 4 + 8 + 8 + 1 + 1 + 4 || !b.subarray(0, 8).equals(disc)) return null;
  let o = 8;
  const key = () => {
    const k = base58Encode(b.subarray(o, o + 32));
    o += 32;
    return k;
  };
  const create_key = key();
  const config_authority = key();
  const threshold = b.readUInt16LE(o);
  o += 2;
  const time_lock = b.readUInt32LE(o);
  o += 4 + 8 + 8; // transaction_index, stale_transaction_index
  const hasCollector = b[o];
  o += 1;
  if (hasCollector === 1) o += 32;
  else if (hasCollector !== 0) return null;
  o += 1; // bump
  if (o + 4 > b.length) return null;
  const n = b.readUInt32LE(o);
  o += 4;
  if (n > 1000 || o + n * 33 > b.length) return null;
  const members: SquadsMultisig["members"] = [];
  for (let i = 0; i < n; i++) {
    const k = key();
    members.push({ key: k, permissions: b[o] });
    o += 1;
  }
  return { create_key, config_authority, threshold, time_lock, members };
}

export const squadsVault = (multisig: string, index: number) => findProgramAddress([Buffer.from("multisig"), pubkeyBytes(multisig), Buffer.from("vault"), Buffer.from([index])], SQUADS_V4_PROGRAM)[0];

export type UpgradeLock =
  | { status: "immutable" }
  | { status: "timelocked_multisig"; multisig: string; vault_index: number; threshold: number; voters: number; time_lock_seconds: number }
  | { status: "unlocked"; reason: string };

// `authority`: the program's upgrade authority (null when it has none). `multisig`: the Squads multisig the builder
// says holds it, with its account as read from the chain (null if there isn't one).
export function judgeUpgradeLock(
  authority: string | null,
  multisig: { address: string; account: { owner: string; data: Uint8Array } | null } | null,
  minTimeLockSeconds: number,
): UpgradeLock {
  if (authority === null) return { status: "immutable" };
  if (!multisig) return { status: "unlocked", reason: `the upgrade authority ${authority} can replace the program at once (make it immutable, or a Squads multisig vault, and name the multisig)` };
  if (!isAddress(multisig.address)) return { status: "unlocked", reason: "the multisig named isn't a Solana address" };
  if (!multisig.account || multisig.account.owner !== SQUADS_V4_PROGRAM) return { status: "unlocked", reason: `${multisig.address} isn't a Squads v4 multisig` };
  const m = decodeSquadsMultisig(multisig.account.data);
  if (!m) return { status: "unlocked", reason: `${multisig.address} isn't a Squads v4 multisig account` };
  let index = -1;
  for (let i = 0; i <= MAX_VAULT_INDEX && index < 0; i++) if (squadsVault(multisig.address, i) === authority) index = i;
  if (index < 0) return { status: "unlocked", reason: `the upgrade authority ${authority} isn't one of ${multisig.address}'s vaults (0-${MAX_VAULT_INDEX})` };
  if (m.config_authority !== ZERO) return { status: "unlocked", reason: `the multisig has a config authority (${m.config_authority}) that can change its members, threshold and time lock alone` };
  const voters = m.members.filter((x) => (x.permissions & VOTE) !== 0).length;
  if (m.threshold < 2 || voters < m.threshold) return { status: "unlocked", reason: `the multisig needs ${m.threshold} of ${voters} voting members; at least two signatures are required` };
  if (m.time_lock < minTimeLockSeconds) return { status: "unlocked", reason: `the multisig's time lock is ${m.time_lock}s, under the ${minTimeLockSeconds}s required` };
  return { status: "timelocked_multisig", multisig: multisig.address, vault_index: index, threshold: m.threshold, voters, time_lock_seconds: m.time_lock };
}
