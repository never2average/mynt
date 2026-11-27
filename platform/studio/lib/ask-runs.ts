// What Ask AI is given to answer with, in each of its two areas: the tools it may call, its instructions and the one
// way its reads reach Mynt. The routes (app/api/ask, app/api/admin/ask) build it over the signed-in person's own
// connection; Ask AI's benchmark (lib/ask-benchmark.ts) builds the same thing over a fixture. `read` is the only
// difference between them, so a benchmark measures the assistant people use.
import { ADMIN_ASK_CONTEXT, ADMIN_ASK_SYSTEM_PROMPT, isAdminAskTool, type AdminAskTool } from "./admin-ask";
import { askToolDefs, type AskTool } from "./ask";
import type { AnswerRun } from "./ask-server";
import { ToolRefusedError } from "./studio-server";
import { isAdminTool, parseAdminCall } from "./studio-tools";

type MyntTools = Parameters<typeof askToolDefs>[0];
/** One read: Mynt's reply, or a ToolRefusedError (Mynt's refusal, or the studio's own) to tell the model why not. */
export type AskRead<T extends string> = (tool: T, args: Record<string, unknown>) => Promise<unknown>;

// A refusal goes back to the model as the read's result; anything else thrown (a sign-in Mynt no longer accepts, Mynt
// unreachable) ends the answer.
async function answered(read: () => Promise<unknown>): Promise<{ text: string; isError: boolean }> {
  try {
    return { text: JSON.stringify(await read()), isError: false };
  } catch (err) {
    if (err instanceof ToolRefusedError) return { text: err.message, isError: true };
    throw err;
  }
}

/** The studio's Ask AI: its own reads (lib/ask.ts ASK_TOOLS), in the selected workspace. */
export function studioAskRun(tools: MyntTools, workspaceId: string | null, read: AskRead<AskTool>): AnswerRun {
  return { tools: askToolDefs(tools), workspaceId, callTool: (name, args) => answered(() => read(name as AskTool, args)) };
}

/** The platform admin's Ask AI: the reads in lib/admin-ask.ts, each through the Admin area's strict arguments first. */
export function adminAskRun(tools: MyntTools, read: AskRead<AdminAskTool>): AnswerRun {
  return {
    tools: askToolDefs(tools, isAdminAskTool),
    workspaceId: null,
    system: ADMIN_ASK_SYSTEM_PROMPT,
    context: ADMIN_ASK_CONTEXT,
    allowTool: isAdminAskTool,
    knownTool: isAdminTool,
    callTool: async (name, args) => {
      // What the strict arguments refuse never reaches Mynt, and the model is told why.
      const call = parseAdminCall(name, args);
      if ("error" in call || !isAdminAskTool(call.tool)) return { text: `Not sent to Mynt: ${"error" in call ? call.error : "it can only read"}`, isError: true };
      const tool = call.tool;
      return answered(() => read(tool, call.args));
    },
  };
}
