import { redirect } from "next/navigation";

// /services has no list of its own: services are in the sidebar's stage folders and on My services. Build's Service
// type is where one starts.
export default function ServicesPage() {
  redirect("/new?type=service");
}
