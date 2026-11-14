import { redirect } from "next/navigation";

// Members moved to the Settings page's Members tab.
export default function MembersPage() {
  redirect("/settings?tab=members");
}
