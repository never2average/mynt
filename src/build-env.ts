import { createHash, randomBytes } from "node:crypto";
import type { SandboxHost } from "./sandbox-host.js";
import type { Db } from "./db.js";
import { SOLANA_TOOLCHAIN, SOLANA_TOOLCHAIN_SCRIPT, TOOLCHAIN_PINS_SHA256 } from "./solana/toolchain.js";
import { isTransient } from "./transient.js";

// A pre-built Solana build environment. Installing the pinned toolchain (Agave, Anchor, Rust, about 2 GB) and
// pulling Anchor's verifiable-build image takes minutes in every Solana build sandbox and every verify sandbox.
// Where the sandbox host can snapshot a machine (Freestyle: memory and disk, booted with `snapshotId`), Mynt does
// that work once, in a machine of its own that runs nothing but Mynt's scripts, and boots Solana sandboxes from
// the snapshot.
//
// What protects the supply chain is unchanged: the snapshot is made by the same installer, which checks every
// download against its pinned sha256, and the image is pulled by its pinned digest. On top of that, Mynt records a
// hash of what the snapshot holds (the toolchain, the SBF platform tools, Docker's client config and daemon
// config, ~/.cargo, and the image's id, digests and layers) and every sandbox booted from it re-hashes that state
// before use. This is drift detection, not tamper-proofing: it catches a snapshot that isn't what Mynt built (a
// half-written builder, a host-side change, a stale or swapped image) using the snapshot's own python3 and docker,
// so it can't defend against a snapshot whose system tools themselves were subverted. The snapshot is private to
// Mynt's account and built only by Mynt's scripts; anything that doesn't match is wiped and installed afresh.
//
// The snapshot is keyed by the toolchain pins, the scripts that build and check it, the sandbox host's own setup
// and the sandbox type, and is rebuilt when it is older than SOLANA_BUILD_SNAPSHOT_MAX_AGE_DAYS (default 7), so
// the base system's security updates aren't frozen in it. Hosts without snapshots install in each
// sandbox, as before.
//
// A VM booted from a memory snapshot starts with the snapshot's kernel random state. Freestyle documents no VM
// generation ID, so the check mixes a fresh per-VM nonce from Mynt's own CSPRNG (and the VM's clock) into
// /dev/urandom before anything that needs randomness (the sandbox's throwaway wallet) runs. Processes already
// running in the snapshot (dockerd) keep whatever state they had.

const HOME = "/home/user";
export const ENV_FILES = {
  installer: `${HOME}/mynt-solana-toolchain.sh`,
  prep: `${HOME}/mynt-solana-env-prep.sh`,
  state: `${HOME}/mynt-solana-env-state.sh`,
  check: `${HOME}/mynt-solana-env-check.sh`,
  result: `${HOME}/.mynt-solana-env.json`,
  checkLog: `${HOME}/.mynt-solana-env-check.log`,
};
const IMAGE = SOLANA_TOOLCHAIN.anchorImage;

// Prints one hash of everything the environment holds. Run in the sandbox as the agents' user. Fixed paths only:
// nothing from the caller's environment chooses what is hashed. The toolchain's env file is hashed under its own
// name even while the check holds it aside (env.held), so agents can't start before the check passes.
export const SOLANA_ENV_STATE_SCRIPT = String.raw`#!/usr/bin/env bash
set -euo pipefail
python3 -I - "${IMAGE}" <<'PY'
import hashlib, os, stat, subprocess, sys
home = os.path.expanduser("~")
h = hashlib.sha256()
tops = [os.path.join(home, p) for p in (".mynt-solana", ".cache/solana", ".docker", ".cargo")] + ["/etc/docker/daemon.json"]
for top in tops:
    if not os.path.lexists(top):
        h.update(f"absent {top}\n".encode())
        continue
    paths = [top]
    for d, dirs, files in os.walk(top):
        paths += [os.path.join(d, n) for n in dirs + files]
    for p in sorted(paths):
        st = os.lstat(p)
        rel = os.path.relpath(p, home)
        if rel == os.path.join(".mynt-solana", "env.held"):
            rel = os.path.join(".mynt-solana", "env")
        if stat.S_ISLNK(st.st_mode):
            line = f"L {rel} {os.readlink(p)}"
        elif stat.S_ISREG(st.st_mode):
            f = hashlib.sha256()
            with open(p, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    f.update(chunk)
            line = f"F {rel} {st.st_mode & 0o7777:o} {f.hexdigest()}"
        elif stat.S_ISDIR(st.st_mode):
            line = f"D {rel} {st.st_mode & 0o7777:o}"
        else:
            line = f"X {rel}"
        h.update(line.encode() + b"\n")
img = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}} {{json .RepoDigests}} {{json .RootFS.Layers}}", sys.argv[1]], capture_output=True, text=True)
pinned = sys.argv[1].split("@", 1)[1]
if img.returncode != 0 or pinned not in img.stdout:
    h.update(b"I missing\n")
else:
    h.update(f"I {img.stdout.strip()}\n".encode())
print(h.hexdigest())
PY
`;

