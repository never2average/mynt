import type { Metadata } from "next";
import { AgreementsPage } from "./agreements-page";

export const metadata: Metadata = { title: "Agreements" };

// Agreements (/agreements): a licence provider's program agreements with apps and its firm's agreement templates.
export default function Page() {
  return <AgreementsPage />;
}
