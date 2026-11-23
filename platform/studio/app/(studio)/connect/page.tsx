import { redirect } from "next/navigation";

// /connect is the docs' Connect your agent page now (/docs/connect): old links and bookmarks land there.
export default function ConnectPage(): never {
  redirect("/docs/connect");
}