// Builds the environment in Mynt's own builder machine: the pinned installer (every download checked against its
// sha256), the SBF platform tools a first program build would fetch, and the image by digest. Then the state
// hash Mynt keeps. Writes ~/.mynt-solana-env.json.
export const SOLANA_ENV_PREP_SCRIPT = String.raw`#!/usr/bin/env bash
set -uo pipefail
unset MYNT_SOLANA_HOME
OUT="${ENV_FILES.result}"; LOG="$HOME/.mynt-solana-env-prep.log"; rm -f "$OUT"; : > "$LOG"
START=$(date +%s)
fail() { python3 -c 'import json,sys; print(json.dumps({"ok": False, "error": sys.argv[1][-1500:]}))' "$1" > "$OUT"; exit 1; }
bash "${ENV_FILES.installer}" >> "$LOG" 2>&1 || fail "the toolchain didn't install: $(tail -c 1200 "$LOG")"
. "$HOME/.mynt-solana/env"
# The SBF platform tools cargo-build-sbf fetches on a program's first build (best effort: a build fetches them
# itself when they're missing).
cargo-build-sbf --install-only >> "$LOG" 2>&1 || true
docker pull -q "${IMAGE}" >> "$LOG" 2>&1 || fail "the image didn't pull: $(tail -c 1200 "$LOG")"
# Each sandbox makes its own throwaway wallet for the local validator.
rm -f "$HOME/.config/solana/id.json"
STATE=$(bash "${ENV_FILES.state}" 2>> "$LOG") || fail "the state hash failed: $(tail -c 600 "$LOG")"
python3 -c 'import json,sys; print(json.dumps({"ok": True, "state_sha256": sys.argv[1], "install_seconds": int(sys.argv[2])}))' "$STATE" "$(( $(date +%s) - START ))" > "$OUT"
sync
`;

// Mynt's own wipe: the toolchain, the platform tools and the image, confirmed gone. Prints "wiped" when they are.
export const SOLANA_ENV_WIPE_COMMAND = `rm -rf "$HOME/.mynt-solana" "$HOME/.cache/solana"; docker image rm -f "${IMAGE}" >/dev/null 2>&1; [ ! -e "$HOME/.mynt-solana" ] && [ ! -e "$HOME/.cache/solana" ] && ! docker image inspect "${IMAGE}" >/dev/null 2>&1 && echo wiped`;

// Run first in every sandbox booted from the snapshot, with the hash Mynt kept and a fresh per-VM nonce. The
// toolchain's env file (which agents wait for) is held aside until the check passes. Exits 0 when the state is
// exactly what Mynt built; otherwise wipes it (the installer then runs from scratch, checking every download) and
// exits 3. Mynt treats any other ending as a failure and wipes the sandbox itself.
export const SOLANA_ENV_CHECK_SCRIPT = String.raw`#!/usr/bin/env bash
set -uo pipefail
unset MYNT_SOLANA_HOME
EXPECTED="$1"; NONCE="$2"; ROOT="$HOME/.mynt-solana"; START=$(date +%s)
# Fresh randomness for this VM: its kernel random state came with the snapshot's memory.
{ printf '%s' "$NONCE"; date +%s%N; cat /proc/sys/kernel/random/boot_id 2>/dev/null; } | { sudo -n tee /dev/urandom >/dev/null 2>&1 || cat > /dev/urandom; } 2>/dev/null || true
[ -f "$ROOT/env" ] && mv -f "$ROOT/env" "$ROOT/env.held"
GOT=$(bash "${ENV_FILES.state}" 2>/dev/null || echo unreadable)
if [ "$GOT" = "$EXPECTED" ] && [ -f "$ROOT/env.held" ]; then
  mv -f "$ROOT/env.held" "$ROOT/env"
  . "$ROOT/env"
  [ -f "$HOME/.config/solana/id.json" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$HOME/.config/solana/id.json" >/dev/null
  echo "snapshot-verified in $(( $(date +%s) - START ))s"
  exit 0
fi
echo "snapshot-mismatch ($GOT): reinstalling from the pinned, checksum-verified downloads"
${SOLANA_ENV_WIPE_COMMAND} >/dev/null
exit 3
`;

