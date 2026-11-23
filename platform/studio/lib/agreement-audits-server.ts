import { readCapped, TOO_LARGE } from "./ai-route";
import type { Session } from "./session-store";
import { isDeveloper } from "./studio-tools";

// What the Agreement audits routes share. They serve developers (the app's side) and licence
// providers (the counterparty's side): an account can be either or both, and Mynt decides what each
// may read and do on each audit. Bodies are small JSON (evidence is links and hashes, never files).

export const MAX_BODY = 64 * 1024;
export const AUDIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isLicenceProvider = (roles: readonly string[]) => roles.includes("license_provider");
/** Who the routes serve: developers and licence providers. */
export const sessionCanUseAgreementAudits = (session: Session) => isDeveloper(session.roles ?? []) || isLicenceProvider(session.roles ?? []);

/** The request's JSON body, read no further than MAX_BODY: null when it isn't JSON, TOO_LARGE when it's over. */
export async function readJson(req: Request): Promise<unknown | typeof TOO_LARGE> {
  const text = await readCapped(req, MAX_BODY);
  if (text === TOO_LARGE) return TOO_LARGE;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
export { TOO_LARGE };
