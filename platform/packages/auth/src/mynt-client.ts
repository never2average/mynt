// Connecting to Mynt as the signed-in user and calling one tool. Each app's own tool allow-list
// lives in the app.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthConfig, AuthSession } from "./types";

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

// connectMynt for one app: its settings, and its sessions' OAuth provider.
export function createConnectMynt<S extends AuthSession>(app: {
  config: Pick<AuthConfig, "myntMcpUrl" | "mcpClientInfo">;
  oauthProviderFor(session: S): OAuthClientProvider;
}) {
  // A connected MCP client for this session, using its stored OAuth tokens (refreshed by the SDK
  // when they expire). Call close() when done.
  return async function connectMynt(session: S): Promise<Client> {
    if (!session.tokens) throw new NotSignedInError();
    const transport = new StreamableHTTPClientTransport(app.config.myntMcpUrl(), { authProvider: app.oauthProviderFor(session) });
    const client = new Client(app.config.mcpClientInfo());
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
  };
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
