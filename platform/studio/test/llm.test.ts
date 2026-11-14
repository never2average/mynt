import { describe, expect, it } from "vitest";
import { GoogleAuth } from "google-auth-library";

import { askConfigured, createLlm, vertexAuth } from "@/lib/llm";

// A made-up key: the shape of a service-account JSON key, never a real one.
const FAKE_KEY = JSON.stringify({
  type: "service_account",
  client_email: "ask-ai@example-project.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
});

describe("Ask AI's Vertex credentials on a host with no key file", () => {
  it("is off with neither setting, on with a Vertex project", () => {
    expect(askConfigured({})).toBe(false);
    expect(askConfigured({ VERTEX_PROJECT_ID: "example-project" })).toBe(true);
  });

  it("reads the service account's key from VERTEX_CREDENTIALS_JSON", () => {
    const auth = vertexAuth({ VERTEX_CREDENTIALS_JSON: FAKE_KEY });
    expect(auth).toBeInstanceOf(GoogleAuth);
  });

  it("falls back to the default credentials when it isn't set", () => {
    expect(vertexAuth({})).toBeNull();
    expect(vertexAuth({ VERTEX_CREDENTIALS_JSON: "  " })).toBeNull();
  });

  it("refuses a value that isn't a service-account key, without echoing it", () => {
    expect(() => vertexAuth({ VERTEX_CREDENTIALS_JSON: "secret-ish{" })).toThrow(/isn't valid JSON$/);
    expect(() => vertexAuth({ VERTEX_CREDENTIALS_JSON: JSON.stringify({ type: "service_account" }) })).toThrow(/isn't a service-account key/);
    try {
      vertexAuth({ VERTEX_CREDENTIALS_JSON: "secret-ish{" });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("secret-ish");
    }
  });

  it("builds a Vertex client with the key", () => {
    const llm = createLlm({ VERTEX_PROJECT_ID: "example-project", VERTEX_CREDENTIALS_JSON: FAKE_KEY });
    expect(typeof llm.stream).toBe("function");
  });
});
