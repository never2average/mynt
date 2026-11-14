import type { Stage } from "./workspaces";

// A project is one of the user's Mynt apps (list_my_apps). Its "conversations" are the app's
// coding-agent builds (list_builds), newest first: each build is one conversation with Mynt's
// coding agent. Nothing here is stored by the studio; it's read from Mynt on each load.

export type ProjectConversationSummary = {
  id: string; // the build id
  title: string; // the build's goal
  status: string; // the build's status (coding, verifying, succeeded, failed...)
  phaseMessage: string | null;
  /**
   * Where this build can be seen: its live preview while the agent codes, else the preview Mynt
   * made when verifying it. Null when it has neither. A capability URL: it's sent only to the
   * owner's browser and never logged.
   */
  previewUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectItem = {
  id: string; // the Mynt app id
  name: string;
  description: string;
  status: string; // the app's status (draft, published)
  /** Where the app stands, for the sidebar's folders: Mynt's own, else from status and last build. */
  stage: Stage;
  /** Who created it (Mynt's owner_id), when Mynt says. */
  ownerId?: string | null;
  /** The newest build's preview that exists, if any. */
  previewUrl: string | null;
  conversations: ProjectConversationSummary[];
};
