import { createHash, randomBytes } from "node:crypto";
import type { BoatClient } from "./boat.js";
import type { Db } from "./db.js";
import { SOLANA_TOOLCHAIN, SOLANA_TOOLCHAIN_SCRIPT, TOOLCHAIN_PINS_SHA256 } from "./solana/toolchain.js";

// A pre-built Solana build environment. Installing the pinned toolchain (Agave, Anchor, Rust, about 2 GB) and
// pulling Anchor's verifiable-build image takes minutes in every Solana build sandbox and every verify sandbox.
// Where the sandbox host can snapshot a machine (Freestyle: memory and disk, booted with `snapshotId`), Mynt does
// that work once, in a machine of its own that runs nothing but Mynt's scripts, and boots Solana sandboxes from
// the snapshot.
//
// The supply-chain checks stay as they were: the snapshot is made by the same installer, which checks every
// download against its pinned sha256, and the image is pulled by its pinned digest. Before the snapshot is taken,
// Mynt's state script hashes everything installed (every file, mode and link of ~/.mynt-solana and the SBF
// platform tools, and the image's id and digests) and Mynt keeps that hash in its own database. Every sandbox
// booted from the snapshot runs the state script again (a fresh copy Mynt writes, never one from the snapshot)
// before anything else, and uses the snapshot only if the hash is the one Mynt kept; otherwise it wipes the
// toolchain and the image and installs from the pinned, checksum-verified downloads as before.
//
// The snapshot is keyed by the toolchain pins and the scripts that build it: when either changes, the old
// snapshot is retired and deleted, and the next Solana build makes a new one (or an admin does, with
// solana_build_environment). Hosts without snapshots (boat.dev) install in each sandbox, as before.

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

