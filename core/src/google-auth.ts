import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

// Access tokens for Google Cloud from a service account key, for Mynt's Vertex AI agent proxy. The key
// stays on Mynt's server; build sandboxes never see it.

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

export class GoogleServiceAccount {
  private cached: { token: string; expires: number } | null = null;

  constructor(private readonly sa: ServiceAccount) {}

  get projectId() {
    return this.sa.project_id ?? null;
  }

  // GOOGLE_APPLICATION_CREDENTIALS: path to a service account JSON key.
  static fromEnv(env = process.env): GoogleServiceAccount | null {
    if (!env.GOOGLE_APPLICATION_CREDENTIALS) return null;
    const sa = JSON.parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, "utf8")) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_APPLICATION_CREDENTIALS isn't a service account key");
    return new GoogleServiceAccount(sa);
  }

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expires > Date.now() + 60_000) return this.cached.token;
    const aud = this.sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ iss: this.sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud, iat: now, exp: now + 3600 }));
    const assertion = `${head}.${body}.${b64url(createSign("RSA-SHA256").update(`${head}.${body}`).sign(this.sa.private_key))}`;
    const res = await fetch(aud, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const data = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !data.access_token) throw new Error(`Google token exchange failed: ${data.error_description ?? res.status}`);
    this.cached = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return data.access_token;
  }
}
