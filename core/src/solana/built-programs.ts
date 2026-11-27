import { createHash } from "node:crypto";
import type { SandboxHost } from "../sandbox-host.js";

// Reading back what Mynt's verifiable Solana build (solana-verify.sh build) left in a sandbox of Mynt's: the program
// bytes and the JSON files kept beside them (the captured workspace, the dependencies, dep-info, the IDL). Every
// file is read in chunks, only ever as a regular file (never through a link, which could point anywhere on the
// machine), and kept only if its size and sha256 are what the build recorded. Used where Mynt builds a program for
// itself rather than for a developer's build (a benchmark sample for the mainnet gate's agents).

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const CHUNK = 192 * 1024;
export const MAX_SAMPLE_PROGRAM_BYTES = 10 * 1024 * 1024;
export const MAX_SAMPLE_JSON_BYTES = 48 * 1024 * 1024;

/** A regular file's bytes, or null when it isn't one, can't be read, or isn't `size` bytes long. */
export async function readBack(sandboxes: SandboxHost, sandbox: string, path: string, size: number): Promise<Buffer | null> {
  if (!(size >= 0) || !/^[\w./-]+$/.test(path)) return null;
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < size; offset += CHUNK) {
    const r = await sandboxes.exec(sandbox, `[ -f ${path} ] && [ ! -L ${path} ] && tail -c +${offset + 1} ${path} | head -c ${CHUNK} | base64 -w0`, { timeoutSeconds: 60 });
    if (r.exitCode !== 0) return null;
    chunks.push(Buffer.from(r.stdout.trim(), "base64"));
  }
  const data = Buffer.concat(chunks);
  return data.length === size ? data : null;
}

const parse = <X>(text: string | null | undefined): X | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as X;
  } catch {
    return null;
  }
};

/** A JSON file of a known size and sha256, or null when what is there doesn't match. */
export async function readBackJson<X>(sandboxes: SandboxHost, sandbox: string, path: string, size: number | undefined, sha256: string | undefined, max = MAX_SAMPLE_JSON_BYTES): Promise<X | null> {
  if (!size || size > max || !/^[0-9a-f]{64}$/.test(sha256 ?? "")) return null;
  const raw = await readBack(sandboxes, sandbox, path, size);
  if (!raw || createHash("sha256").update(raw).digest("hex") !== sha256) return null;
  return parse<X>(raw.toString("utf8"));
}

export interface BuiltProgram {
  name: string;
  declared_id: string | null;
  sha256: string;
  program: Uint8Array;
  idl: unknown;
  sources: { files: Record<string, string>; binary: Record<string, string>; links: Record<string, string> } | null;
  deps: unknown;
  depinfo: unknown;
}

type Kind = "sources" | "deps" | "idl" | "depinfo";
type Listed = { name: string; size: number; sha256: string; declared_id: string | null } & { [k in Kind]?: string } & { [k in `${Kind}_size`]?: number } & { [k in `${Kind}_sha256`]?: string };

/** The build's own record of how it went (checks.jsonl's solana_build row), as Mynt reads it. */
export async function buildCheck(sandboxes: SandboxHost, sandbox: string, outDir: string): Promise<{ status: string; detail: string }> {
  const rows = ((await sandboxes.readFile(sandbox, `${outDir}/checks.jsonl`)) ?? "").split("\n").map((l) => parse<{ name?: string; status?: string; detail?: string }>(l));
  const row = rows.find((c) => c?.name === "solana_build");
  return row ? { status: String(row.status), detail: String(row.detail ?? "").slice(0, 1500) } : { status: "fail", detail: "Mynt's Solana build didn't finish" };
}

/** Every program the build listed (programs.json) whose bytes Mynt read back and that hash as the build said. */
export async function readBuiltPrograms(sandboxes: SandboxHost, sandbox: string, outDir: string): Promise<BuiltProgram[]> {
  const listed = parse<Listed[]>(await sandboxes.readFile(sandbox, `${outDir}/programs.json`));
  const out: BuiltProgram[] = [];
  for (const p of Array.isArray(listed) ? listed : []) {
    if (!/^[a-z0-9_]+$/.test(String(p.name)) || !(p.size > 0 && p.size <= MAX_SAMPLE_PROGRAM_BYTES)) continue;
    const program = await readBack(sandboxes, sandbox, `${outDir}/${p.name}.so`, p.size);
    if (!program || !program.subarray(0, 4).equals(ELF_MAGIC) || createHash("sha256").update(program).digest("hex") !== p.sha256) continue;
    const kept = async <X>(key: Kind) => {
      const file = p[key];
      return file && /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.json$/.test(file) ? readBackJson<X>(sandboxes, sandbox, `${outDir}/${file}`, p[`${key}_size`], p[`${key}_sha256`]) : null;
    };
    const bundle = await kept<{ files?: Record<string, string>; binary?: Record<string, string>; links?: Record<string, string> }>("sources");
    out.push({
      name: p.name,
      declared_id: p.declared_id ?? null,
      sha256: p.sha256,
      program: new Uint8Array(program),
      idl: await kept<unknown>("idl"),
      sources: bundle && typeof bundle.files === "object" ? { files: bundle.files, binary: bundle.binary ?? {}, links: bundle.links ?? {} } : null,
      deps: await kept<unknown>("deps"),
      depinfo: await kept<unknown>("depinfo"),
    });
  }
  return out;
}
