import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ChatBody, readCapped, TOO_LARGE } from "@/lib/ai-route";
import { historyFrom, runAsk, type LocalTool } from "@/lib/ask";
import { EARN_SYSTEM_PROMPT, earnContext, earnToolDefs, isEarnTool, PANEL_TOOL_DEFS, shownPools, validateDraft } from "@/lib/earn";
import { loadLiquidity, sessionAccess, sessionCanUseLiquidity } from "@/lib/liquidity-server";
import type { LiquidityData } from "@/lib/liquidity";
import { askConfigured, askModel, createLlm } from "@/lib/llm";
import { NotAllowedError } from "@/lib/mynt-client";
import { currentSession, fromOwnOrigin } from "@/lib/session";
import { finishSession } from "@/lib/session-response";
import { sessionStore } from "@/lib/session-store";
import { callStudioTool, ensureRoles, GENERIC_REFUSAL, isAuthError, listMyntTools, logLine, MyntRefusedError, ToolRefusedError } from "@/lib/studio-server";
import { connectStudio } from "@/lib/tokens";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
// The same limits as Ask AI (app/api/ask), counted separately: one answer at a time per user, a
// capped body, and questions per user per hour.
export const BUSY_SECONDS = 130;
export const MAX_BODY_BYTES = 64 * 1024;
export const EARN_PER_HOUR = 20;
export const EARN_WINDOW_SECONDS = 60 * 60;

const noStore = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

// Whether the assistant can answer here (the page says "AI is not configured" otherwise).
export async function GET() {
  const session = await currentSession();
  if (!session?.tokens) return json({ error: "auth_required" }, 401);
  return json({ enabled: askConfigured() });
}

