// The source of a build that didn't ship, kept so the next build can start from it.
//
// A build that Mynt blocks or fails has no verified branch: nothing was confirmed pushed, and without a repository
// nothing was pushed at all. Its source is still the package Mynt hashed for verification (app.tgz in the coding
// sandbox, sha256 on the build). Mynt reads that package back before the sandbox goes, checks it against the hash it
// recorded, and keeps it for a bounded time; start_build's continue_from then unpacks it in the new build's sandbox,
// so fixing what the checks or the audit found doesn't mean building the app again from nothing.
import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import type { SandboxHost } from "./sandbox-host.js";

export const KEPT_SOURCE_DAYS = 7;
export const KEPT_SOURCE_MAX_BYTES = 24 * 1024 * 1024;
const CHUNK = 192 * 1024;

export const BUILD_SOURCES_DDL = `
  -- The packaged source of a build that ended blocked or failed, exactly as Mynt hashed it for verification, until
  -- kept_until (build-sources.ts). continue_from starts the next build from it.
  CREATE TABLE IF NOT EXISTS financial_products.build_sources (
    build_id uuid PRIMARY KEY REFERENCES financial_products.build_runs(id) ON DELETE CASCADE,
    sha256 text NOT NULL,
    size integer NOT NULL,
    data bytea NOT NULL,
    kept_at timestamptz NOT NULL DEFAULT now(),
    kept_until timestamptz NOT NULL
  );
`;

export interface KeptSource {
  build_id: string;
  sha256: string;
  size: number;
  kept_until: string;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

// Reads the package back from the sandbox that made it and keeps it, if it is the one Mynt hashed. Returns why not
// otherwise; a build's ending never waits on this or fails because of it.
export async function keepSource(
  db: Db,
  sandboxes: SandboxHost,
  o: { build_id: string; sandbox_id: string; path: string; sha256: string },
): Promise<{ kept: KeptSource } | { kept: null; reason: string }> {
  await db.query("DELETE FROM financial_products.build_sources WHERE kept_until < now()").catch(() => undefined);
  try {
    // Only ever a regular file, never through a link: checked in the same command as each read.
    const sized = await sandboxes.exec(o.sandbox_id, `[ -f ${o.path} ] && [ ! -L ${o.path} ] && stat -c %s ${o.path}`, { timeoutSeconds: 30 });
    const size = Number(sized.stdout.trim());
    if (sized.exitCode !== 0 || !Number.isInteger(size) || size <= 0) return { kept: null, reason: "the packaged source is no longer in the build's sandbox" };
    if (size > KEPT_SOURCE_MAX_BYTES) return { kept: null, reason: `the packaged source is ${(size / 1048576).toFixed(1)} MB, over the ${KEPT_SOURCE_MAX_BYTES / 1048576} MB Mynt keeps` };
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < size; offset += CHUNK) {
      const r = await sandboxes.exec(o.sandbox_id, `[ -f ${o.path} ] && [ ! -L ${o.path} ] && tail -c +${offset + 1} ${o.path} | head -c ${CHUNK} | base64 -w0`, { timeoutSeconds: 60 });
      if (r.exitCode !== 0) return { kept: null, reason: "the packaged source couldn't be read back" };
      chunks.push(Buffer.from(r.stdout.trim(), "base64"));
    }
    const data = Buffer.concat(chunks);
    if (data.length !== size || createHash("sha256").update(data).digest("hex") !== o.sha256) return { kept: null, reason: "the packaged source no longer matches the hash Mynt verified" };
    const r = await db.query(
      `INSERT INTO financial_products.build_sources (build_id, sha256, size, data, kept_until) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
       ON CONFLICT (build_id) DO UPDATE SET sha256 = EXCLUDED.sha256, size = EXCLUDED.size, data = EXCLUDED.data, kept_at = now(), kept_until = EXCLUDED.kept_until
       RETURNING kept_until`,
      [o.build_id, o.sha256, size, data, KEPT_SOURCE_DAYS],
    );
    return { kept: { build_id: o.build_id, sha256: o.sha256, size, kept_until: iso(r.rows[0].kept_until) } };
  } catch (e) {
    return { kept: null, reason: `the packaged source couldn't be kept (${(e as Error).message.slice(0, 200)})` };
  }
}

// The kept source of a build, if it is still within its time.
export async function keptSource(db: Db, buildId: string): Promise<KeptSource | null> {
  const r = await db.query("SELECT build_id, sha256, size, kept_until FROM financial_products.build_sources WHERE build_id::text = $1 AND kept_until > now()", [buildId]);
  const row = r.rows[0];
  return row ? { build_id: String(row.build_id), sha256: String(row.sha256), size: Number(row.size), kept_until: iso(row.kept_until) } : null;
}

// Unpacks a kept source into `dest` in a new build's sandbox, before its agent starts: written in pieces, put
// together, checked against the hash, then extracted. Throws when it is gone or doesn't match.
export async function restoreSource(db: Db, sandboxes: SandboxHost, o: { build_id: string; sandbox_id: string; dest: string; work: string }): Promise<KeptSource> {
  const r = await db.query("SELECT sha256, size, data, kept_until FROM financial_products.build_sources WHERE build_id::text = $1 AND kept_until > now()", [o.build_id]);
  const row = r.rows[0];
  if (!row) throw new Error(`The source Mynt kept for build ${o.build_id} is gone (kept ${KEPT_SOURCE_DAYS} days)`);
  // A Buffer from node-postgres, a plain Uint8Array from other drivers.
  const data = Buffer.from(row.data as Uint8Array);
  const sha = String(row.sha256);
  if (createHash("sha256").update(data).digest("hex") !== sha) throw new Error(`The source Mynt kept for build ${o.build_id} doesn't match its hash`);
  const parts: string[] = [];
  for (let offset = 0, n = 0; offset < data.length; offset += CHUNK, n++) {
    const part = `${o.work}/base-source.${String(n).padStart(4, "0")}.b64`;
    await sandboxes.writeFile(o.sandbox_id, part, data.subarray(offset, offset + CHUNK).toString("base64"));
    parts.push(part);
  }
  const tgz = `${o.work}/base-source.tgz`;
  const done = await sandboxes.exec(
    o.sandbox_id,
    `set -e; cat ${parts.join(" ")} | base64 -d > ${tgz}; rm -f ${parts.join(" ")}; [ "$(sha256sum ${tgz} | cut -d' ' -f1)" = "${sha}" ]; mkdir -p ${o.dest}; tar -xzf ${tgz} -C ${o.dest}; rm -f ${tgz}; echo restored`,
    { timeoutSeconds: 300 },
  );
  if (done.exitCode !== 0 || !/^restored$/m.test(done.stdout)) throw new Error(`Couldn't unpack the earlier build's source in the new sandbox: ${(done.stderr || done.stdout).slice(0, 300)}`);
  return { build_id: o.build_id, sha256: sha, size: Number(row.size), kept_until: iso(row.kept_until) };
}
