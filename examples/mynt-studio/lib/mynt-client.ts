// Connecting to Mynt as the signed-in user and calling one tool. Shared, byte for byte, by the
// example apps (CI diffs it); each app's own tool allow-list lives elsewhere.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mcpClientInfo, myntMcpUrl } from "./config";
import { oauthProviderFor } from "./session";
import type { Session } from "./session-store";

export class NotSignedInError extends Error {
  constructor() {
    super("Sign in to Mynt to continue");
  }
}

// Signed in, but Mynt doesn't let this account in (sign-up is invite-only, the email isn't
// verified, or an admin revoked it). The message is Mynt's own.
export class NotAllowedError extends Error {}

function refusal(err: unknown): string | null {
  if (!(err instanceof StreamableHTTPError) || err.code !== 403) return null;
  const body = err.message.match(/\{.*\}/s)?.[0];
  try {
    const message = body ? (JSON.parse(body) as { message?: unknown }).message : undefined;
    if (typeof message === "string" && message) return message;
  } catch {
    // not JSON; fall through
  }
  return "Your account isn't allowed on Mynt";
}

// A connected MCP client for this session, using its stored OAuth tokens (refreshed by the SDK
// when they expire). Call close() when done.
export async function connectMynt(session: Session): Promise<Client> {
  if (!session.tokens) throw new NotSignedInError();
  const transport = new StreamableHTTPClientTransport(myntMcpUrl(), { authProvider: oauthProviderFor(session) });
  const client = new Client(mcpClientInfo());
  try {
    await client.connect(transport);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      session.tokens = undefined;
      throw new NotSignedInError();
    }
    const refused = refusal(err);
    if (refused) throw new NotAllowedError(refused);
    throw err;
  }
  return client;
}

export interface ToolOutcome {
  isError: boolean;
  text: string; // the tool's text content, as Mynt returned it
}

export async function callMyntTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((c: { type: string; text?: string }) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
  return { isError: result.isError === true, text: text || JSON.stringify(result.structuredContent ?? {}) };
}
