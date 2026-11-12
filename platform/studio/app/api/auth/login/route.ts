import { loginRoute } from "@mynt/auth";
import * as config from "@/lib/config";
import * as sessions from "@/lib/session";
import { sessionStore } from "@/lib/session-store";

export const dynamic = "force-dynamic";

export const GET = loginRoute({ config, sessions, sessionStore: () => sessionStore() });
