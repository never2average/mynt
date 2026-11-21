// The Settings page's tabs (/settings?tab=...), shared by its server page and its views. The
// first is the default: an unknown tab, or one that's gone (General, once Settings: renaming and
// archiving are in the workspace switcher's menu), opens it.
export const WORKSPACE_TABS = ["members", "invitations", "apps", "repositories"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
export const DEFAULT_TAB: WorkspaceTab = WORKSPACE_TABS[0];
export const TAB_LABELS: Record<WorkspaceTab, string> = { members: "Members", invitations: "Invitations", apps: "Apps", repositories: "Repositories" };
export const tabOf = (v: unknown): WorkspaceTab => (WORKSPACE_TABS.includes(v as WorkspaceTab) ? (v as WorkspaceTab) : DEFAULT_TAB);
