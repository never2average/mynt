// The Settings page's tabs (/settings?tab=...), shared by its server page and its views. The
// workspace's own settings are its General tab (once called Settings: ?tab=settings still opens it).
export const WORKSPACE_TABS = ["members", "invitations", "apps", "repositories", "general"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
export const TAB_LABELS: Record<WorkspaceTab, string> = { members: "Members", invitations: "Invitations", apps: "Apps", repositories: "Repositories", general: "General" };
export const tabOf = (v: unknown): WorkspaceTab => (v === "settings" ? "general" : WORKSPACE_TABS.includes(v as WorkspaceTab) ? (v as WorkspaceTab) : "members");
