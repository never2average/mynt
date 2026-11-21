import { sessionAccess, sessionCanUseLiquidity } from "@/lib/liquidity-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
// The answer, as respond_to_state_correction takes it less the correction (named by the path).
const Answer = STUDIO_TOOLS.respond_to_state_correction.omit({ correction_id: true });

// Answer a correction to the US state the firm's capital moves from in a pool
// (respond_to_state_correction): accept it, or dispute it, with an optional reason. Accepting a
// sponsor's applies it; disputing an admin's puts the old state back, within Mynt's time limit.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { id } = await params;
  const bad = () => json({ error: "bad_request", message: "Accept or dispute the correction." }, 400);
  const answer = Answer.safeParse(await req.json().catch(() => null));
  if (!answer.success) return bad();
  const parsed = STUDIO_TOOLS.respond_to_state_correction.safeParse({ correction_id: id, ...answer.data });
  if (!parsed.success) return bad();

  return asDeveloper(
    "answering a state correction",
    async (mynt, session) => {
      if (!sessionAccess(session).liquidityProvider) return json({ error: "not_liquidity_provider", message: "Only a liquidity provider can answer a correction to its state." }, 403);
      if (!(await listMyntTools(mynt)).some((t) => t.name === "respond_to_state_correction")) return json({ error: "unsupported", message: "Answering a state correction comes with Mynt's next update." }, 501);
      return json({ ok: true, correction: await callStudioTool(mynt, "respond_to_state_correction", parsed.data) });
    },
    sessionCanUseLiquidity,
  );
}
