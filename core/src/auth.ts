import { createClerkClient } from "@clerk/backend";
import { ROLES, type Role, type Store, type User } from "./store.js";

// The parts of Clerk's backend client this server uses, so tests can provide a stand-in.
export interface ClerkLike {
  idPOAuthAccessToken: {
    verify(token: string, options?: { audience?: string | string[] }): Promise<{ subject: string; revoked: boolean; expired: boolean }>;
  };
  users: {
    getUser(userId: string): Promise<{
      firstName: string | null;
      lastName: string | null;
      primaryEmailAddressId: string | null;
      emailAddresses: { id: string; emailAddress: string; verification: { status: string } | null }[];
      publicMetadata?: Record<string, unknown> | null;
    }>;
  };
}

// Roles granted in Clerk: public metadata { "mynt_roles": ["admin"] } on the user (or on a Clerk
// invitation, which Clerk copies onto the user at sign-up). Only Clerk dashboard owners and the
// Backend API can set public metadata; users can't edit their own.
export const CLERK_ROLES_KEY = "mynt_roles";

export function rolesFromClerkMetadata(metadata: Record<string, unknown> | null | undefined): Role[] {
  const raw = metadata?.[CLERK_ROLES_KEY];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return [...new Set(list.filter((r): r is Role => (ROLES as readonly string[]).includes(r as string)))];
}

export interface ClerkAuthConfig {
  secretKey: string;
  publishableKey: string;
  publicUrl: string; // e.g. https://mcp.example.com
  requireAudience: boolean; // tokens must be issued for this server's /mcp resource
}

export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; status: 401 | 403; error: "invalid_token" | "not_whitelisted"; message: string };

// pk_test_<base64("<frontend-api-host>$")>
export function frontendApiFromPublishableKey(publishableKey: string): string {
  const encoded = publishableKey.split("_")[2] ?? "";
  const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("CLERK_PUBLISHABLE_KEY is not a valid Clerk publishable key");
  return host;
}

export function clerkConfigFromEnv(env = process.env): ClerkAuthConfig | null {
  if (!env.CLERK_SECRET_KEY) return null;
  if (!env.CLERK_PUBLISHABLE_KEY || !env.PUBLIC_URL) throw new Error("Clerk auth needs CLERK_PUBLISHABLE_KEY and PUBLIC_URL as well");
  return {
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
    requireAudience: env.MCP_REQUIRE_AUDIENCE !== "false",
  };
}

// Whitelist auth: Clerk proves who the caller is (OAuth access token); the invites table decides
// whether they may use the server and with which roles. Clerk's own allowlist is kept in step by
// the CLI so people who aren't invited can't sign up in the first place.
export class ClerkAuth {
  readonly issuer: string;
  readonly resource: string;

  constructor(
    private readonly config: ClerkAuthConfig,
    private readonly store: Store,
    private readonly clerk: ClerkLike = createClerkClient({ secretKey: config.secretKey, publishableKey: config.publishableKey }) as never,
  ) {
    this.issuer = `https://${frontendApiFromPublishableKey(config.publishableKey)}`;
    this.resource = `${config.publicUrl}/mcp`;
  }

