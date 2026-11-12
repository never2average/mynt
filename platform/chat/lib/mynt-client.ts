// Connecting to Mynt as the signed-in user (@mynt/auth), with this app's settings.
import { createConnectMynt } from "@mynt/auth";
import * as config from "./config";
import { oauthProviderFor } from "./session";
import type { Session } from "./session-store";

export { callMyntTool, NotAllowedError, NotSignedInError, type ToolOutcome } from "@mynt/auth";

export const connectMynt = createConnectMynt<Session>({ config, oauthProviderFor: (session) => oauthProviderFor(session) });
