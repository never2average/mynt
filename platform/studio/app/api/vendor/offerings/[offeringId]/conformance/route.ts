import { z } from "zod";
import { callStudioTool } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";
import { offeringWrite } from "@/lib/vendor-server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ offeringId: string }> };

// POST: Run conformance (run_conformance): Mynt calls the service's test endpoint itself with signed fixture requests,
// checks every answer against the service type's contract, that badly signed and stale requests are refused, and the
// licences. The answer is the result and each failed case's problems. A test credential (when subscribers need one)
// goes to Mynt for this run only: it isn't kept, logged or sent back.
const blank = (v: unknown) => (typeof v === "string" && !v.trim() ? undefined : v);
const Body = z.object({ test_credential: z.preprocess(blank, STUDIO_TOOLS.run_conformance.shape.test_credential) }).strict();

export async function POST(req: Request, { params }: Params) {
  const { offeringId } = await params;
  return offeringWrite(req, offeringId, Body, "running conformance", "run_conformance", async (mynt, body) => {
    const reply = (await callStudioTool(mynt, "run_conformance", { offering_id: offeringId, ...(body.test_credential ? { test_credential: body.test_credential } : {}) })) as {
      passed?: unknown;
      status?: unknown;
      cases?: unknown;
      licence_gap?: unknown;
    } | null;
    const cases = Array.isArray(reply?.cases) ? (reply.cases as { case?: unknown; passed?: unknown; problems?: unknown }[]) : [];
    const failures = cases
      .filter((c) => c && c.passed !== true)
      .map((c) => ({ case: typeof c.case === "string" ? c.case : "case", problems: Array.isArray(c.problems) ? c.problems.filter((p): p is string => typeof p === "string") : [] }));
    const passed = reply?.passed === true;
    return json({
      ok: true,
      passed,
      status: typeof reply?.status === "string" ? reply.status : null,
      cases: cases.length,
      failures,
      message: passed ? "Passed Mynt's conformance test. You can list the service now." : `Didn't pass: ${failures.length} of ${cases.length} checks failed. Fix them and run it again.`,
    });
  });
}
