"use client";

import { createContext, useContext } from "react";
import type { ProjectItem } from "@/lib/project-types";

type ProjectsContextValue = {
  projects: ProjectItem[];
  isLoading: boolean;
  /** Why the projects couldn't be loaded (Mynt refused, or couldn't be reached). */
  error: string | null;
  onSelectProject: (projectId: string) => void;
};

const ProjectsContext = createContext<ProjectsContextValue>({
  projects: [],
  isLoading: true,
  error: null,
  onSelectProject: () => {},
});

export const ProjectsProvider = ProjectsContext.Provider;

export const useProjects = () => useContext(ProjectsContext);
