import type { MetadataRoute } from "next";
import { BRAND, SHORT_NAME, SITE_DESCRIPTION, SITE_NAME } from "@/lib/brand";

// The web app manifest (/manifest.webmanifest), for installing the studio and for its icons.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SHORT_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    theme_color: BRAND.forest,
    background_color: BRAND.forest,
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
