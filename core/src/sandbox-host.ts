// The machines Mynt's agents run in (builds, the product desk, governance review, the connector, explorations and
// the mainnet gate), behind one interface so the provider can change and tests can provide a stand-in. Providers
// live in src/sandbox-providers/; sandboxesFromEnv there picks one.

export type SandboxState =
  | "init"
  | "provisioning"
  | "provisioned"
  | "cloning"
  | "ready"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error"
  | "cancelled";

export interface SandboxHost {
  // `snapshot`: boot from a snapshot this host took earlier (see `snapshot`); hosts without snapshots ignore it.
  createSandbox(opts: { name: string; type?: string; ttlSeconds?: number; labels?: Record<string, string>; env?: Record<string, string>; snapshot?: string }): Promise<{ id: string; state: SandboxState }>;
  // Pre-built environments, on hosts that can snapshot a machine (memory and disk) and boot new ones from it.
  snapshot?(id: string, opts: { slug: string; displayName?: string }): Promise<{ snapshotId: string }>;
  deleteSnapshot?(snapshotId: string): Promise<void>;
  // A fingerprint of the host's own first-boot setup, so a snapshot is rebuilt when that setup changes.
  readonly setupFingerprint?: string;
  getSandbox(id: string): Promise<{ id: string; state: SandboxState; error?: string | null }>;
  writeFile(id: string, path: string, content: string): Promise<void>;
  // Many files at once, when the host can do it faster than one by one.
  writeFiles?(id: string, files: Record<string, string>): Promise<void>;
  readFile(id: string, path: string): Promise<string | null>;
  host(id: string, port: number): Promise<{ url: string }>;
  costDollars(id: string): Promise<number>;
  stop(id: string): Promise<void>;
  // Runs a shell command; detached commands return a processId to poll.
  exec(id: string, command: string, opts?: { timeoutSeconds?: number; detached?: boolean }): Promise<{ processId?: number; exitCode: number | null; stdout: string; stderr: string }>;
  commandStatus(id: string, processId: number): Promise<{ running: boolean; exitCode: number | null }>;
  downloadUrl(id: string, path: string, ttlSeconds?: number): Promise<string>;
}
