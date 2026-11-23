import { testModeFromEnv, type ESign } from "./provider.js";

// The e-signature adapters this server has, by the name ESIGN_PROVIDER gives (the one file that names them besides
// the adapters themselves). Unset, or a name with no adapter, leaves e-signature off and the manual flow in place.
export async function esignFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<ESign | null> {
  const which = (env.ESIGN_PROVIDER ?? "").trim().toLowerCase();
  if (!which) return null;
  if (which === "signwell") {
    const { signwellFromEnv } = await import("./signwell.js");
    const provider = signwellFromEnv(env);
    if (!provider) console.error("ESIGN_PROVIDER=signwell needs SIGNWELL_API_KEY; e-signature stays off");
    return provider ? { provider, testMode: testModeFromEnv(env) } : null;
  }
  console.error(`ESIGN_PROVIDER: no e-signature adapter called "${which}"; e-signature stays off`);
  return null;
}
