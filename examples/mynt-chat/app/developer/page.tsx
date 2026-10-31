import type { Metadata } from "next";
import { DeveloperConsole } from "@/components/developer/DeveloperConsole";

export const metadata: Metadata = {
  title: "Mynt developer console",
  description: "Your coding-agent builds and your hosting on Mynt.",
  robots: { index: false },
};

export default function DeveloperPage() {
  return <DeveloperConsole />;
}
