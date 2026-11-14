import { redirect } from "next/navigation";

// Coverage is now the Licences page's map view (US).
export default function CoveragePage() {
  redirect("/licences?view=map&region=us");
}
