import { REPO_DIR } from "./repo-run.js";
import type { SandboxHost } from "./sandbox-host.js";

// A scratch workspace repository, for agent benchmarks only (benchmarks.ts turns it on for its own instances of the
// product desk and the algorithm explorer; nothing in the environment or the operational settings can).
//
// A firm's desk agent works in the firm's GitHub repository: it clones it, pushes a branch, and Mynt clones that branch
// in a clean sandbox to run it. The repository is only how the work travels from the agent's sandbox to Mynt's. A
// benchmark has no firm and must touch no repository of anyone's, so it gets storage of its own instead:
//   1. before the agent starts, Mynt makes a bare git repository inside the agent's sandbox with one first commit, and
//      a git rule that sends the repository's GitHub address there. The agent's instructions are the unchanged ones
//      ("clone $GITHUB_REPOSITORY, push $MYNT_BRANCH"): git itself redirects them;
//   2. when the agent is done, Mynt (not the agent) reads which commit the branch holds, packs it as a git bundle, and
//      has its clean sandbox download the bundle, check its sha256, and check out exactly that commit.
// No GitHub App, no token, no pull request. What Mynt runs is named by a commit hash, which is a hash of its content.

/** The name the agent sees as $GITHUB_REPOSITORY. Not a repository anywhere: git never leaves the sandbox for it. */
export const SCRATCH_REPOSITORY = "mynt-benchmarks/scratch";
/** What stands where a token would be. It opens nothing; it is not a secret. */
export const SCRATCH_TOKEN = "no-token-scratch-workspace";
const HOME = "/home/user/.mynt-scratch";
export const SCRATCH_BARE = `${HOME}/scratch.git`;
const SEED = `${HOME}/seed`;
const OUT = `${HOME}/out`;
const BRANCH = "main";

/** Every way the repository's GitHub address may be written, each sent to the sandbox's own copy. */
export function scratchAddresses(repository = SCRATCH_REPOSITORY, token = SCRATCH_TOKEN) {
  const bases = [`https://github.com/${repository}`, `https://x-access-token:${token}@github.com/${repository}`, `git@github.com:${repository}`, `ssh://git@github.com/${repository}`];
  // The longest match wins in git, so the form ending in .git must be its own rule: otherwise ".git" would be left
  // over and appended to the local path.
  return bases.flatMap((b) => [`${b}.git`, b]);
}

/** The shell script that makes the scratch repository from the files in `seedDir` (none: an empty first commit). */
export function scratchSetupScript(o: { bare?: string; seedDir?: string; message?: string } = {}) {
  const bare = o.bare ?? SCRATCH_BARE;
  const seed = o.seedDir ?? SEED;
  const key = `url.file://${bare}.insteadOf`;
  return [
    "set -eu",
    `rm -rf '${bare}' '${seed}/.git'`,
    `mkdir -p '${seed}'`,
    `git init -q --bare '${bare}'`,
    `git --git-dir='${bare}' symbolic-ref HEAD refs/heads/${BRANCH}`,
    `cd '${seed}'`,
    "git init -q .",
    `git symbolic-ref HEAD refs/heads/${BRANCH}`,
    "git add -A",
    // A fixed author and date: the same files make the same commit in every sandbox.
    `GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' git -c user.name='Mynt benchmarks' -c user.email='benchmarks@example.com' -c commit.gpgsign=false commit -q --allow-empty -m '${(o.message ?? "The workspace as the benchmark starts").replace(/[^\w .,:-]/g, "")}'`,
    `git push -q '${bare}' ${BRANCH}`,
    `rm -rf '${seed}/.git'`,
    `git config --global --unset-all '${key}' || true`,
    ...scratchAddresses().map((a) => `git config --global --add '${key}' '${a}'`),
    `git --git-dir='${bare}' rev-parse refs/heads/${BRANCH}`,
  ].join("\n");
}

const SHA1 = /^[0-9a-f]{40}$/;
const lastLine = (s: string) => s.trim().split("\n").pop()?.trim() ?? "";
const refName = (s: string) => s.replace(/[^\w./-]/g, "");

