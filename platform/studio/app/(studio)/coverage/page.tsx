import { redirect } from "next/navigation";

// Coverage was the Licences page's map view; licence coverage is now on each product's Compliance tab.
export default function CoveragePage() {
  redirect("/licences");
}