// Prints one hash of everything the environment holds. Run in the sandbox as the agents' user.
export const SOLANA_ENV_STATE_SCRIPT = String.raw`#!/usr/bin/env bash
set -euo pipefail
python3 -I - "${IMAGE}" <<'PY'
import hashlib, os, stat, subprocess, sys
home = os.path.expanduser("~")
h = hashlib.sha256()
for top in (os.environ.get("MYNT_SOLANA_HOME") or os.path.join(home, ".mynt-solana"), os.path.join(home, ".cache", "solana")):
    if not os.path.lexists(top):
        h.update(f"absent {top}\n".encode())
        continue
    paths = [top]
    for d, dirs, files in os.walk(top):
        paths += [os.path.join(d, n) for n in dirs + files]
    for p in sorted(paths):
        st = os.lstat(p)
        rel = os.path.relpath(p, home)
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
img = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}} {{json .RepoDigests}}", sys.argv[1]], capture_output=True, text=True)
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
OUT="${ENV_FILES.result}"; LOG="$HOME/.mynt-solana-env-prep.log"; rm -f "$OUT"; : > "$LOG"
START=$(date +%s)
fail() { python3 -c 'import json,sys; print(json.dumps({"ok": False, "error": sys.argv[1][-1500:]}))' "$1" > "$OUT"; exit 1; }
bash "${ENV_FILES.installer}" >> "$LOG" 2>&1 || fail "the toolchain didn't install: $(tail -c 1200 "$LOG")"
. "${"${"}MYNT_SOLANA_HOME:-$HOME/.mynt-solana}/env"
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

// Run first in every sandbox booted from the snapshot, with the hash Mynt kept: the environment is used only if
// it is exactly what Mynt built. Exits 0 when it is; otherwise wipes it (the installer then runs from scratch,
// checking every download) and exits 3.
export const SOLANA_ENV_CHECK_SCRIPT = String.raw`#!/usr/bin/env bash
set -uo pipefail
EXPECTED="$1"; ROOT="${"${"}MYNT_SOLANA_HOME:-$HOME/.mynt-solana}"; START=$(date +%s)
GOT=$(bash "${ENV_FILES.state}" 2>/dev/null || echo unreadable)
if [ "$GOT" = "$EXPECTED" ]; then
  . "$ROOT/env"
  [ -f "$HOME/.config/solana/id.json" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$HOME/.config/solana/id.json" >/dev/null
  echo "snapshot-verified in $(( $(date +%s) - START ))s"
  exit 0
fi
echo "snapshot-mismatch ($GOT): reinstalling from the pinned, checksum-verified downloads"
rm -rf "$ROOT" "$HOME/.cache/solana"
docker image rm -f "${IMAGE}" >/dev/null 2>&1 || true
exit 3
`;

// The environment's key: the pins and every script that makes or checks it.
export const SOLANA_ENV_KEY = createHash("sha256")
  .update([TOOLCHAIN_PINS_SHA256, SOLANA_TOOLCHAIN_SCRIPT, SOLANA_ENV_PREP_SCRIPT, SOLANA_ENV_STATE_SCRIPT].join("\n\0"))
  .digest("hex")
  .slice(0, 16);

const TABLE = `
  -- Mynt's pre-built Solana environments, one per toolchain key: the snapshot sandboxes boot from and the hash of
  -- what it holds, which every sandbox booted from it must reproduce.
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
`;

export type SolanaEnvStatus = "building" | "ready" | "failed" | "retired";
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
  updated_at: iso(r.updated_at)!,
});
const BUILD_LIMIT_MS = 90 * 60_000;
const RETRY_AFTER_MS = 60 * 60_000; // a failed build of the environment is tried again lazily after this long
const shellArg = (s: string) => (/^[0-9a-f]{64}$/.test(s) ? s : "invalid");

export class SolanaBuildEnv {
  private constructor(
    private readonly db: Db,
    private readonly boat: BoatClient | null,
    private readonly opts: { enabled: boolean; sandboxType: string; key: string },
  ) {}

  static async open(db: Db, boat: BoatClient | null, opts: { enabled?: boolean; sandboxType?: string; key?: string } = {}) {
    await db.exec(TABLE);
    return new SolanaBuildEnv(db, boat, { enabled: opts.enabled ?? true, sandboxType: opts.sandboxType ?? "default", key: opts.key ?? SOLANA_ENV_KEY });
  }

  get key() {
    return this.opts.key;
  }

  // Snapshots need a host that takes them, and can be turned off (SOLANA_BUILD_SNAPSHOT=off).
  get supported() {
    return this.opts.enabled && !!this.boat?.snapshot && !!this.boat?.deleteSnapshot;
  }

  private async row(key = this.key) {
    const r = (await this.db.query("SELECT * FROM financial_products.solana_build_envs WHERE key = $1", [key])).rows[0] as Record<string, unknown> | undefined;
    return r ? toRow(r) : null;
  }

  async list() {
    return ((await this.db.query("SELECT * FROM financial_products.solana_build_envs ORDER BY created_at DESC LIMIT 20")).rows as Record<string, unknown>[]).map(toRow);
  }

  // The snapshot for the current toolchain, when it's ready. Asking is what makes one: the first Solana build
  // after a change of pins starts the environment's build (and installs as before meanwhile).
  async ready(): Promise<SolanaEnvSnapshot | null> {
    if (!this.supported) return null;
    const r = await this.row();
    if (r?.status === "ready" && r.snapshot_id && r.state_sha256) return { key: r.key, snapshot_id: r.snapshot_id, state_sha256: r.state_sha256 };
    // Started in the background: this build installs as before meanwhile.
    if (!r || (r.status === "failed" && Date.now() - Date.parse(r.updated_at) > RETRY_AFTER_MS)) this.preparing = this.prepare().catch(() => null);
    return null;
  }
  preparing: Promise<unknown> | null = null;

  async used(env: SolanaEnvSnapshot) {
    await this.db.query("UPDATE financial_products.solana_build_envs SET uses = uses + 1 WHERE key = $1", [env.key]);
  }

  // A snapshot the host no longer has (or that wouldn't boot): stop using it; the next ask builds a new one.
  async invalidate(env: SolanaEnvSnapshot, reason: string) {
    await this.db.query("UPDATE financial_products.solana_build_envs SET status = 'failed', error = $2, updated_at = now() WHERE key = $1 AND snapshot_id = $3", [
      env.key,
      reason.slice(0, 500),
      env.snapshot_id,
    ]);
    await this.boat?.deleteSnapshot?.(env.snapshot_id).catch(() => undefined);
  }

  // Starts building the environment for the current toolchain (an admin may force a rebuild).
  async prepare(force = false) {
    if (!this.supported) throw new Error("This deployment's sandbox host can't snapshot machines (or SOLANA_BUILD_SNAPSHOT=off), so each Solana sandbox installs the toolchain itself");
    const current = await this.row();
    if (current && !force && (current.status === "building" || current.status === "ready")) return current;
    if (current?.builder_sandbox) await this.boat!.stop(current.builder_sandbox).catch(() => undefined);
    if (current?.snapshot_id) await this.boat!.deleteSnapshot!(current.snapshot_id).catch(() => undefined);
    // One builder per key, even with two servers asking at once.
    const claimed = await this.db.query(
      `INSERT INTO financial_products.solana_build_envs (key, pins_sha256, status) VALUES ($1, $2, 'building')
       ON CONFLICT (key) DO UPDATE SET status = 'building', builder_sandbox = NULL, builder_process = NULL, snapshot_id = NULL, state_sha256 = NULL,
         install_seconds = NULL, error = NULL, ready_at = NULL, created_at = now(), updated_at = now()
       WHERE financial_products.solana_build_envs.status IN ('failed', 'retired') OR $3::boolean
       RETURNING key`,
      [this.key, TOOLCHAIN_PINS_SHA256, force],
    );
    if (!claimed.rows.length) return (await this.row())!;
    try {
      // Nothing of any developer's: no env, no secrets, only Mynt's scripts ever run on it.
      const s = await this.boat!.createSandbox({
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

  // Called by the build worker: moves the environment's build along, and retires environments of older pins.
  async tick() {
    if (!this.boat) return;
    const boat = this.boat;
    for (const old of (await this.db.query("SELECT * FROM financial_products.solana_build_envs WHERE key <> $1 AND status IN ('building', 'ready')", [this.key])).rows as Record<string, unknown>[]) {
      const r = toRow(old);
      if (r.builder_sandbox) await boat.stop(r.builder_sandbox).catch(() => undefined);
      if (r.snapshot_id) await boat.deleteSnapshot?.(r.snapshot_id).catch(() => undefined);
      await this.set({ status: "retired", error: "the toolchain pins or its scripts changed" }, r.key);
    }
    const r = await this.row();
    if (!r || r.status !== "building" || !r.builder_sandbox) return;
    const fail = async (error: string) => {
      await boat.stop(r.builder_sandbox!).catch(() => undefined);
      await this.set({ status: "failed", error: error.slice(0, 1500) });
    };
    if (Date.now() - Date.parse(r.created_at) > BUILD_LIMIT_MS) return fail("the environment took too long to build");
    if (r.builder_process == null) {
      const state = (await boat.getSandbox(r.builder_sandbox)).state;
      if (state === "error" || state === "cancelled") return fail(`the builder sandbox is ${state}`);
      if (!["ready", "idle", "running"].includes(state)) return;
      await boat.writeFile(r.builder_sandbox, ENV_FILES.installer, SOLANA_TOOLCHAIN_SCRIPT);
      await boat.writeFile(r.builder_sandbox, ENV_FILES.state, SOLANA_ENV_STATE_SCRIPT);
      await boat.writeFile(r.builder_sandbox, ENV_FILES.prep, SOLANA_ENV_PREP_SCRIPT);
      const run = await boat.exec(r.builder_sandbox, `bash ${ENV_FILES.prep}`, { detached: true });
      if (run.processId === undefined) return fail("couldn't start the environment's build");
      await this.set({ builder_process: run.processId });
      return;
    }
    if ((await boat.commandStatus(r.builder_sandbox, r.builder_process)).running) return;
    let result: { ok?: boolean; state_sha256?: string; install_seconds?: number; error?: string } | null = null;
    try {
      result = JSON.parse((await boat.readFile(r.builder_sandbox, ENV_FILES.result)) ?? "null");
    } catch {
      result = null;
    }
    if (!result?.ok || !/^[0-9a-f]{64}$/.test(result.state_sha256 ?? "")) return fail(result?.error ?? "the environment's build ended without a result");
    // Snapshot the builder as it stands: the toolchain installed and checked, the image pulled.
    const { snapshotId } = await boat.snapshot!(r.builder_sandbox, {
      slug: `mynt-solana-${this.key}-${randomBytes(3).toString("hex")}`,
      displayName: `Mynt Solana build environment: Agave ${SOLANA_TOOLCHAIN.agave.version}, Anchor ${SOLANA_TOOLCHAIN.anchor.version}, Rust ${SOLANA_TOOLCHAIN.rust.version}`,
    });
    await this.set({
      status: "ready",
      snapshot_id: snapshotId,
      state_sha256: result.state_sha256!,
      install_seconds: Number.isFinite(result.install_seconds) ? Math.round(result.install_seconds!) : null,
      ready_at: new Date().toISOString(),
    });
    await boat.stop(r.builder_sandbox).catch(() => undefined);
  }

  // The commands a sandbox booted from the environment runs first: Mynt's own copies of the state and check
  // scripts, then the check against the hash Mynt kept.
  async writeCheck(sandbox: string) {
    await this.boat!.writeFile(sandbox, ENV_FILES.state, SOLANA_ENV_STATE_SCRIPT);
    await this.boat!.writeFile(sandbox, ENV_FILES.check, SOLANA_ENV_CHECK_SCRIPT);
  }
  checkCommand(env: SolanaEnvSnapshot) {
    return `bash ${ENV_FILES.check} ${shellArg(env.state_sha256)}`;
  }
}