/** Makes the scratch repository in an agent's sandbox, holding `files` as its first commit. Returns that commit. */
export async function prepareScratchRepo(sandboxes: SandboxHost, sandbox: string, files: Record<string, string> = {}, message?: string) {
  for (const path of Object.keys(files)) if (path.startsWith("/") || path.split("/").includes("..") || path.split("/").includes(".git")) throw new Error(`Bad scratch repository path '${path}'`);
  for (const [path, content] of Object.entries(files)) await sandboxes.writeFile(sandbox, `${SEED}/${path}`, content);
  await sandboxes.writeFile(sandbox, `${HOME}/setup.sh`, scratchSetupScript({ message }));
  const r = await sandboxes.exec(sandbox, `bash ${HOME}/setup.sh`, { timeoutSeconds: 120 });
  const commit = lastLine(r.stdout);
  if (r.exitCode !== 0 || !SHA1.test(commit)) throw new Error(`Couldn't prepare the benchmark's scratch repository: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return commit;
}

/** The commit `branch` holds in the sandbox's scratch repository, read by Mynt; null when it was never pushed. */
export const scratchHeadCommand = (branch: string, bare = SCRATCH_BARE) => `git --git-dir='${bare}' rev-parse -q --verify 'refs/heads/${refName(branch)}^{commit}'`;
export async function scratchHead(sandboxes: SandboxHost, sandbox: string, branch: string) {
  const r = await sandboxes.exec(sandbox, scratchHeadCommand(branch), { timeoutSeconds: 60 });
  const commit = lastLine(r.stdout);
  // git answers 1 for "no such branch"; anything else means the repository couldn't be read at all.
  if (r.exitCode !== 0 && r.exitCode !== 1) throw new Error(`Couldn't read the benchmark's scratch repository: ${(r.stderr || `exit ${r.exitCode}`).slice(0, 300)}`);
  return r.exitCode === 0 && SHA1.test(commit) ? commit : null;
}

export interface ScratchBundle {
  url: string;
  sha256: string;
  commit: string;
  ref: string;
}

/** The command that packs one commit of the scratch repository into a bundle and prints the bundle's sha256. */
export function scratchPackScript(o: { bare?: string; commit: string; ref: string; file: string }) {
  const git = `git --git-dir='${o.bare ?? SCRATCH_BARE}'`;
  return `set -e; mkdir -p "$(dirname '${o.file}')"; ${git} update-ref ${o.ref} ${o.commit}; ${git} bundle create '${o.file}' ${o.ref} 2>/dev/null; sha256sum '${o.file}'`;
}

/** Packs `commit` out of the sandbox's scratch repository as a git bundle Mynt's clean sandbox can download. */
export async function packScratchCommit(sandboxes: SandboxHost, sandbox: string, commit: string, name: string): Promise<ScratchBundle> {
  if (!SHA1.test(commit)) throw new Error("A scratch bundle is of one commit");
  const ref = `refs/mynt/${refName(name).replace(/\//g, "-")}`;
  const file = `${OUT}/${ref.split("/").pop()}.bundle`;
  const r = await sandboxes.exec(sandbox, scratchPackScript({ commit, ref, file }), { timeoutSeconds: 300 });
  const sha256 = lastLine(r.stdout).split(/\s+/)[0];
  if (r.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(sha256 ?? "")) throw new Error(`Couldn't pack the pushed branch out of the agent's sandbox: ${r.stderr.slice(0, 300)}`);
  // Sandbox hosts sign download URLs for at most an hour; the clean sandbox fetches it as soon as it starts.
  const url = await sandboxes.downloadUrl(sandbox, file, 3600);
  if (!/^https:\/\/[^\s'"`$\\]+$/.test(url)) throw new Error("Unexpected bundle URL from the sandbox host");
  return { url, sha256, commit, ref };
}

/** How the clean sandbox gets the commit: download, checksum, fetch from the bundle, check out exactly it. */
export function scratchCheckoutScript(b: ScratchBundle, o: { dir: string; repoDir?: string; fetch?: string }) {
  const repo = o.repoDir ?? REPO_DIR;
  const file = `${o.dir}/source.bundle`;
  const log = `${o.dir}/clone.log`;
  return [
    `rm -rf ${repo}`,
    `{ ${o.fetch ?? `curl -fsSL '${b.url}' -o ${file}`} && [ "$(sha256sum ${file} | cut -d' ' -f1)" = "${b.sha256}" ] && git init -q ${repo} && git -C ${repo} fetch -q ${file} ${b.ref} && git -C ${repo} checkout -q --detach ${b.commit} && [ "$(git -C ${repo} rev-parse HEAD)" = "${b.commit}" ]; } > ${log} 2>&1`,
    "status=$?",
  ];
}

/**
 * The scratch twin of startRepoRun (repo-run.ts): the clean sandbox checks out the packed commit and runs `command`.
 * There are no credentials to remove: none were ever there.
 */
export async function startScratchRun(
  sandboxes: SandboxHost,
  sandbox: string,
  o: { bundle: ScratchBundle; dir: string; outcome: string; cloneFailure: unknown; files: Record<string, string>; command: string },
) {
  for (const [path, content] of Object.entries(o.files)) await sandboxes.writeFile(sandbox, path, content);
  await sandboxes.writeFile(sandbox, `${o.dir}/clone-failed.json`, JSON.stringify(o.cloneFailure));
  const script = ["set -u", ...scratchCheckoutScript(o.bundle, { dir: o.dir }), `if [ $status -ne 0 ]; then cp ${o.dir}/clone-failed.json ${o.outcome}; exit 0; fi`, o.command].join("\n");
  await sandboxes.writeFile(sandbox, `${o.dir}/run.sh`, script);
  const r = await sandboxes.exec(sandbox, `bash ${o.dir}/run.sh > ${o.dir}/run.log 2>&1`, { detached: true });
  if (r.processId === undefined) throw new Error("Couldn't start the run");
  return String(r.processId);
}
