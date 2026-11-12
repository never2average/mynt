import { logoutRoute } from "@mynt/auth";
import * as config from "@/lib/config";
import * as sessions from "@/lib/session";
import { sessionStore } from "@/lib/session-store";

export const dynamic = "force-dynamic";

export const POST = logoutRoute({ config, sessions, sessionStore: () => sessionStore() });
