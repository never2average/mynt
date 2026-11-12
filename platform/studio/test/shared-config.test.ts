import { afterEach, describe, expect, it } from "vitest";
import * as studio from "@/lib/config";
import * as chat from "../../chat/lib/config";

// The sign-in code is shared with mynt-chat (the @mynt/auth package, platform/packages/auth),
// but each app hands it its own lib/config.ts (lib/session.ts). These must answer the same,
// or the shared code would behave differently in the two apps (cookie security, redirects).
const SHARED = ["myntMcpUrl", "appUrl", "oauthRedirectUrl", "secureCookies", "oauthScope"] as const;

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const envs: Record<string, string | undefined>[] = [
  { MYNT_MCP_URL: "https://mynt.example.com/mcp", APP_URL: undefined, MYNT_OAUTH_SCOPE: undefined },
  { MYNT_MCP_URL: "https://mynt.example.com/mcp", APP_URL: "https://studio.example", MYNT_OAUTH_SCOPE: "openid" },
  { MYNT_MCP_URL: "https://mynt.example.com/mcp", APP_URL: "http://localhost:3001", MYNT_OAUTH_SCOPE: " openid email " },
  { MYNT_MCP_URL: "https://mynt.example.com/mcp", APP_URL: "http://127.0.0.1:3000" },
  { MYNT_MCP_URL: "https://mynt.example.com/mcp", APP_URL: "http://studio.example" },
];

describe("config the shared sign-in code depends on", () => {
  for (const env of envs) {
    it(`matches mynt-chat's with APP_URL=${env.APP_URL ?? "(unset)"}`, () => {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const name of SHARED) {
        expect(String(studio[name]()), name).toBe(String(chat[name]()));
      }
    });
  }

  it("both refuse a missing MYNT_MCP_URL", () => {
    delete process.env.MYNT_MCP_URL;
    expect(() => studio.myntMcpUrl()).toThrow(/MYNT_MCP_URL/);
    expect(() => chat.myntMcpUrl()).toThrow(/MYNT_MCP_URL/);
  });
});
