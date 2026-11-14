import { redirect } from "next/navigation";

// Coverage is now the Licences page's Coverage tab.
export default function CoveragePage() {
  redirect("/licences?tab=coverage");
}
