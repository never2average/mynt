import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { NextResponse } from "next/server";
import type { Session } from "./session-store";
import { asDeveloper, json } from "./studio-route";
import { listMyntTools, sessionIsDeveloper } from "./studio-server";

// Who the agreement routes serve: a party to an app agreement (a developer, or a licence provider or vendor acting
// for its firm), or, for the templates, a licence provider. Mynt checks again which agreements and templates are theirs.
export const sessionIsLicenceProvider = (session: Session) => (session.roles ?? []).includes("license_provider");
export const sessionIsAgreementParty = (session: Session) => sessionIsDeveloper(session) || sessionIsLicenceProvider(session) || (session.roles ?? []).includes("vendor");

export async function asAgreementParty(what: string, handle: (mynt: Client, session: Session) => Promise<NextResponse>, licenceProviderOnly = false) {
  return asDeveloper(what, handle, licenceProviderOnly ? sessionIsLicenceProvider : sessionIsAgreementParty);
}

// A Mynt without e-signature tools yet answers 501, so the page says it's coming rather than failing.
export async function hasTool(mynt: Client, name: string) {
  return (await listMyntTools(mynt)).some((t) => t.name === name);
}
export const NOT_YET = json({ error: "unsupported", message: "Signing agreements in the studio comes with Mynt's next update." }, 501);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
