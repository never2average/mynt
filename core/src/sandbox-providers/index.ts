// Picks the agent sandbox provider from the environment. Provider names appear here and in their adapters only.
import { FreestyleProvider } from "../freestyle.js";
import type { SandboxHost } from "../sandbox-host.js";
import { BoatDevSandboxes } from "./boatdev.js";
import { FreestyleSandboxes } from "./freestyle.js";

// Agent sandboxes (builds, the product desk, governance review, the connector): boat.dev, or Freestyle VMs with
// SANDBOX_PROVIDER=freestyle (also the default when only a Freestyle key is configured).
export function sandboxesFromEnv(env = process.env): SandboxHost | null {
  const freestyle = env.FREESTYLE_API_KEY && (env.SANDBOX_PROVIDER === "freestyle" || (!env.SANDBOX_PROVIDER && !env.BOAT_API_KEY));
  if (freestyle) return new FreestyleSandboxes(new FreestyleProvider(env.FREESTYLE_API_KEY!), { usdPerHour: Number(env.FREESTYLE_USD_PER_HOUR ?? 0.2) });
  return env.BOAT_API_KEY && env.SANDBOX_PROVIDER !== "freestyle" ? new BoatDevSandboxes(env.BOAT_API_KEY) : null;
}