export const SNAPSHOT_SCRIPTS_SHA256 = createHash("sha256")
  .update([SOLANA_TOOLCHAIN_SCRIPT, SOLANA_ENV_PREP_SCRIPT, SOLANA_ENV_STATE_SCRIPT, SOLANA_ENV_CHECK_SCRIPT].join("\n\0"))
  .digest("hex");

// The environment's key: the pins, every script that makes or checks it, the host's own machine setup and the
// sandbox type.
export function solanaEnvKey(hostSetup = "", sandboxType = "default") {
  return createHash("sha256").update([TOOLCHAIN_PINS_SHA256, SNAPSHOT_SCRIPTS_SHA256, hostSetup, sandboxType].join("\n\0")).digest("hex").slice(0, 16);
}
export const SOLANA_ENV_KEY = solanaEnvKey();

const TABLE = `
  -- Mynt's pre-built Solana environments, one per key: the snapshot sandboxes boot from and the hash of what it
  -- holds, which every sandbox booted from it must reproduce.
  CREATE TABLE IF NOT EXISTS financial_products.solana_build_envs (
    key text PRIMARY KEY,
    pins_sha256 text NOT NULL,
    status text NOT NULL,
    builder_sandbox text,
    builder_process bigint,
    snapshot_id text,
    state_sha256 text,
    install_seconds integer,
    uses integer NOT NULL DEFAULT 0,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    ready_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE financial_products.solana_build_envs ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
`;

// building -> (builder process claimed: builder_process = -1 while starting) -> snapshotting -> ready;
// failed and retired end a row (a failed one is tried again later).
export type SolanaEnvStatus = "building" | "snapshotting" | "ready" | "failed" | "retired";
export interface SolanaEnvRow {
  key: string;
  pins_sha256: string;
  status: SolanaEnvStatus;
  builder_sandbox: string | null;
  builder_process: number | null;
  snapshot_id: string | null;
  state_sha256: string | null;
  install_seconds: number | null;
  uses: number;
  error: string | null;
  created_at: string;
  ready_at: string | null;
  last_used_at: string | null;
  updated_at: string;
}
// What a sandbox booted from the environment needs to check it.
export interface SolanaEnvSnapshot {
  key: string;
  snapshot_id: string;
  state_sha256: string;
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const toRow = (r: Record<string, unknown>): SolanaEnvRow => ({
  ...(r as unknown as SolanaEnvRow),
  builder_process: r.builder_process == null ? null : Number(r.builder_process),
  install_seconds: r.install_seconds == null ? null : Number(r.install_seconds),
  uses: Number(r.uses ?? 0),
  created_at: iso(r.created_at)!,
  ready_at: iso(r.ready_at),
  last_used_at: iso(r.last_used_at),
  updated_at: iso(r.updated_at)!,
});
const BUILD_LIMIT_MS = 90 * 60_000;
const RETRY_AFTER_MS = 60 * 60_000; // a failed build of the environment is tried again lazily after this long
// Another key's snapshot (a server on other pins may still be using it) is deleted only once nothing has booted
// from it for this long.
const OTHER_KEY_IDLE_MS = 6 * 3600_000;
const hash = (s: string) => (/^[0-9a-f]{64}$/.test(s) ? s : "invalid");

export class SolanaBuildEnv {
  private constructor(
    private readonly db: Db,
    private readonly sandboxes: SandboxHost | null,
    private readonly opts: { enabled: boolean; sandboxType: string; key: string; maxAgeMs: number },
  ) {}

  static async open(db: Db, sandboxes: SandboxHost | null, opts: { enabled?: boolean; sandboxType?: string; key?: string; maxAgeDays?: number } = {}) {
    await db.exec(TABLE);
    const sandboxType = opts.sandboxType ?? "default";
    const maxAgeDays = Number.isFinite(opts.maxAgeDays) && opts.maxAgeDays! > 0 ? opts.maxAgeDays! : 7;
    return new SolanaBuildEnv(db, sandboxes, {
      enabled: opts.enabled ?? true,
      sandboxType,
      key: opts.key ?? solanaEnvKey(sandboxes?.setupFingerprint ?? "", sandboxType),
      maxAgeMs: maxAgeDays * 86_400_000,
    });
  }

