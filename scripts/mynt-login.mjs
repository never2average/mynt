// Signs a person in to a Mynt server from the command line and returns an access token, kept in memory
// only. It does what an MCP client does: reads the server's OAuth protected-resource metadata, then
// its authorization server's metadata (Clerk, on Mynt), registers itself as a public client (dynamic
// client registration), and runs the authorization code flow with PKCE (S256) and a state check,
// receiving the callback on 127.0.0.1 only. The token is returned, never printed or written anywhere.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const SCOPE = "openid profile email";
const b64url = (buf) => Buffer.from(buf).toString("base64url");

async function getJson(fetchFn, url) {
  const r = await fetchFn(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

// RFC 9728: /.well-known/oauth-protected-resource with the resource's path appended, then without it.
async function resourceMetadata(fetchFn, mcpUrl) {
  const u = new URL(mcpUrl);
  const path = u.pathname.replace(/\/+$/, "");
  for (const p of [...(path ? [`/.well-known/oauth-protected-resource${path}`] : []), "/.well-known/oauth-protected-resource"]) {
    const m = await getJson(fetchFn, new URL(p, u.origin));
    if (m?.authorization_servers?.length) return m;
  }
  throw new Error(`${u.origin} doesn't publish OAuth metadata for its MCP endpoint, so --login can't be used there. Check the URL (it ends in /mcp), or use MYNT_ADMIN_TOKEN.`);
}

// RFC 8414 (path inserted after the well-known prefix), then OpenID discovery.
async function authServerMetadata(fetchFn, issuer) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  for (const p of [`/.well-known/oauth-authorization-server${path}`, `${path}/.well-known/openid-configuration`]) {
    const m = await getJson(fetchFn, new URL(p, u.origin));
    if (m?.authorization_endpoint && m?.token_endpoint) return m;
  }
  throw new Error(`Couldn't read the sign-in service's settings at ${u.origin}.`);
}

export function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening the browser is a convenience: the URL is printed too.
  }
}

// Waits on 127.0.0.1 for the browser to come back with ?code&state. Resolves with the code; rejects on an
// error from the sign-in service, a state that isn't ours, or the timeout.
function callbackServer(state, timeoutMs) {
  let resolveCode;
  let rejectCode;
  const code = new Promise((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  code.catch(() => {}); // a rejection before anyone awaits it isn't an unhandled crash

  const page = (res, status, text) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Mynt sign-in</title><body style="font-family:system-ui;padding:2rem"><p>${text}</p></body>`);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") return void page(res, 404, "Not found.");
    const error = url.searchParams.get("error");
    if (url.searchParams.get("state") !== state) {
      page(res, 400, "This sign-in link doesn't match the one the script started. Run the script again.");
      return rejectCode(new Error("Sign-in failed: the response didn't match this sign-in (state check). Nothing was changed; run the script again."));
    }
    if (error) {
      page(res, 400, "Sign-in didn't complete. You can close this tab and look at the terminal.");
      const description = url.searchParams.get("error_description");
      return rejectCode(new Error(`Sign-in failed: ${error}${description ? ` (${description})` : ""}`));
    }
    const c = url.searchParams.get("code");
    if (!c) {
      page(res, 400, "Sign-in didn't return a code. Run the script again.");
      return rejectCode(new Error("Sign-in failed: no authorization code came back."));
    }
    page(res, 200, "Signed in to Mynt. You can close this tab and go back to the terminal.");
    resolveCode(c);
  });
  const timer = setTimeout(() => rejectCode(new Error(`Sign-in timed out after ${Math.round(timeoutMs / 60000)} minutes. Run the script again.`)), timeoutMs);
  const close = () => {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close();
  };
  const listening = new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res(server.address().port));
  });
  return { listening, code, close };
}

/**
 * @param {object} o
 * @param {string} o.mcpUrl     the Mynt MCP URL (…/mcp)
 * @param {(line: string) => void} [o.log]  where to tell the person what to do
 * @param {(url: string) => void} [o.openBrowser]
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<string>} the access token
 */
export async function login({ mcpUrl, log = (l) => console.error(l), openBrowser = openInBrowser, fetch: fetchFn = fetch, timeoutMs = 5 * 60_000 }) {
  const prm = await resourceMetadata(fetchFn, mcpUrl);
  const resource = prm.resource ?? mcpUrl;
  const as = await authServerMetadata(fetchFn, prm.authorization_servers[0]);
  if (as.code_challenge_methods_supported && !as.code_challenge_methods_supported.includes("S256"))
    throw new Error("The sign-in service doesn't support PKCE (S256), which --login needs.");
  if (!as.registration_endpoint)
    throw new Error("The sign-in service doesn't allow client registration, which --login needs. An engineer turns it on with `mynt clerk setup`; until then use MYNT_ADMIN_TOKEN.");
  if (as.token_endpoint_auth_methods_supported && !as.token_endpoint_auth_methods_supported.includes("none"))
    throw new Error("The sign-in service doesn't accept public clients (token_endpoint_auth_method none), which --login needs.");

  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const cb = callbackServer(state, timeoutMs);
  try {
    const port = await cb.listening;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const reg = await fetchFn(as.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "Mynt seed definitions script",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      }),
    });
    const client = await reg.json().catch(() => ({}));
    if (!reg.ok || !client.client_id) throw new Error(`The sign-in service refused to register this script (HTTP ${reg.status}${client.error ? `: ${client.error}` : ""}).`);

    const auth = new URL(as.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    }))
      auth.searchParams.set(k, v);
    log("Sign in to Mynt in your browser. If it doesn't open by itself, open this link (it works once, for the next few minutes):");
    log(`  ${auth.href}`);
    openBrowser(auth.href);

    const code = await cb.code;
    const tok = await fetchFn(as.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource }),
    });
    const body = await tok.json().catch(() => ({}));
    if (!tok.ok || typeof body.access_token !== "string" || !body.access_token)
      throw new Error(`Sign-in failed when collecting the session (HTTP ${tok.status}${body.error ? `: ${body.error}` : ""}).`);
    log("Signed in.");
    return body.access_token;
  } finally {
    cb.close();
  }
}
