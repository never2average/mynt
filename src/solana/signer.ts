import { createPublicKey, verify } from "node:crypto";
import { Keypair, pubkeyBytes } from "./codec.js";
import type { Cluster } from "./rpc.js";

// Who signs Mynt's Solana transactions. Every deploy, upgrade and program call goes through one interface, so
// the key can live in Mynt's vault (devnet always; mainnet if the operator chooses it), with a custody service
// that signs without showing Mynt the key, or behind a multisig whose members approve each change.
//
// Devnet signs with Mynt-generated keys sealed under MYNT_VAULT_KEY. Mainnet is off until an admin picks a
// backend and enables the cluster, and the backend itself is ready; until then every mainnet action is refused.

export const SIGNER_BACKENDS = ["devnet-vault", "mainnet-vault", "custody-service", "multisig"] as const;
export type SignerBackend = (typeof SIGNER_BACKENDS)[number];
export const MAINNET_BACKENDS = ["mainnet-vault", "custody-service", "multisig"] as const;
export type MainnetBackend = (typeof MAINNET_BACKENDS)[number];

export interface SolanaSigner {
  readonly backend: SignerBackend;
  readonly cluster: Cluster;
  // The signing key's address: the upgrade authority of what it deploys, and the payer of its fees.
  readonly address: string;
  // An ed25519 signature (64 bytes) over a compiled transaction message.
  sign(message: Uint8Array): Promise<Uint8Array>;
}

// Refusals that say what's missing, for the person who can fix it. Never carries a key or an RPC URL.
export class SignerNotConfigured extends Error {}
export const MAINNET_NOT_CONFIGURED = "Mainnet signer not configured";

// A key Mynt holds, sealed in its vault and opened only to sign.
export class VaultSigner implements SolanaSigner {
  constructor(
    readonly backend: "devnet-vault" | "mainnet-vault",
    readonly cluster: Cluster,
    private readonly keypair: Keypair,
  ) {}
  get address() {
    return this.keypair.address;
  }
  async sign(message: Uint8Array) {
    return this.keypair.sign(message);
  }
}

// Whether `signature` is `address`'s ed25519 signature over `message`.
export function verifyEd25519(address: string, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pubkeyBytes(address)).toString("base64url") }, format: "jwk" });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

// A key-custody service (Turnkey: src/solana/custody/turnkey.ts): it holds the key and signs on request, so
// Mynt never sees the key. Connected when the server sets the provider's variables; none by default.
export interface CustodyServiceClient {
  readonly provider: string;
  // Why it can't sign (a variable missing, a key pair that doesn't match), or null when it can.
  readonly problem?: string | null;
  signSolanaMessage(address: string, message: Uint8Array): Promise<Uint8Array>;
}
export const CUSTODY_PROVIDERS = ["turnkey"] as const;

export class CustodyServiceSigner implements SolanaSigner {
  readonly backend = "custody-service" as const;
  readonly cluster: Cluster = "mainnet";
  constructor(
    readonly address: string,
    private readonly client: CustodyServiceClient | null,
  ) {}
  async sign(message: Uint8Array) {
    if (!this.client)
      throw new SignerNotConfigured(
        `${MAINNET_NOT_CONFIGURED}: the custody-service backend is selected, but no custody provider is connected to this Mynt. An admin can choose mainnet-vault instead with configure_solana_signer.`,
      );
    const sig = await this.client.signSolanaMessage(this.address, message);
    // Never trusted as returned: it must be this address's signature over exactly this message.
    if (!verifyEd25519(this.address, message, sig))
      throw new Error(`The custody service (${this.client.provider}) returned a signature that doesn't verify for ${this.address}; it wasn't used`);
    return sig;
  }
}

// A multisig (Squads style) owns the upgrade authority: Mynt prepares each change and the members approve it as
// a proposal. Mynt never signs as the multisig, so it can't sign directly.
export interface MultisigClient {
  readonly program: string;
  propose(o: { cluster: Cluster; multisig: string; message: Uint8Array; memo: string }): Promise<{ proposal: string }>;
}

export class MultisigSigner implements SolanaSigner {
  readonly backend = "multisig" as const;
  readonly cluster: Cluster = "mainnet";
  constructor(
    readonly address: string, // the multisig's vault, which holds the upgrade authority
    readonly client: MultisigClient | null,
  ) {}
  async sign(): Promise<Uint8Array> {
    throw new SignerNotConfigured(
      this.client
        ? `The multisig backend approves changes by proposal (${this.client.program}); it doesn't sign transactions directly.`
        : `${MAINNET_NOT_CONFIGURED}: the multisig backend is selected, but no multisig client is connected to this Mynt to raise proposals. An admin can choose mainnet-vault instead with configure_solana_signer.`,
    );
  }
}