  get resourceMetadataUrl(): string {
    return `${this.config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  }

  // RFC 9728: tells MCP clients that Clerk is the authorization server for this resource.
  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "profile", "email"],
      resource_name: "Mynt",
    };
  }

  async authenticate(token: string): Promise<AuthResult> {
    let subject: string;
    try {
      const t = await this.clerk.idPOAuthAccessToken.verify(token, this.config.requireAudience ? { audience: this.resource } : undefined);
      if (t.revoked || t.expired) throw new Error("token revoked or expired");
      subject = t.subject;
    } catch {
      return { ok: false, status: 401, error: "invalid_token", message: "The access token is invalid, expired or not issued for this server" };
    }

    const linked = await this.store.userByClerkId(subject);
    let email = linked?.email ?? null;
    let name = linked?.name ?? "";
    let invite = email ? await this.store.getInvite(email) : undefined;

    // Not whitelisted in Mynt (or not linked yet): ask Clerk for the verified email and any roles
    // granted there. Clerk-granted roles become a whitelist entry; from then on Mynt manages it.
    if (!invite) {
      const u = await this.clerk.users.getUser(subject);
      // Only a verified address counts, primary first.
      const verified = u.emailAddresses.filter((e) => e.verification?.status === "verified");
      const primary = verified.find((e) => e.id === u.primaryEmailAddressId) ?? verified[0];
      email = primary?.emailAddress.toLowerCase() ?? null;
      name = name || [u.firstName, u.lastName].filter(Boolean).join(" ") || email || "user";
      invite = email ? await this.store.getInvite(email) : undefined;
      const granted = rolesFromClerkMetadata(u.publicMetadata);
      if (email && !invite && granted.length) {
        invite = await this.store.upsertInvite(email, granted);
        await this.store.audit(null, "invite_via_clerk", email, { roles: granted, clerk_user_id: subject });
      }
      // Public sign-up: anyone with a verified email joins as a consumer, through an invite like
      // everyone else (so admins can see and revoke it), unless an admin revoked them before.
      if (email && !invite && (await this.store.publicSignup()) && !(await this.store.isSignupBlocked(email))) {
        invite = await this.store.upsertInvite(email, ["consumer"]);
        await this.store.audit(null, "invite_via_public_signup", email, { roles: ["consumer"], clerk_user_id: subject });
      }
    }

    if (!email || !invite) {
      return {
        ok: false,
        status: 403,
        error: "not_whitelisted",
        message: email ? "Your account is not on this server's whitelist" : "Verify your email address with the sign-in provider, then sign in again",
      };
    }
    if (linked && (linked.held_roles ?? linked.roles).join() === invite.roles.join()) return { ok: true, user: linked };
    return { ok: true, user: await this.store.upsertClerkUser(subject, email, name, invite.roles) };
  }
}

// Clerk Backend API calls used by `clerk setup` and the whitelist CLI.
export class ClerkAdmin {
  private readonly api = "https://api.clerk.com/v1";
  constructor(private readonly secretKey: string) {}

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.api}${path}`, {
      method,
      // Clerk's edge refuses some default client User-Agents.
      headers: { Authorization: `Bearer ${this.secretKey}`, "Content-Type": "application/json", "User-Agent": "mynt" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(data?.errors?.[0]?.long_message ?? data?.errors?.[0]?.message ?? `Clerk API ${res.status}`);
      (err as Error & { status?: number; code?: string }).status = res.status;
      (err as Error & { status?: number; code?: string }).code = data?.errors?.[0]?.code;
      throw err;
    }
    return data;
  }

  // Idempotent: allowlist on, dynamic client registration (how MCP clients register), PKCE required,
  // and audience claims so a token is bound to the resource it was issued for.
  // Mynt's own apps (the studio, the chat app) as pre-registered OAuth applications with no consent screen: a person
  // signing in to Mynt's own app isn't asked to let Mynt access Mynt. Only an operator registers one, by name and exact
  // redirect URI; each is a confidential client (its secret stays on that app's server) with PKCE required. Clients
  // that register themselves (MCP clients, any third party) always get the consent screen: Clerk doesn't let a
  // dynamically registered application turn it off, and nothing here touches them.
  // Refuses a name that's already registered (its secret can't be read back; rotate it in Clerk's dashboard).
  async firstPartyApp(name: string, redirectUri: string): Promise<{ client_id: string; client_secret: string; consent_screen_enabled: boolean }> {
    const u = new URL(redirectUri);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("The redirect URI must be https (http only for localhost)");
    if (u.hash || u.search) throw new Error("The redirect URI must be exact: no query or fragment");
    const existing = (await this.call("GET", "/oauth_applications?limit=500")) as { data?: { name?: string; client_id?: string }[] } | { name?: string }[];
    const list = Array.isArray(existing) ? existing : (existing.data ?? []);
    const same = list.find((a) => a.name === name);
    if (same) throw new Error(`An OAuth application named '${name}' already exists (${(same as { client_id?: string }).client_id ?? "client id unknown"}); rotate its secret in Clerk's dashboard, or choose another name`);
    const app = (await this.call("POST", "/oauth_applications", {
      name,
      redirect_uris: [redirectUri],
      scopes: "profile email",
      public: false,
      pkce_required: true,
      consent_screen_enabled: false,
    })) as { client_id?: string; client_secret?: string; consent_screen_enabled?: boolean };
    if (!app.client_id || !app.client_secret) throw new Error("Clerk didn't return a client id and secret");
    // Kept on (an older instance or plan): the caller still gets the secret, and says so.
    return { client_id: app.client_id, client_secret: app.client_secret, consent_screen_enabled: app.consent_screen_enabled !== false };
  }

  // Returns warnings: Clerk's allowlist is a second layer (the invites table always decides), so a plan
  // without it doesn't stop the setup.
  async setup(opts: { allowlist: boolean } = { allowlist: true }): Promise<string[]> {
    const warnings: string[] = [];
    const allowlist = await this.setAllowlist(opts.allowlist);
    if (allowlist) warnings.push(allowlist);
    await this.call("PATCH", "/instance/oauth_application_settings", {
      dynamic_oauth_client_registration: true,
      pkce_required: true,
      aud_claim_enabled: true,
    });
    return warnings;
  }

  // Clerk's allowlist on (invite-only) or off (public sign-up). Best effort: Mynt's invites decide
  // access either way, so a failure comes back as a warning.
  async setAllowlist(enabled: boolean): Promise<string | null> {
    try {
      await this.call("PATCH", "/instance/restrictions", { allowlist: enabled });
      return null;
    } catch (e) {
      return `Clerk allowlist not turned ${enabled ? "on" : "off"} (${(e as Error).message}); ${enabled ? "the server's own whitelist still applies" : "Clerk may still refuse sign-ups from emails not on its allowlist"}`;
    }
  }

  // Best effort: the invite is what grants access; Clerk's allowlist only stops other sign-ups.
  async allow(email: string): Promise<string | null> {
    try {
      await this.call("POST", "/allowlist_identifiers", { identifier: email.toLowerCase(), notify: false });
      return null;
    } catch (e) {
      // Clerk reports an existing entry with varying status codes; the message is what's stable.
      if ((e as { status?: number }).status === 409 || /already exists|taken|duplicate/i.test((e as Error).message)) return null;
      return `not added to Clerk's allowlist (${(e as Error).message})`;
    }
  }

  async disallow(email: string): Promise<void> {
    const list = (await this.call("GET", "/allowlist_identifiers?limit=500")) as { id: string; identifier: string }[] | { data: { id: string; identifier: string }[] };
    const items = Array.isArray(list) ? list : list.data;
    for (const item of items.filter((i) => i.identifier.toLowerCase() === email.toLowerCase())) {
      await this.call("DELETE", `/allowlist_identifiers/${item.id}`);
    }
  }

  // Mirrors Mynt's roles onto the Clerk user's public metadata (null clears them), so a revoked
  // person can't be re-granted by roles left behind in Clerk.
  async setRoles(clerkUserId: string, roles: Role[] | null): Promise<void> {
    await this.call("PATCH", `/users/${encodeURIComponent(clerkUserId)}/metadata`, { public_metadata: { [CLERK_ROLES_KEY]: roles } });
  }
}
