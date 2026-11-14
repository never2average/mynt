// Mynt's logo: a solid mint circle (the mark) followed by the lowercase wordmark "mynt" in
// Space Grotesk. Inline SVG, so it needs no request and stays sharp at any size.
//
// variant: "dark" for dark surfaces (white wordmark), "light" for light ones (dark green
// wordmark), "auto" to take the surrounding text colour, "mark" for the circle alone.
import { BRAND } from "@/lib/brand"
import { cn } from "@/lib/utils"

export type MyntLogoVariant = "auto" | "dark" | "light" | "mark"

const WORDMARK_FILL: Record<Exclude<MyntLogoVariant, "mark">, string> = {
  auto: "currentColor",
  dark: BRAND.white,
  light: BRAND.forest,
}

export function MyntMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-mynt-mark
    >
      <circle cx="12" cy="12" r="12" fill={BRAND.mint} />
    </svg>
  )
}

export function MyntLogo({
  size = 24,
  variant = "auto",
  className,
  wordmarkClassName,
}: {
  /** Height in pixels. */
  size?: number
  variant?: MyntLogoVariant
  className?: string
  /** E.g. to hide the wordmark when the sidebar is collapsed to its icon rail. */
  wordmarkClassName?: string
}) {
  if (variant === "mark") return <MyntMark size={size} className={className} title="Mynt" />
  return (
    <span role="img" aria-label="Mynt" className={cn("inline-flex items-center", className)} style={{ gap: size * 0.3 }} data-mynt-logo={variant}>
      <MyntMark size={size} />
      <svg
        height={size}
        width={size * 2.4}
        viewBox="0 0 58 24"
        className={cn("shrink-0 overflow-visible", wordmarkClassName)}
        aria-hidden
        data-mynt-wordmark
      >
        <text
          x="0"
          y="18.5"
          fill={WORDMARK_FILL[variant]}
          fontSize="24"
          fontWeight="600"
          letterSpacing="-0.5"
          style={{ fontFamily: "var(--font-space-grotesk), ui-sans-serif, system-ui, sans-serif" }}
        >
          mynt
        </text>
      </svg>
    </span>
  )
}
