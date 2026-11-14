import { redirect } from "next/navigation";

// Members moved to the Workspace page's Members tab.
export default function MembersPage() {
  redirect("/workspace?tab=members");
}