// Earn's assistant: explains pools' terms and matches them to what the user asks, streamed as AI
// SDK UI message parts. It reads only Earn's tools (lib/earn.ts) as the signed-in user. Its panel
// tools draw pools and drafts beside the chat (data-earn-pools, data-earn-draft parts) and never
// write: committing or withdrawing is only ever the user's own click, through app/api/liquidity.
// What's asked and answered is never logged.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const session = await currentSession();
  if (!session?.tokens) return json({ error: "auth_required" }, 401);
  if (!askConfigured()) return json({ error: "not_configured", message: "AI is not configured." }, 503);
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (raw === TOO_LARGE) return json({ error: "too_large", message: "That conversation is too long. Start a new chat." }, 413);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const parsed = ChatBody.safeParse(body);
  const history = parsed.success ? historyFrom(parsed.data.messages) : null;
  if (!history) return json({ error: "bad_request" }, 400);

  let mynt: Client;
  try {
    mynt = await connectStudio(session);
    await ensureRoles(session, mynt);
  } catch (err) {
    if (isAuthError(err)) {
      session.tokens = undefined;
      return finishSession(json({ error: "auth_required" }, 401), session);
    }
    if (err instanceof NotAllowedError) return finishSession(json({ error: "not_allowed", message: err.message }, 403), session);
    console.error(logLine("connecting for Earn", err));
    return finishSession(json({ error: "unreachable", message: "Couldn't reach Mynt. Please try again." }, 502), session);
  }
  const done = async () => {
    await mynt.close().catch(() => undefined);
    await sessionStore()
      .save(session)
      .catch((err) => console.error(logLine("saving the session", err)));
  };
  if (!sessionCanUseLiquidity(session)) {
    await done();
    return json({ error: "not_allowed", message: "Earn is for builders and liquidity providers." }, 403);
  }
  const access = sessionAccess(session);
  const who = session.userId ?? session.id;
  const release = await sessionStore().claim("earn-busy", who, BUSY_SECONDS);
  if (!release) {
    await done();
    return json({ error: "busy", message: "The assistant is still answering your last question." }, 429);
  }
  if ((await sessionStore().count("earn", who, EARN_WINDOW_SECONDS)) > EARN_PER_HOUR) {
    await release().catch(() => undefined);
    await done();
    return NextResponse.json(
      { error: "rate_limited", message: `You've asked ${EARN_PER_HOUR} questions in the last hour. The assistant will answer again shortly; the tables still work.` },
      { status: 429, headers: { ...noStore, "Retry-After": String(EARN_WINDOW_SECONDS) } },
    );
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Pools and positions as Mynt answers them now: read afresh for every draft, so a draft is
      // checked against the pool's current terms.
      const visible = async () => {
        const data: LiquidityData = await loadLiquidity(mynt, access);
        return { pools: [...(data.provider?.pools ?? []), ...(data.builder?.pools ?? [])], lpPools: data.provider?.pools ?? [], positions: data.provider?.positions ?? [], canCommit: data.provider?.canCommit ?? false, canWithdraw: data.provider?.canWithdraw ?? false };
      };
      const data = (name: string, value: unknown) => writer.write({ type: `data-${name}` as `data-${string}`, data: value });
      const draft =
        (kind: "commit" | "withdraw"): LocalTool =>
        async (input) => {
          if (!access.liquidityProvider) return { content: "Only a liquidity provider can commit or withdraw capital; this user can't, so there's nothing to draft.", isError: true };
          const v = await visible();
          if (kind === "commit" ? !v.canCommit : !v.canWithdraw) return { content: "This Mynt doesn't offer that yet.", isError: true };
          const out = validateDraft(kind, input, v.lpPools, v.positions, randomUUID());
          if ("error" in out) return { content: `Draft refused: ${out.error}`, isError: true };
          data("earn-draft", out.draft);
          return { content: "The draft is shown in the panel as a card. Nothing has been sent: only the user's own click on it does that." };
        };
      const local: Record<string, LocalTool> = {
        show_pools: async (input) => {
          const ids = shownPools(input, (await visible()).pools);
          data("earn-pools", { pool_ids: ids });
          return { content: ids.length ? `Showing ${ids.length} pool(s) in the panel.` : "Showing every pool open to the user in the panel." };
        },
        draft_commitment: draft("commit"),
        draft_withdrawal: draft("withdraw"),
      };
      try {
        const tools = await listMyntTools(mynt);
        let textId = 0;
        await runAsk(history, {
          llm: createLlm(),
          model: askModel(),
          tools: [...earnToolDefs(tools), ...PANEL_TOOL_DEFS],
          workspaceId: null,
          system: EARN_SYSTEM_PROMPT,
          context: earnContext(access),
          allowTool: isEarnTool,
          local,
          signal: req.signal,
          callTool: async (name, args) => {
            try {
              return { text: JSON.stringify(await callStudioTool(mynt, name, args)), isError: false };
            } catch (err) {
              if (err instanceof MyntRefusedError || err instanceof ToolRefusedError) return { text: err.message, isError: true };
              throw err;
            }
          },
          emit: (ev) => {
            if (ev.type === "text-start") writer.write({ type: "text-start", id: `t${++textId}` });
            else if (ev.type === "text") writer.write({ type: "text-delta", id: `t${textId}`, delta: ev.delta });
            else if (ev.type === "text-end") writer.write({ type: "text-end", id: `t${textId}` });
            else if (ev.type === "tool") {
              writer.write({ type: "tool-input-available", toolCallId: ev.id, toolName: ev.name, input: ev.input });
              writer.write({ type: "tool-output-available", toolCallId: ev.id, output: { ok: ev.ok } });
            } else data(ev.name, ev.data);
          },
        });
      } catch (err) {
        if (isAuthError(err)) {
          session.tokens = undefined;
          throw new ToolRefusedError("Your sign-in has expired. Sign in again to carry on.");
        }
        throw err;
      } finally {
        await release().catch(() => undefined);
        await done();
      }
    },
    onError: (err) => {
      if (err instanceof ToolRefusedError) return err.message;
      console.error(logLine("Earn", err));
      return GENERIC_REFUSAL;
    },
  });
  return createUIMessageStreamResponse({ stream, headers: noStore });
}
