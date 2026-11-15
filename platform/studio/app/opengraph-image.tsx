import { ImageResponse } from "next/og";
import { BRAND, SITE_NAME, TAGLINE } from "@/lib/brand";

// The share image (1200×630): the app icon's mint circle, the studio's name and its one line, on
// the dark theme's near-black. Drawn with the image renderer's own font, so it makes no font
// request.
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = `${SITE_NAME}: ${TAGLINE}`;

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 28,
          padding: 96,
          background: BRAND.dark,
          color: "#FAFAFA",
        }}
      >
        <div style={{ width: 56, height: 56, borderRadius: 9999, background: BRAND.mint }} />
        <div style={{ fontSize: 88, fontWeight: 700, letterSpacing: -2 }}>{SITE_NAME}</div>
        <div style={{ fontSize: 40, color: BRAND.mutedOnDark }}>{TAGLINE}</div>
      </div>
    ),
    size,
  );
}
