import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { registerFrom, unavailable, type OwnerChoice, type RiskRegister, type Unavailable } from "./risk-register";
import { callStudioTool, isAuthError, listMyntTools } from "./studio-server";
import { STUDIO_TOOLS } from "./studio-tools";
import { fromListMembers } from "./workspaces";

// A risk register read from Mynt as the signed-in user (list_risks), and the changes its sheets make (add_risk,
// update_risk), always for the one app or product the route names. A Mynt without the tools says so; a refusal comes
// back in Mynt's own words.

export type RiskSubject = { type: "app" | "product"; id: string };

export const NO_REGISTER_YET = "Risk registers come with Mynt's next update.";

/** The register and Mynt's whole reply (an app's carries its signals), or why it can't be read. */
export async function loadRegister(mynt: Client, subject: RiskSubject, opts: { workspaceId?: string | null } = {}): Promise<{ register: RiskRegister | Unavailable; reply: unknown | null }> {
  const tools = await listMyntTools(mynt);
  if (!tools.some((t) => t.name === "list_risks")) return { register: unavailable(NO_REGISTER_YET), reply: null };
  const read = async (name: string, args: Record<string, unknown>) => {
    if (!tools.some((t) => t.name === name)) return null;
    try {
      return await callStudioTool(mynt, name, args);
    } catch (err) {
      if (isAuthError(err)) throw err;
      return null;
    }
  };
  const [reply, members] = await Promise.all([
    read("list_risks", { subject_type: subject.type, subject_id: subject.id }),
    subject.type === "app" && opts.workspaceId ? read("list_workspace_members", { workspace_id: opts.workspaceId }) : Promise.resolve(null),
  ]);
  const owners: OwnerChoice[] = members === null ? [] : fromListMembers(members).members.map((m) => ({ userId: m.userId, name: m.name ?? m.email ?? "Unnamed member" }));
  const register = registerFrom(reply, owners);
  return { register: register ?? unavailable("Mynt didn't answer with the risk register."), reply };
}

// What a sheet sends: Add risk or Review risk, add_risk's or update_risk's own arguments but the subject, which is the
// route's. An empty optional field is left out.
const blank = (v: unknown) => (typeof v === "string" && !v.trim() ? undefined : v);
const add = STUDIO_TOOLS.add_risk.omit({ subject_type: true, subject_id: true });
const review = STUDIO_TOOLS.update_risk;
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blank, s);
export const RiskChangeRequest = z.discriminatedUnion("action", [
  add
    .extend({
      action: z.literal("add"),
      description: opt(add.shape.description),
      mitigation: opt(add.shape.mitigation),
      owner_user_id: opt(add.shape.owner_user_id),
      review_by: opt(add.shape.review_by),
      control_effectiveness: opt(add.shape.control_effectiveness),
      control_note: opt(add.shape.control_note),
    })
    .strict(),
  review
    .extend({
      action: z.literal("review"),
      status: opt(review.shape.status),
      mitigation: opt(review.shape.mitigation),
      owner_user_id: opt(review.shape.owner_user_id),
      review_by: opt(review.shape.review_by),
      control_effectiveness: opt(review.shape.control_effectiveness),
      control_note: opt(review.shape.control_note),
      residual_override_reason: opt(review.shape.residual_override_reason),
      note: opt(review.shape.note),
    })
    .strict(),
]);
export type RiskChangeRequest = z.infer<typeof RiskChangeRequest>;

/** Adds or reviews a risk on this subject's register; a review only of a risk Mynt lists on it. Returns what to say. */
export async function applyRiskChange(mynt: Client, subject: RiskSubject, change: RiskChangeRequest): Promise<string> {
  const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  if (change.action === "add") {
    const { action: _a, ...rest } = change;
    await callStudioTool(mynt, "add_risk", defined({ subject_type: subject.type, subject_id: subject.id, ...rest }));
    return "Risk added. It's open on the register, and recorded in the audit trail.";
  }
  const { action: _a, ...rest } = change;
  // The risk must be on this register: Mynt refuses a risk_id that isn't.
  await callStudioTool(mynt, "list_risks", { subject_type: subject.type, subject_id: subject.id, risk_id: change.risk_id });
  await callStudioTool(mynt, "update_risk", defined(rest));
  return "Risk reviewed. The change is recorded in its history.";
}
