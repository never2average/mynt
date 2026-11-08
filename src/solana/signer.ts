import { Keypair } from "./codec.js";
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

// A key-custody service (Turnkey or Fireblocks style): it holds the key and signs raw messages on request, so
// Mynt never sees the key. A provider integration implements this; none is connected by default.
export interface CustodyServiceClient {
  readonly provider: string;
  signSolanaMessage(address: string, message: Uint8Array): Promise<Uint8Array>;
}

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
    if (sig.length !== 64) throw new Error(`The custody service (${this.client.provider}) returned a malformed signature`);
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
