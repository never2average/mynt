import { z } from "zod";
import { callStudioTool } from "@/lib/studio-server";
import { json } from "@/lib/studio-route";
import { practiceFrom } from "@/lib/vendor-area";
import { offeringWrite } from "@/lib/vendor-server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ offeringId: string }> };

// POST: Run practice test (run_practice_conformance): Mynt runs its conformance test's own cases against its own
// sandbox for this service, so a provider can see the test pass and read exactly what Mynt sends and expects before
// its own test endpoint exists. Nothing leaves Mynt and no credential is taken. The answer is each case's result and
// the run's transcript, with the signing secret left out by Mynt. A practice pass never counts as conformance: the
// service's status doesn't change and it can't be listed on it.
const Body = z.object({}).strict();

export async function POST(req: Request, { params }: Params) {
  const { offeringId } = await params;
  return offeringWrite(req, offeringId, Body, "running a practice test", "run_practice_conformance", async (mynt) => {
    const practice = practiceFrom(await callStudioTool(mynt, "run_practice_conformance", { offering_id: offeringId }));
    return json({
      ok: true,
      practice: true,
      ...practice,
      message: practice.passed
        ? "Practice run passed — now point Mynt at your own test endpoint and run the real test."
        : "The practice run didn't pass. It says nothing about your own endpoint, and never counts as conformance.",
    });
  });
}
