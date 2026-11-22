// The studio's few brand values, for the icons, the share image, the manifest and the page
// metadata. The UI is shadcn's neutral palette (app/globals.css); the app icon's mint is its only
// accent.

export const BRAND = {
  mint: "#3DDC97", // the app icon's circle, and the UI's accent
  deepMint: "#13805A", // the accent where mint is too light to see (focus rings on white)
  dark: "#09090B", // the dark theme's background, behind the app icon
  light: "#FFFFFF", // the light theme's background
  mutedOnDark: "#A1A1AA", // muted text on the dark background
} as const;

export const SITE_NAME = "Mynt Studio";
export const SHORT_NAME = "Mynt";
export const SITE_DESCRIPTION = "Build compliant finance apps with Mynt's coding agent";
export const TAGLINE = "Build compliant finance apps with an AI agent";
// Browser tab titles say "Mynt", not "Mynt Studio": "<page> · Mynt".
export const TITLE_TEMPLATE = `%s · ${SHORT_NAME}`;
