import { z } from "zod";
import { fromConnectRepository, fromListRepositories, REPOSITORY } from "@/lib/repositories";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// The developer's own connected repositories (list_repositories), for the dashboard's workspace facts and the
// Workspace page's Repositories tab. They're the developer's, not the workspace's. `connect`
// says whether this Mynt offers connect_repository.
export async function GET() {
  return asDeveloper("loading repositories", async (mynt) => {
    const tools = await listMyntTools(mynt);
    if (!tools.some((t) => t.name === "list_repositories")) return json({ supported: false });
    const connect = tools.some((t) => t.name === "connect_repository");
    return json({ supported: true, connect, repositories: fromListRepositories(await callStudioTool(mynt, "list_repositories")) });
  });
}

const Connect = z.object({ repository: z.string().trim().max(200).regex(REPOSITORY, "Enter it as owner/name, like octo-org/savings-app.") }).strict();

// POST: connect one ({ repository: "owner/name" }). The answer says whether it's approved now or
// sent to an admin, and why.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const p = Connect.safeParse(await req.json().catch(() => null));
  if (!p.success) return json({ error: "bad_request", message: p.error.issues[0]?.message ?? "Enter it as owner/name." }, 400);
  return asDeveloper("connecting a repository", async (mynt) => {
    const tools = await listMyntTools(mynt);
    if (!tools.some((t) => t.name === "connect_repository")) return json({ error: "unsupported", message: "Connecting repositories comes with Mynt's next update." }, 501);
    const reply = await callStudioTool(mynt, "connect_repository", { repository: p.data.repository });
    return json({ result: fromConnectRepository(reply, p.data.repository) });
  });
}