  get key() {
    return this.opts.key;
  }

  // Snapshots need a host that takes them, and can be turned off (SOLANA_BUILD_SNAPSHOT=off).
  get supported() {
    return this.opts.enabled && !!this.sandboxes?.snapshot && !!this.sandboxes?.deleteSnapshot;
  }

  private async row(key = this.key) {
    const r = (await this.db.query("SELECT * FROM financial_products.solana_build_envs WHERE key = $1", [key])).rows[0] as Record<string, unknown> | undefined;
    return r ? toRow(r) : null;
  }

  async list() {
    return ((await this.db.query("SELECT * FROM financial_products.solana_build_envs ORDER BY created_at DESC LIMIT 20")).rows as Record<string, unknown>[]).map(toRow);
  }

  // The snapshot for the current key, when it's ready and not too old. Asking is what makes one: the first Solana
  // build after a change (or once the snapshot is older than the maximum age) starts the environment's build, and
  // installs as before meanwhile.
  async ready(): Promise<SolanaEnvSnapshot | null> {
    if (!this.supported) return null;
    const r = await this.row();
    if (r?.status === "ready" && r.snapshot_id && r.state_sha256) {
      if (Date.now() - Date.parse(r.ready_at ?? r.created_at) <= this.opts.maxAgeMs) return { key: r.key, snapshot_id: r.snapshot_id, state_sha256: r.state_sha256 };
      // Too old: exactly one server retires it (the conditional update), deletes it and starts the rebuild.
      const claimed = await this.db.query(
        "UPDATE financial_products.solana_build_envs SET status = 'failed', snapshot_id = NULL, error = 'older than the maximum age; rebuilding', updated_at = now() - interval '1 day' WHERE key = $1 AND status = 'ready' AND snapshot_id = $2 RETURNING key",
        [r.key, r.snapshot_id],
      );
      if (claimed.rows.length) {
        await this.sandboxes!.deleteSnapshot!(r.snapshot_id).catch(() => undefined);
        this.preparing = this.prepare().catch(() => null);
      }
      return null;
    }
    if (!r || (r.status === "failed" && Date.now() - Date.parse(r.updated_at) > RETRY_AFTER_MS)) this.preparing = this.prepare().catch(() => null);
    return null;
  }
  preparing: Promise<unknown> | null = null;

  async used(env: SolanaEnvSnapshot) {
    await this.db.query("UPDATE financial_products.solana_build_envs SET uses = uses + 1, last_used_at = now() WHERE key = $1", [env.key]);
  }

  // A snapshot that wouldn't boot or didn't pass its check: stop using it; the next ask builds a new one.
  async invalidate(env: SolanaEnvSnapshot, reason: string) {
    const r = await this.db.query(
      "UPDATE financial_products.solana_build_envs SET status = 'failed', snapshot_id = NULL, error = $2, updated_at = now() WHERE key = $1 AND snapshot_id = $3 AND status = 'ready' RETURNING key",
      [env.key, reason.slice(0, 500), env.snapshot_id],
    );
    if (r.rows.length) await this.sandboxes?.deleteSnapshot?.(env.snapshot_id).catch(() => undefined);
  }

  // Creating a sandbox from the environment. A transient error from the host (a 5xx, a dropped connection) is
  // passed on for the caller to retry, never held against the snapshot; any other failure to boot from it drops it.
  async bootFailed(env: SolanaEnvSnapshot, e: unknown) {
    if (isTransient(e)) throw e;
    await this.invalidate(env, `a sandbox wouldn't boot from it: ${(e as Error).message}`);
  }

