import { ImageResponse } from "next/og";
import { BRAND, SITE_NAME, TAGLINE } from "@/lib/brand";

// The share image (1200×630): the logo, the studio's name and its one line, on forest green.
// Drawn with the image renderer's own font, so it makes no font request.
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
          justifyContent: "space-between",
          padding: 88,
          background: BRAND.forest,
          color: BRAND.white,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div style={{ width: 72, height: 72, borderRadius: 9999, background: BRAND.mint }} />
          <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -2 }}>mynt</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 88, fontWeight: 700, letterSpacing: -2 }}>{SITE_NAME}</div>
          <div style={{ fontSize: 40, color: BRAND.mint }}>{TAGLINE}</div>
        </div>
        <div style={{ display: "flex", height: 8, width: 160, borderRadius: 9999, background: BRAND.outline }} />
      </div>
    ),
    size,
  );
}
