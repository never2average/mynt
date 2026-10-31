import type { DevTool } from "@/lib/developer";

export interface ToolResult {
  ok: boolean;
  data: unknown; // Mynt's reply, parsed from JSON when it is JSON
  error?: string; // set when the call didn't reach Mynt, or Mynt refused it
  signedOut?: boolean;
}

// Calls one of Mynt's developer tools through this app's server (the user's own Mynt session).
// Replies, including credentials, are handed to the caller and kept nowhere else.
export async function callDevTool(tool: DevTool, args: Record<string, unknown> = {}): Promise<ToolResult> {
  let res: Response;
  try {
    res = await fetch("/api/developer/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, data: null, error: "You seem to be offline. Please try again." };
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: unknown; error?: string } | null;
  if (res.status === 401) return { ok: false, data: null, error: "Your sign-in has expired. Sign in again.", signedOut: true };
  if (body && "data" in body) {
    const ok = body.ok === true;
    const err = (body.data as { error?: unknown } | null)?.error;
    return { ok, data: body.data, error: ok ? undefined : typeof err === "string" ? err : typeof body.data === "string" ? body.data : "Mynt refused this." };
  }
  return { ok: false, data: null, error: body?.error ?? `Request failed (${res.status})` };
}
