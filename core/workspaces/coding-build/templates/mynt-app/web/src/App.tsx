// Runs on a client session from api/ (never an app key). Renders a journey step by step with the SDK's
// headless runner, which records document and consent evidence and starts the provider's hosted flows.
import { useEffect, useState } from "react";
import { createMyntBrowserClient, createJourneyRunner } from "mynt-sdk/browser";

type Runner = Awaited<ReturnType<typeof createJourneyRunner>>;
const JOURNEY_ID = new URLSearchParams(location.search).get("journey") ?? "default";
// The exact text of each document the product requires, as published by the provider. Show it verbatim.
const DOCUMENT_TEXT: Record<string, string> = {};
const SECURE = new Set(["secure_field"]);

async function start(): Promise<Runner> {
  const res = await fetch("/api/session", { method: "POST" });
  if (!res.ok) throw new Error("Couldn't start a session");
  const { client_secret } = await res.json();
  const mynt = createMyntBrowserClient({ clientSecret: client_secret, baseUrl: "/v1" });
  return createJourneyRunner(mynt, JOURNEY_ID);
}

export function App() {
  const [runner, setRunner] = useState<Runner | null>(null);
  const [, rerender] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    start().then(setRunner, (e) => setError(e.message));
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!runner) return <p>Loading…</p>;
  const step = runner.current;
  if (!step || runner.done) return <p>All done.</p>;

  const submit = async (form: FormData) => {
    const fields = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    const documents = Object.fromEntries((step.screen ?? []).flatMap((e) => (e.type === "disclosure" ? [[e.document, DOCUMENT_TEXT[e.document] ?? ""]] : [])));
    const consentText = step.capture_consent ? (document.getElementById("consent-text")?.textContent ?? "") : undefined;
    const { redirect_url } = await runner.complete({ fields, documents, consentText });
    if (redirect_url) location.assign(redirect_url); // the provider's hosted flow; it returns here with ?outcome=
    else rerender((n) => n + 1);
  };

  return (
    <main>
      {step.title && <h1>{step.title}</h1>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(new FormData(e.currentTarget)).catch((err: Error) => setError(err.message));
        }}
      >
        {(step.screen ?? []).map((e, i) => {
          if (e.type === "text") return <p key={i}>{e.text}</p>;
          if (e.type === "disclosure") return <section key={i} style={{ whiteSpace: "pre-wrap" }}>{DOCUMENT_TEXT[e.document]}</section>;
          if (e.type === "field")
            return (
              <label key={i}>
                {e.field}
                <input name={e.field} required={e.required} autoComplete="off" type={SECURE.has(e.capture) ? "password" : "text"} />
              </label>
            );
          return null;
        })}
        {step.capture_consent && <p id="consent-text">I agree to {step.capture_consent.replace(/_/g, " ")}.</p>}
        <button type="submit">{step.action ? "Continue to provider" : step.capture_consent ? "I agree" : "Continue"}</button>
      </form>
    </main>
  );
}