  // Starts building the environment for the current key (an admin may force a rebuild).
  async prepare(force = false) {
    if (!this.supported) throw new Error("This deployment's sandbox host can't snapshot machines (or SOLANA_BUILD_SNAPSHOT=off), so each Solana sandbox installs the toolchain itself");
    const current = await this.row();
    if (current && !force && ["building", "snapshotting", "ready"].includes(current.status)) return current;
    // One builder per key, even with two servers asking at once: only the server whose update lands goes on.
    const claimed = await this.db.query(
      `INSERT INTO financial_products.solana_build_envs (key, pins_sha256, status) VALUES ($1, $2, 'building')
       ON CONFLICT (key) DO UPDATE SET status = 'building', builder_sandbox = NULL, builder_process = NULL, snapshot_id = NULL, state_sha256 = NULL,
         install_seconds = NULL, error = NULL, ready_at = NULL, created_at = now(), updated_at = now()
       WHERE financial_products.solana_build_envs.status IN ('failed', 'retired') OR ($3::boolean AND date_trunc('milliseconds', financial_products.solana_build_envs.updated_at) = $4::timestamptz)
       RETURNING key`,
      [this.key, TOOLCHAIN_PINS_SHA256, force, current?.updated_at ?? null],
    );
    if (!claimed.rows.length) return (await this.row())!;
    // What the claim replaced goes now that this server owns the row.
    if (current?.builder_sandbox) await this.sandboxes!.stop(current.builder_sandbox).catch(() => undefined);
    if (current?.snapshot_id) await this.sandboxes!.deleteSnapshot!(current.snapshot_id).catch(() => undefined);
    try {
      // Nothing of any developer's: no env, no secrets, only Mynt's scripts ever run on it.
      const s = await this.sandboxes!.createSandbox({
        name: `mynt-solana-env-${this.key}-${randomBytes(3).toString("hex")}`,
        type: this.opts.sandboxType,
        ttlSeconds: 3 * 3600,
        labels: { mynt_role: "solana-env", mynt_solana_env: this.key },
        env: {},
      });
      await this.set({ builder_sandbox: s.id });
    } catch (e) {
      await this.set({ status: "failed", error: `couldn't start the builder: ${(e as Error).message}` });
    }
    return (await this.row())!;
  }

  private async set(fields: Partial<SolanaEnvRow>, key = this.key) {
    const keys = Object.keys(fields) as (keyof SolanaEnvRow)[];
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    await this.db.query(`UPDATE financial_products.solana_build_envs SET ${sets.join(", ")}, updated_at = now() WHERE key = $1`, [key, ...keys.map((k) => fields[k])]);
  }

