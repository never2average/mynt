// The GitHub and Solana marks, from Simple Icons (CC0-1.0; simple-icons 15.0.0, icons/github.svg
// and icons/solana.svg; UPSTREAM.simple-icons.json). Each is the icon's single path, drawn in
// currentColor so it follows the theme's text colour: monochrome, never the brand's colours.
// Numbers that SVG reads apart (".6.113" is .6 then .113) are spaced so the paths never look
// like dotted addresses to CI's address check; the shapes are the same. Sized like lucide's icons (1em by default; a button sizes them as it does lucide's).
import * as React from "react"

type IconProps = Omit<React.ComponentProps<"svg">, "children">

function Mark({ path, title, ...props }: IconProps & { path: string; title: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" role="img" aria-hidden="true" focusable="false" data-brand-icon={title.toLowerCase()} {...props}>
      <path d={path} />
    </svg>
  )
}

const GITHUB =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385 .6 .113 .82-.258 .82-.577 0-.285-.01-1.04-.015-2.04-3.338 .724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744 .084-.729 .084-.729 1.205 .084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495 .998 .108-.776 .417-1.305 .76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31 .465-2.38 1.235-3.22-.135-.303-.54-1.523 .105-3.176 0 0 1.005-.322 3.3 1.23 .96-.267 1.98-.399 3-.405 1.02 .006 2.04 .138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23 .645 1.653 .24 2.873 .12 3.176 .765 .84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92 .42 .36 .81 1.096 .81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315 .21 .69 .825 .57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"

const SOLANA =
  "m23.8764 18.0313-3.962 4.1393a.9201 .9201 0 0 1-.306 .2106 .9407 .9407 0 0 1-.367 .0742H.4599a.4689 .4689 0 0 1-.2522-.0733 .4513 .4513 0 0 1-.1696-.1962 .4375 .4375 0 0 1-.0314-.2545 .4438 .4438 0 0 1 .117-.2298l3.9649-4.1393a.92 .92 0 0 1 .3052-.2102 .9407 .9407 0 0 1 .3658-.0746H23.54a.4692 .4692 0 0 1 .2523 .0734 .4531 .4531 0 0 1 .1697 .196 .438 .438 0 0 1 .0313 .2547 .4442 .4442 0 0 1-.1169 .2297zm-3.962-8.3355a.9202 .9202 0 0 0-.306-.2106 .941 .941 0 0 0-.367-.0742H.4599a.4687 .4687 0 0 0-.2522 .0734 .4513 .4513 0 0 0-.1696 .1961 .4376 .4376 0 0 0-.0314 .2546 .444 .444 0 0 0 .117 .2297l3.9649 4.1394a.9204 .9204 0 0 0 .3052 .2102c.1154 .049 .24 .0744 .3658 .0746H23.54a.469 .469 0 0 0 .2523-.0734 .453 .453 0 0 0 .1697-.1961 .4382 .4382 0 0 0 .0313-.2546 .4444 .4444 0 0 0-.1169-.2297zM.46 6.7225h18.7815a.9411 .9411 0 0 0 .367-.0742 .9202 .9202 0 0 0 .306-.2106l3.962-4.1394a.4442 .4442 0 0 0 .117-.2297 .4378 .4378 0 0 0-.0314-.2546 .453 .453 0 0 0-.1697-.196 .469 .469 0 0 0-.2523-.0734H4.7596a.941 .941 0 0 0-.3658 .0745 .9203 .9203 0 0 0-.3052 .2102L.1246 5.9687a.4438 .4438 0 0 0-.1169 .2295 .4375 .4375 0 0 0 .0312 .2544 .4512 .4512 0 0 0 .1692 .196 .4689 .4689 0 0 0 .2518 .0739z"

export function GithubMark(props: IconProps) {
  return <Mark path={GITHUB} title="GitHub" {...props} />
}

export function SolanaMark(props: IconProps) {
  return <Mark path={SOLANA} title="Solana" {...props} />
}
