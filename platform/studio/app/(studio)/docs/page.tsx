// /docs is now part of /connect (Connect your agent): old links land there.
import { redirect } from "next/navigation";

export default function DocsPage() {
  redirect("/connect");
}
