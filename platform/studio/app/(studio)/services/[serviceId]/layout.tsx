import { ServiceFrame } from "./service-frame";

// A service built on Mynt: its own workspace (/services/<id>), beside apps' (/<id>) and financial products'
// (/products/<id>). The builder chat is the page; the frame holds the header and the tabs.
export default function ServiceLayout({ children }: { children: React.ReactNode }) {
  return <ServiceFrame>{children}</ServiceFrame>;
}
