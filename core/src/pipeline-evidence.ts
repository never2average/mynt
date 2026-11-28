// Mynt's own record of the pipeline a build's source went through before the audit, for the auditor to read.
//
// An app Mynt builds has no CI of its own to show an auditor: its pipeline is Mynt's verification, which runs in a
// clean sandbox the coding agent never touched (verify-script.ts). So the audit used to see a repository with no
// dependency gate, no image scan and no image SBOM, although Mynt runs all three. This record states what Mynt ran:
// each check with its tool, version, command, bar, result and time, and each container image Mynt built from the
// verified source with its scan counts and SBOM. Mynt writes it from its own files in the verification sandbox
// (report.json, pipeline.jsonl, images.json) into the auditor's job folder; nothing in it comes from the coding
// agent, and it states facts only. How the auditor is told to read it is in workspaces/build-audit/CLAUDE.md.
import { workspaceCwd } from "./agent-host.js";
import type { SandboxHost } from "./sandbox-host.js";
import { VERIFY_AUDIT_SRC, VERIFY_DIR } from "./verify-script.js";

export const PIPELINE_EVIDENCE_PATH = "job/pipeline-evidence.json";

type Status = "pass" | "fail" | "warn";
interface CheckRow {
  name: string;
  status: Status;
  detail?: string;
}
interface RunRow {
  check: string;
  tool: string;
  tool_version: string;
  command: string;
  threshold: string;
  started_at: string;
  finished_at: string;
}
interface ImagesReport {
  applicable?: boolean;
  built?: boolean;
  compose_file?: string | null;
  coverage?: string;
  images?: Record<string, unknown>[];
  skipped?: { service: string; reason: string }[];
  problems?: string[];
}

// What kind of gate each check is, in the words an auditor of pipelines uses.
const GATES: Record<string, string> = {
  source: "source integrity",
  tests: "tests",
  lint_typecheck: "lint and types",
  secrets_scan: "secrets scan",
  secrets_history: "secrets scan of the history",
  dependency_audit: "dependency vulnerabilities (SCA)",
  static_scan: "static analysis (SAST)",
  sbom: "SBOM, source and images",
  image_scan: "container image vulnerability scan",
  solana_build: "verifiable program build",
  solana_tests: "program tests",
  disclosures: "required disclosures",
};

const parseJson = <T>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

export function pipelineEvidence(o: { build_id: string; source_sha256: string | null; checks: CheckRow[]; runs: RunRow[]; images: ImagesReport | null; generated_at: string }) {
  const run = new Map(o.runs.map((r) => [r.check, r]));
  const built = o.images?.built === true;
  return {
    kind: "mynt.pipeline-evidence",
    version: 1,
    produced_by: "Mynt's build verification. The agent that wrote the application had no part in it and never saw this file.",
    generated_at: o.generated_at,
    build_id: o.build_id,
    source: { sha256: o.source_sha256, audited_copy: VERIFY_AUDIT_SRC },
    pipeline: {
      system: "Mynt build verification",
      runs: "on every build, after the coding agent has finished and before this audit, in a clean sandbox the coding agent never had access to, on the source package whose sha256 is above",
      blocking: "a check whose result is fail stops the build: no pull request is opened, and Mynt's hosting runs only builds that passed",
      the_repository_itself: "has no pipeline files of its own; this verification is the pipeline every build of it goes through",
    },
    // One row per check Mynt ran, in the order it ran them. A warn never blocks.
    gates: o.checks.map((c) => {
      const r = run.get(c.name);
      return {
        check: c.name,
        gate: GATES[c.name] ?? c.name,
        result: c.status,
        blocking: c.name !== "secrets_history",
        detail: c.detail ?? "",
        tool: r?.tool || null,
        tool_version: r?.tool_version || null,
        command: r?.command ?? null,
        threshold: r?.threshold ?? null,
        started_at: r?.started_at ?? null,
        finished_at: r?.finished_at ?? null,
      };
    }),
    sbom: { source: `${VERIFY_DIR}/sbom.json`, format: "CycloneDX JSON" },
    // Every image Mynt built (or pulled) from the verified source, with its SBOM and scan.
    images: o.images?.images ?? [],
    images_not_scanned: o.images?.skipped ?? [],
    image_coverage: o.images ? (o.images.applicable === false ? "the source has no Compose file or Dockerfile at its root: nothing ships as a container image" : (o.images.coverage ?? null)) : "Mynt's image stage wrote no record",
    deployment: built
      ? "Mynt's hosting builds these images again on the app's own machine, from the verified commit of this same source, with docker compose. The images scanned here are builds of the same source and Dockerfiles in the verification sandbox; they are not the deployed bytes, are not pushed to a registry and are not signed."
      : null,
  };
}

// Read Mynt's own files in the verification sandbox and write the evidence into the auditor's job folder.
export async function writePipelineEvidence(sandboxes: SandboxHost, sandbox: string, o: { build_id: string; source_sha256: string | null; solana_check?: CheckRow | null }) {
  const [report, runs, images] = await Promise.all([
    sandboxes.readFile(sandbox, `${VERIFY_DIR}/report.json`).then((t) => parseJson<{ checks: CheckRow[] }>(t)),
    sandboxes.readFile(sandbox, `${VERIFY_DIR}/pipeline.jsonl`).catch(() => null),
    sandboxes.readFile(sandbox, `${VERIFY_DIR}/images.json`).then((t) => parseJson<ImagesReport>(t)).catch(() => null),
  ]);
  // solana_build is Mynt's own record from before the checks ran, never the row in their report.
  const rest = (report?.checks ?? []).filter((c) => c.name !== "solana_build");
  const evidence = pipelineEvidence({
    build_id: o.build_id,
    source_sha256: o.source_sha256,
    checks: o.solana_check ? [o.solana_check, ...rest] : rest,
    runs: (runs ?? "").split("\n").map((l) => parseJson<RunRow>(l)).filter((r): r is RunRow => !!r && typeof r.check === "string"),
    images,
    generated_at: new Date().toISOString(),
  });
  await sandboxes.writeFile(sandbox, `${workspaceCwd("build-audit")}/${PIPELINE_EVIDENCE_PATH}`, JSON.stringify(evidence, null, 2));
  return evidence;
}