  // Called by the build worker: moves the environment's build along, and retires other keys' environments once
  // nothing uses them.
  async tick() {
    if (!this.sandboxes) return;
    const sandboxes = this.sandboxes;
    const others = (
      await this.db.query(
        `SELECT * FROM financial_products.solana_build_envs WHERE key <> $1 AND (
           (status = 'ready' AND COALESCE(last_used_at, ready_at, created_at) < now() - make_interval(secs => $2))
           OR (status IN ('building', 'snapshotting') AND created_at < now() - make_interval(secs => $3)))`,
        [this.key, OTHER_KEY_IDLE_MS / 1000, BUILD_LIMIT_MS / 1000],
      )
    ).rows as Record<string, unknown>[];
    for (const o of others.map(toRow)) {
      const claimed = await this.db.query(
        "UPDATE financial_products.solana_build_envs SET status = 'retired', error = 'another key took over and nothing booted from it for hours', updated_at = now() WHERE key = $1 AND status = $2 AND date_trunc('milliseconds', updated_at) = $3::timestamptz RETURNING key",
        [o.key, o.status, o.updated_at],
      );
      if (!claimed.rows.length) continue;
      if (o.builder_sandbox) await sandboxes.stop(o.builder_sandbox).catch(() => undefined);
      if (o.snapshot_id) await sandboxes.deleteSnapshot?.(o.snapshot_id).catch(() => undefined);
    }
    const r = await this.row();
    if (!r || r.status !== "building" || !r.builder_sandbox) return;
    const fail = async (error: string) => {
      const done = await this.db.query(
        "UPDATE financial_products.solana_build_envs SET status = 'failed', error = $2, updated_at = now() WHERE key = $1 AND status IN ('building', 'snapshotting') AND builder_sandbox = $3 RETURNING key",
        [r.key, error.slice(0, 1500), r.builder_sandbox],
      );
      if (done.rows.length) await sandboxes.stop(r.builder_sandbox!).catch(() => undefined);
    };
    if (Date.now() - Date.parse(r.created_at) > BUILD_LIMIT_MS) return fail("the environment took too long to build");
    if (r.builder_process == null) {
      const state = (await sandboxes.getSandbox(r.builder_sandbox)).state;
      if (state === "error" || state === "cancelled") return fail(`the builder sandbox is ${state}`);
      if (!["ready", "idle", "running"].includes(state)) return;
      // Claimed before it starts (-1), so two servers never both start the prep.
      const claim = await this.db.query(
        "UPDATE financial_products.solana_build_envs SET builder_process = -1, updated_at = now() WHERE key = $1 AND status = 'building' AND builder_sandbox = $2 AND builder_process IS NULL RETURNING key",
        [r.key, r.builder_sandbox],
      );
      if (!claim.rows.length) return;
      await sandboxes.writeFile(r.builder_sandbox, ENV_FILES.installer, SOLANA_TOOLCHAIN_SCRIPT);
      await sandboxes.writeFile(r.builder_sandbox, ENV_FILES.state, SOLANA_ENV_STATE_SCRIPT);
      await sandboxes.writeFile(r.builder_sandbox, ENV_FILES.prep, SOLANA_ENV_PREP_SCRIPT);
      const run = await sandboxes.exec(r.builder_sandbox, `bash ${ENV_FILES.prep}`, { detached: true });
      if (run.processId === undefined) return fail("couldn't start the environment's build");
      await this.set({ builder_process: run.processId });
      return;
    }
    if (r.builder_process < 0) {
      // Another server claimed the start and hasn't recorded the process yet; give it a few minutes.
      if (Date.now() - Date.parse(r.updated_at) > 10 * 60_000) return fail("the environment's build never started");
      return;
    }
    if ((await sandboxes.commandStatus(r.builder_sandbox, r.builder_process)).running) return;
    let result: { ok?: boolean; state_sha256?: string; install_seconds?: number; error?: string } | null = null;
    try {
      result = JSON.parse((await sandboxes.readFile(r.builder_sandbox, ENV_FILES.result)) ?? "null");
    } catch {
      result = null;
    }
    if (!result?.ok || !/^[0-9a-f]{64}$/.test(result.state_sha256 ?? "")) return fail(result?.error ?? "the environment's build ended without a result");
    // One server takes the snapshot.
    const claim = await this.db.query(
      "UPDATE financial_products.solana_build_envs SET status = 'snapshotting', updated_at = now() WHERE key = $1 AND status = 'building' AND builder_sandbox = $2 AND builder_process = $3 RETURNING key",
      [r.key, r.builder_sandbox, r.builder_process],
    );
    if (!claim.rows.length) return;
    let snapshotId: string;
    try {
      // Snapshot the builder as it stands: the toolchain installed and checked, the image pulled.
      ({ snapshotId } = await sandboxes.snapshot!(r.builder_sandbox, {
        slug: `mynt-solana-${this.key}-${randomBytes(3).toString("hex")}`,
        displayName: `Mynt Solana build environment: Agave ${SOLANA_TOOLCHAIN.agave.version}, Anchor ${SOLANA_TOOLCHAIN.anchor.version}, Rust ${SOLANA_TOOLCHAIN.rust.version}`,
      }));
    } catch (e) {
      return fail(`the snapshot failed: ${(e as Error).message}`);
    }
    await this.db.query(
      "UPDATE financial_products.solana_build_envs SET status = 'ready', snapshot_id = $2, state_sha256 = $3, install_seconds = $4, ready_at = now(), updated_at = now() WHERE key = $1 AND status = 'snapshotting'",
      [r.key, snapshotId, result.state_sha256, Number.isFinite(result.install_seconds) ? Math.round(result.install_seconds!) : null],
    );
    await sandboxes.stop(r.builder_sandbox).catch(() => undefined);
  }

  // A sandbox booted from the environment runs these first: Mynt's own copies of the state and check scripts, then
  // the check against the hash Mynt kept, with a fresh nonce for the VM's randomness.
  async writeCheck(sandbox: string) {
    await this.sandboxes!.writeFile(sandbox, ENV_FILES.state, SOLANA_ENV_STATE_SCRIPT);
    await this.sandboxes!.writeFile(sandbox, ENV_FILES.check, SOLANA_ENV_CHECK_SCRIPT);
  }
  checkCommand(env: SolanaEnvSnapshot) {
    return `bash ${ENV_FILES.check} ${hash(env.state_sha256)} ${randomBytes(32).toString("hex")}`;
  }
  // For a sandbox that runs the check in the background (the coding agents'): only 0 (matched) or 3 (wiped by
  // the check) lets the installer go on as it is; any other ending is wiped by Mynt's own command first.
  backgroundCheck(env: SolanaEnvSnapshot) {
    return `${this.checkCommand(env)} > ${ENV_FILES.checkLog} 2>&1; rc=$?; if [ "$rc" != 0 ] && [ "$rc" != 3 ]; then ${SOLANA_ENV_WIPE_COMMAND} >> ${ENV_FILES.checkLog} 2>&1; fi; `;
  }
}
