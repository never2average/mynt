// The Workspace page's tabs (/workspace?tab=...), shared by its server page and its views.
export const WORKSPACE_TABS = ["members", "invitations", "apps", "repositories", "settings"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
export const TAB_LABELS: Record<WorkspaceTab, string> = { members: "Members", invitations: "Invitations", apps: "Apps", repositories: "Repositories", settings: "Settings" };
export const tabOf = (v: unknown): WorkspaceTab => (WORKSPACE_TABS.includes(v as WorkspaceTab) ? (v as WorkspaceTab) : "members");
