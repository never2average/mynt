// Runs on a client session from api/ (never an app key in the bundle). Same headless journey runner as the
// web app; hosted flows open in an in-app browser and return through the app's scheme.
import { useEffect, useState } from "react";
import { Button, ScrollView, Text, TextInput } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { createMyntBrowserClient, createJourneyRunner } from "mynt-sdk-react-native";

type Runner = Awaited<ReturnType<typeof createJourneyRunner>>;
const API = process.env.EXPO_PUBLIC_API_URL ?? "/api"; // your api service (no secrets in EXPO_PUBLIC_*)
const MYNT = process.env.EXPO_PUBLIC_MYNT_URL ?? "/v1";
const JOURNEY_ID = "default";
// The exact text of each document the product requires, as published by the provider. Show it verbatim.
const DOCUMENT_TEXT: Record<string, string> = {};

export default function Journey() {
  const [runner, setRunner] = useState<Runner | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({}); // in memory only, never persisted
  const [, rerender] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`${API}/session`, { method: "POST" });
      if (!res.ok) throw new Error("Couldn't start a session");
      const { client_secret } = await res.json();
      setRunner(await createJourneyRunner(createMyntBrowserClient({ clientSecret: client_secret, baseUrl: MYNT }), JOURNEY_ID));
    })().catch((e) => setError(e.message));
  }, []);

  if (error) return <Text accessibilityRole="alert">{error}</Text>;
  if (!runner) return <Text>Loading…</Text>;
  const step = runner.current;
  if (!step || runner.done) return <Text>All done.</Text>;
  const consentText = step.capture_consent ? `I agree to ${step.capture_consent.replace(/_/g, " ")}.` : undefined;

  const next = async () => {
    const documents = Object.fromEntries((step.screen ?? []).flatMap((e) => (e.type === "disclosure" ? [[e.document, DOCUMENT_TEXT[e.document] ?? ""]] : [])));
    const { redirect_url } = await runner.complete({ fields, documents, consentText });
    if (redirect_url) {
      const r = await WebBrowser.openAuthSessionAsync(redirect_url, "myntapp://journey");
      const outcome = r.type === "success" ? (new URL(r.url).searchParams.get("outcome") ?? "completed") : "failed";
      await runner.complete({ outcome });
    }
    setFields({});
    rerender((n) => n + 1);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      {step.title ? <Text accessibilityRole="header">{step.title}</Text> : null}
      {(step.screen ?? []).map((e, i) => {
        if (e.type === "text") return <Text key={i}>{e.text}</Text>;
        if (e.type === "disclosure") return <Text key={i}>{DOCUMENT_TEXT[e.document]}</Text>;
        if (e.type === "field")
          return (
            <TextInput
              key={i}
              accessibilityLabel={e.field}
              placeholder={e.field}
              secureTextEntry={e.capture === "secure_field"}
              autoComplete="off"
              value={fields[e.field] ?? ""}
              onChangeText={(v) => setFields((f) => ({ ...f, [e.field]: v }))}
            />
          );
        return null;
      })}
      {consentText ? <Text>{consentText}</Text> : null}
      <Button title={step.action ? "Continue to provider" : consentText ? "I agree" : "Continue"} onPress={() => void next().catch((e) => setError(e.message))} />
    </ScrollView>
  );
}
