import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/brand";

// The home-screen icon (180×180 PNG), drawn by Next rather than committed as a binary: the mint
// mark centred on the forest green.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: BRAND.forest }}>
        <div style={{ width: 112, height: 112, borderRadius: 9999, background: BRAND.mint }} />
      </div>
    ),
    size,
  );
}
