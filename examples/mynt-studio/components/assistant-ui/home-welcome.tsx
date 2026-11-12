"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useProjects } from "@/lib/projects-context";
import type { ProjectItem } from "@/lib/project-types";
import type { FC } from "react";

/** Green once a build succeeded, amber while one runs, grey otherwise. */
function statusDot(project: ProjectItem): string {
  const latest = project.conversations[0]?.status;
  if (project.conversations.some((build) => build.status === "succeeded"))
    return "bg-emerald-500";
  if (latest && !/^(succeeded|failed|blocked|stopped)$/.test(latest))
    return "bg-amber-500";
  return "bg-muted-foreground/30";
}

export const HomeWelcome: FC = () => {
  const { projects, isLoading, error, onSelectProject } = useProjects();
  const hasProjects = projects.length > 0;
  const showProjects = isLoading || hasProjects;

  return (
    <div className="aui-thread-welcome-root mx-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center">
      <div className="flex w-full flex-col gap-8 px-2">
        {/* Hero */}
        <div className="flex animate-in flex-col items-center gap-2 pt-8 text-center duration-500 fill-mode-both fade-in">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            What do you want to build?
          </h1>
          <p className="text-sm text-muted-foreground/60">
            Open one of your Mynt apps to see its latest build
          </p>
          {error && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {!isLoading && !error && !hasProjects && (
            <p className="mt-2 text-sm text-muted-foreground/60">
              You have no Mynt apps yet.
            </p>
          )}
        </div>

        {/* Project cards with previews */}
        <div
          className={cn(
            "flex w-full flex-col gap-3 transition-opacity duration-500",
            showProjects ? "opacity-100" : "opacity-0",
          )}
        >
          {isLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="overflow-hidden rounded-xl border border-border/50 bg-card/50"
                >
                  <Skeleton className="aspect-16/10 w-full" />
                  <div className="px-3 py-2.5">
                    <Skeleton className="mb-1.5 h-3.5 w-3/4 rounded" />
                    <Skeleton className="h-2.5 w-1/2 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : hasProjects ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {projects.map((project, index) => {
                  const previewUrl = project.previewUrl;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => onSelectProject(project.id)}
                      className="group animate-in overflow-hidden rounded-xl border border-border/50 bg-card/50 text-left transition-all duration-200 fill-mode-both fade-in hover:border-border hover:ring-1 hover:ring-ring/20"
                      style={
                        {
                          "--tw-animation-delay": `${index * 75}ms`,
                          "--tw-animation-duration": "400ms",
                        } as React.CSSProperties
                      }
                    >
                      {/* Preview thumbnail */}
                      <div className="relative aspect-16/10 w-full overflow-hidden bg-muted/30">
                        {previewUrl ? (
                          <iframe
                            src={previewUrl}
                            title={`${project.name} preview`}
                            className="pointer-events-none absolute inset-0 h-[200%] w-[200%] origin-top-left scale-50 border-0"
                            tabIndex={-1}
                            loading="lazy"
                            sandbox="allow-scripts allow-same-origin"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center">
                            <span className="text-xs text-muted-foreground/30">
                              No preview
                            </span>
                          </div>
                        )}
                        {/* Status dot */}
                        <div className="absolute top-2 right-2">
                          <div
                            className={cn(
                              "h-2 w-2 rounded-full ring-2 ring-card/80",
                              statusDot(project),
                            )}
                          />
                        </div>
                      </div>
                      {/* Info */}
                      <div className="px-3 py-2.5">
                        <p className="truncate text-sm font-medium text-foreground group-hover:text-foreground">
                          {project.name}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground/50">
                          {project.conversations.length} build
                          {project.conversations.length !== 1 ? "s" : ""}
                          {" · "}
                          {project.status}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};
