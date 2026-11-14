// Mynt's visual identity, in one place for the logo, the icons, the share image, the manifest
// and the page metadata. The theme's CSS variables (app/globals.css) use the same colours.

export const BRAND = {
  forest: "#0F2A23", // deep forest green: dark backgrounds
  panel: "#153C31", // darker panels on the forest background
  outline: "#2E8C66", // outline ring
  mint: "#3DDC97", // the mark, and the accent
  deepGreen: "#13805A", // labels and links on light backgrounds
  light: "#F2F6F3", // light background
  ink: "#10241D", // body text on light
  muted: "#5E7169", // muted text on light
  white: "#FFFFFF",
} as const;

export const SITE_NAME = "Mynt Studio";
export const SHORT_NAME = "Mynt";
export const SITE_DESCRIPTION = "Build compliant finance apps with Mynt's coding agent";
export const TAGLINE = "Build compliant finance apps with an AI agent";
export const TITLE_TEMPLATE = `%s · ${SITE_NAME}`;
