import { callFirmTool } from "@/lib/studio-server";
import { json } from "@/lib/studio-route";
import { fromNotices } from "@/lib/firm-area";
import { asLicenceProvider, hasFirmTools, UNSUPPORTED } from "@/lib/firm-server";

export const dynamic = "force-dynamic";

// GET: My firm → Notices (list_firm_notices): what changed at the firm that its people should know, newest first.
// Reading them marks them read on Mynt, so they're read only when the tab is opened.
export async function GET() {
  return asLicenceProvider("loading my firm's notices", async (mynt, session) => {
    if (!(await hasFirmTools(mynt, "list_firm_notices"))) return json(UNSUPPORTED);
    const notices = fromNotices(await callFirmTool(mynt, session, "list_firm_notices", { limit: 200 }));
    return notices ? json({ notices }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
