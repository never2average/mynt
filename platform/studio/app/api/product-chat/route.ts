import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ChatBody, readCapped, STREAM_HEADERS, TOO_LARGE } from "@/lib/ai-route";
import { historyFrom, runAsk } from "@/lib/ask";
import { askConfigured, askModel, createLlm } from "@/lib/llm";
import { NotAllowedError } from "@/lib/mynt-client";
import { DRAFT_PRODUCT, DRAFT_PRODUCT_DEF, PRODUCT_CHAT_SYSTEM_PROMPT, productChatContext, productCommandText, validateProductDraft, type ProductChoices } from "@/lib/product-chat";
import { optionsFrom, productsFrom } from "@/lib/products";
import { currentSession, fromOwnOrigin } from "@/lib/session";
import { finishSession } from "@/lib/session-response";
import { sessionStore } from "@/lib/session-store";
import { callStudioTool, ensureRoles, GENERIC_REFUSAL, isAuthError, logLine, sessionIsDeveloper, ToolRefusedError } from "@/lib/studio-server";
import { connectStudio } from "@/lib/tokens";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
// The same limits as Ask AI (app/api/ask), counted separately: one answer at a time per user, a
// capped body, and messages per user per hour.
export const BUSY_SECONDS = 130;
export const MAX_BODY_BYTES = 64 * 1024;
export const PRODUCT_CHAT_PER_HOUR = 20;
export const PRODUCT_CHAT_WINDOW_SECONDS = 60 * 60;

const noStore = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

// Whether the assistant can answer here (Create product mode says "AI is not configured" otherwise).
export async function GET() {
  const session = await currentSession();
  if (!session?.tokens) return json({ error: "auth_required" }, 401);
  return json({ enabled: askConfigured() });
}

// A Mynt read the assistant can do without: an older Mynt, or one refusing it, leaves that list empty.
async function readOr(mynt: Client, tool: string, fallback: unknown): Promise<unknown> {
  try {
    return await callStudioTool(mynt, tool);
  } catch (err) {
    if (isAuthError(err)) throw err;
    return fallback;
  }
}

// What the assistant may choose from, as Mynt answers this user now: the Create product sheet's regions
// and categories, the published products it can build on, and the user's own products' ids.
async function loadChoices(mynt: Client): Promise<ProductChoices> {
  const [regions, categories, buildable, mine] = await Promise.all([
    readOr(mynt, "list_regions", []),
    readOr(mynt, "list_product_categories", []),
    readOr(mynt, "list_buildable_products", []),
    readOr(mynt, "list_my_products", []),
  ]);
  const options = optionsFrom(regions, categories);
  const listed = productsFrom(buildable, mine);
  return {
    ...options,
    buildable: listed.filter((p) => !p.mine).map((p) => ({ id: p.id, name: p.name, productLine: p.productLine })),
    mine: (Array.isArray(mine) ? mine : []).map((p) => (p as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string"),
  };
}

// "/create-product <description>" sent in Create product mode is the description.
function withoutCommand(messages: { role: string; parts?: { type: string; text?: string }[] }[]) {
  return messages.map((m) =>
    m.role === "user" && m.parts ? { ...m, parts: m.parts.map((p) => (p.type === "text" && typeof p.text === "string" && productCommandText(p.text) !== null ? { ...p, text: productCommandText(p.text) || "I want to create a product." } : p)) } : m,
  );
}

// New app's Create product mode: the assistant asks for what a product needs and drafts it with
// draft_product (lib/product-chat.ts), streamed as AI SDK UI message parts. It calls none of Mynt's
// tools itself: the regions, categories and products it chooses from are read once per message as
// the signed-in developer and given as context. A draft comes back as draft_product's result (the
// chat draws it as a card) and creates nothing: only the user's own click in the Create product sheet
// does, through POST /api/products. What's asked and answered is never logged.
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
  const history = parsed.success ? historyFrom(withoutCommand(parsed.data.messages)) : null;
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
    console.error(logLine("connecting for the product assistant", err));
    return finishSession(json({ error: "unreachable", message: "Couldn't reach Mynt. Please try again." }, 502), session);
  }
  const done = async () => {
    await mynt.close().catch(() => undefined);
    await sessionStore()
      .save(session)
      .catch((err) => console.error(logLine("saving the session", err)));
  };
  if (!sessionIsDeveloper(session)) {
    await done();
    return json({ error: "not_developer", message: "Mynt Studio is for developers. Ask a Mynt admin for the developer role." }, 403);
  }
  const who = session.userId ?? session.id;
  const release = await sessionStore().claim("product-chat-busy", who, BUSY_SECONDS);
  if (!release) {
    await done();
    return json({ error: "busy", message: "The assistant is still answering your last message." }, 429);
  }
  if ((await sessionStore().count("product-chat", who, PRODUCT_CHAT_WINDOW_SECONDS)) > PRODUCT_CHAT_PER_HOUR) {
    await release().catch(() => undefined);
    await done();
    return NextResponse.json(
      { error: "rate_limited", message: `You've sent ${PRODUCT_CHAT_PER_HOUR} messages in the last hour. The assistant will answer again shortly; the Create product form still works.` },
      { status: 429, headers: { ...noStore, "Retry-After": String(PRODUCT_CHAT_WINDOW_SECONDS) } },
    );
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        const choices = await loadChoices(mynt);
        let textId = 0;
        let reasoningId = 0;
        await runAsk(history, {
          llm: createLlm(),
          model: askModel(),
          tools: [DRAFT_PRODUCT_DEF],
          workspaceId: null,
          system: PRODUCT_CHAT_SYSTEM_PROMPT,
          context: productChatContext(choices),
          // None of Mynt's tools: only the draft, answered here.
          allowTool: () => false,
          local: {
            [DRAFT_PRODUCT]: async (input) => {
              const out = validateProductDraft(input, choices, randomUUID());
              if ("error" in out) return { content: `Draft refused: ${out.error}`, isError: true, output: { error: out.error } };
              return { content: "The draft is shown in the chat as a card. Nothing has been created: only the user's own click in the Create product form does that.", output: { draft: out.draft } };
            },
          },
          signal: req.signal,
          callTool: async () => ({ text: "No Mynt tools here.", isError: true }),
          emit: (ev) => {
            // Reasoning is shown, never logged or kept.
            if (ev.type === "reasoning-start") writer.write({ type: "reasoning-start", id: `r${++reasoningId}` });
            else if (ev.type === "reasoning") writer.write({ type: "reasoning-delta", id: `r${reasoningId}`, delta: ev.delta });
            else if (ev.type === "reasoning-end") writer.write({ type: "reasoning-end", id: `r${reasoningId}` });
            else if (ev.type === "text-start") writer.write({ type: "text-start", id: `t${++textId}` });
            else if (ev.type === "text") writer.write({ type: "text-delta", id: `t${textId}`, delta: ev.delta });
            else if (ev.type === "text-end") writer.write({ type: "text-end", id: `t${textId}` });
            else if (ev.type === "tool") {
              writer.write({ type: "tool-input-available", toolCallId: ev.id, toolName: ev.name, input: ev.input });
              writer.write({ type: "tool-output-available", toolCallId: ev.id, output: { ok: ev.ok, ...(ev.output && typeof ev.output === "object" ? ev.output : {}) } });
            }
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
      console.error(logLine("the product assistant", err));
      return GENERIC_REFUSAL;
    },
  });
  return createUIMessageStreamResponse({ stream, headers: STREAM_HEADERS });
}
