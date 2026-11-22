// The visual harness's next/link: a plain anchor.
import { forwardRef } from "react";

type Props = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string | { pathname?: string }; prefetch?: boolean; replace?: boolean; scroll?: boolean };
const Link = forwardRef<HTMLAnchorElement, Props>(function Link({ href, prefetch: _p, replace: _r, scroll: _s, ...rest }, ref) {
  return <a ref={ref} href={typeof href === "string" ? href : (href.pathname ?? "#")} {...rest} />;
});
export default Link;
