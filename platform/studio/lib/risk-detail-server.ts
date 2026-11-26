import { z } from "zod";
import { DETAIL_ACTION_TOOLS, riskDetailFrom, type RiskDetail } from "./risk-detail";
import { STUDIO_TOOLS } from "./studio-tools";

// One risk's detail read from Mynt (get_risk) and the changes its sheets make, for the three places it shows: the
// platform admin's Risk register (the admin routes call Mynt with callAdminTool), an app's Security & risk tab and a
// product's Risk tab (callStudioTool). Each route names the risk and, for an app or a product, the register it must
// be on; the body carries the action and that action's own fields, checked strictly here and again by Mynt, whose
// refusal comes back in its own words.

export type Call = (tool: keyof typeof DETAIL_TOOLS, args: Record<string, unknown>) => Promise<unknown>;
// Every tool the detail calls: all of them are on both allow-lists (STUDIO_TOOLS and ADMIN_TOOLS).
export const DETAIL_TOOLS = {
  get_risk: true,
  update_risk: true,
  add_risk_factor: true,
  update_risk_factor: true,
  remove_risk_factor: true,
  add_risk_treatment: true,
  update_risk_treatment: true,
  add_risk_control: true,
  update_risk_control: true,
  retire_risk_control: true,
  link_risk: true,
  unlink_risk: true,
} as const;

export const NO_DETAIL_YET = "A risk's detail comes with Mynt's next update.";

const blank = (v: unknown) => (typeof v === "string" && !v.trim() ? undefined : v);
// A sheet's body for one action: the tool's own arguments but the risk (the route's), empty optional fields left out.
const body = <A extends string, S extends z.ZodRawShape>(action: A, tool: z.ZodObject<S>) => {
  const { risk_id: _r, ...rest } = tool.shape as z.ZodRawShape;
  const optional = (s: z.ZodTypeAny) => s.safeParse(undefined).success;
  const shape = Object.fromEntries(Object.entries(rest).map(([k, s]) => [k, optional(s as z.ZodTypeAny) ? z.preprocess(blank, s as z.ZodTypeAny) : (s as z.ZodTypeAny)]));
  return z.object({ action: z.literal(action), ...shape }).strict();
};
export const RiskDetailChangeRequest = z.discriminatedUnion("action", [
  body("add_factor", STUDIO_TOOLS.add_risk_factor),
  body("update_factor", STUDIO_TOOLS.update_risk_factor),
  body("remove_factor", STUDIO_TOOLS.remove_risk_factor),
  body("add_treatment", STUDIO_TOOLS.add_risk_treatment),
  body("update_treatment", STUDIO_TOOLS.update_risk_treatment),
  body("add_control", STUDIO_TOOLS.add_risk_control),
  body("update_control", STUDIO_TOOLS.update_risk_control),
  body("retire_control", STUDIO_TOOLS.retire_risk_control),
  body("link", STUDIO_TOOLS.link_risk),
  body("unlink", STUDIO_TOOLS.unlink_risk),
  // Close risk and Accept risk: the status and why, nothing else (Review risk changes the rest).
  z.object({ action: z.literal("set_status"), status: z.enum(["accepted", "closed"]), note: z.string().trim().min(3).max(2000) }).strict(),
]);
export type RiskDetailChangeRequest = z.infer<typeof RiskDetailChangeRequest>;

const DONE: Record<keyof typeof DETAIL_ACTION_TOOLS, string> = {
  add_factor: "Factor added. It explains the score; the score itself changes with Review risk.",
  update_factor: "Factor changed.",
  remove_factor: "Factor removed. The audit trail keeps what it was.",
  add_treatment: "Treatment task added.",
  update_treatment: "Treatment task updated.",
  add_control: "Control added.",
  update_control: "Control updated.",
  retire_control: "Control retired. It stays listed, marked retired.",
  link: "Linked.",
  unlink: "Link removed.",
  set_status: "Status changed, with your note. It's in the risk's history.",
};

/** The risk's detail, when Mynt answers with one that is on the register the route names (any register for an admin). */
export async function loadRiskDetail(call: Call, riskId: string, on?: { type: "app" | "product"; id: string }): Promise<RiskDetail | null> {
  const detail = riskDetailFrom(await call("get_risk", { risk_id: riskId }));
  if (!detail) return null;
  return on && (detail.subject.type !== on.type || detail.subject.id !== on.id) ? null : detail;
}

/** Makes one change under this risk; returns what to say. */
export async function applyRiskDetailChange(call: Call, riskId: string, change: RiskDetailChangeRequest): Promise<string> {
  const { action, ...rest } = change;
  const args = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  await call(DETAIL_ACTION_TOOLS[action], { risk_id: riskId, ...args });
  return DONE[action];
}
