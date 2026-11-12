import { callbackRoute } from "@mynt/auth";
import * as config from "@/lib/config";
import * as sessions from "@/lib/session";
import { sessionStore } from "@/lib/session-store";

export const dynamic = "force-dynamic";

export const GET = callbackRoute({ config, sessions, sessionStore: () => sessionStore() });
