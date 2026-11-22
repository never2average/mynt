// The sections of the Connect your agent guide (components/connect-guide.tsx), for its "On this page" on /connect
// and /docs/connect. A plain module, so the docs' server pages can read it too.
export const CONNECT_SECTIONS = [
  { id: "connect", label: "Connect an agent" },
  { id: "address", label: "Server address" },
  { id: "sign-in", label: "Signing in" },
  { id: "access", label: "What your agent can do" },
  { id: "try", label: "Things to try" },
  { id: "trouble", label: "Troubleshooting" },
] as const;
