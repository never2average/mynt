import type { BoatClient } from "./boat.js";
import type { RepoAccess } from "./github.js";

// Runs code from a repository (e.g. a firm's desk repo) in a sandbox: Mynt clones the repo (at `ref`, or its default
// branch) with a short-lived token kept in a credentials file that is deleted before any of the repo's
// code runs, writes the job's files, and starts `command` detached. Shared by the product desk and the
// governance desk; whatever the code produces is read back and checked by Mynt.

export const REPO_DIR = "/home/user/workspace";
const CREDENTIALS = "/home/user/.mynt-git-credentials";

export async function startRepoRun(
  boat: BoatClient,
  repos: RepoAccess,
  sandbox: string,
  o: {
    repository: string;
    installationId: number;
    ref: string | null;
    dir: string; // where run.sh and its logs go
    outcome: string; // where the command writes its outcome; a clone failure writes `cloneFailure` there instead
    cloneFailure: unknown;
    files: Record<string, string>;
    command: string;
  },
) {
  const { token } = await repos.tokenFor(o.repository, o.installationId);
  for (const [path, content] of Object.entries(o.files)) await boat.writeFile(sandbox, path, content);
  await boat.writeFile(sandbox, `${o.dir}/clone-failed.json`, JSON.stringify(o.cloneFailure));
  await boat.writeFile(sandbox, CREDENTIALS, `https://x-access-token:${token}@github.com\n`);
  // A full commit SHA can't be cloned with --branch: clone, then fetch that exact commit and check it out.
  const sha = o.ref && /^[0-9a-f]{40}$/.test(o.ref) ? o.ref : null;
  const branch = o.ref && !sha ? `--branch '${o.ref.replace(/[^\w./-]/g, "")}' ` : "";
  const helper = `credential.helper='store --file=${CREDENTIALS}'`;
  const script = [
    "set -u",
    `rm -rf ${REPO_DIR}`,
    `git -c ${helper} clone -q --depth 1 ${branch}https://github.com/${o.repository}.git ${REPO_DIR} > ${o.dir}/clone.log 2>&1`,
    "status=$?",
    ...(sha
      ? [`if [ $status -eq 0 ]; then git -C ${REPO_DIR} -c ${helper} fetch -q --depth 1 origin ${sha} >> ${o.dir}/clone.log 2>&1 && git -C ${REPO_DIR} checkout -q ${sha} >> ${o.dir}/clone.log 2>&1; status=$?; fi`]
      : []),
    `rm -f ${CREDENTIALS}`,
    `if [ $status -ne 0 ]; then cp ${o.dir}/clone-failed.json ${o.outcome}; exit 0; fi`,
    o.command,
  ].join("\n");
  await boat.writeFile(sandbox, `${o.dir}/run.sh`, script);
  const r = await boat.exec(sandbox, `bash ${o.dir}/run.sh > ${o.dir}/run.log 2>&1`, { detached: true });
  if (r.processId === undefined) throw new Error("Couldn't start the run");
  return String(r.processId);
}
