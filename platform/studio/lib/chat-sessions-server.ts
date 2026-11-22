import type { NextResponse } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { sessionCanUseLiquidity } from "./liquidity-server";
import type { Session } from "./session-store";
import { sessionIsDeveloper } from "./studio-server";
import { asDeveloper } from "./studio-route";

// The chat routes (app/api/threads) serve everyone with a chat in the studio: developers (the Build
// page's product chats) and Earn's builders and liquidity providers. Mynt keeps each user's chats to
// that user whatever their role.
export const canKeepChats = (session: Session) => sessionIsDeveloper(session) || sessionCanUseLiquidity(session);

export const asChatUser = (what: string, handle: (mynt: Client, session: Session) => Promise<NextResponse>) => asDeveloper(what, handle, canKeepChats);
