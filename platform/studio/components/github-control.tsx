"use client"

// The header's GitHub control, beside the wallet control and New app, in the same style. A linked
// account shows its username; clicking it opens a menu with up to five connected repositories and
// their approval in words (Approved, Waiting for an admin, Rejected), View all (Settings →
// Repositories), Connect repository (the same dialog as Settings) and Manage linked accounts (the
// identity provider's account page, same tab). No account linked: Link GitHub, to that page.
// Given `linked` and `repos` it renders from them (the tests); otherwise it reads them itself.
import Link from "next/link"
import { useState } from "react"
import { ArrowRight, ChevronDown, ExternalLink, GitBranchPlus } from "lucide-react"

import { GithubMark } from "@/components/brand-icons"

import { ConnectRepository, RepoStatus, useRepositories, type ReposState } from "@/components/repositories"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { NOT_YET } from "@/components/wallet-control"
import type { LinkedAccounts } from "@/lib/linked-accounts"
import { useLinkedAccounts } from "@/lib/use-linked-accounts"

export const MENU_REPOS = 5

function RepoList({ repos }: { repos: ReposState }) {
  if (repos.kind === "loading") return <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading repositories…</p>
  if (repos.kind === "unsupported")
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground" data-repos="unsupported">
        Connected repositories aren&apos;t available yet
      </p>
    )
  if (repos.kind === "error") return <p className="px-2 py-1.5 text-xs text-destructive">{repos.message}</p>
  if (!repos.repos.length)
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground" data-repos="none">
        No repositories connected yet
      </p>
    )
  return (
    <ul className="flex flex-col gap-1 px-2 py-1" data-repos="list">
      {repos.repos.slice(0, MENU_REPOS).map((r) => (
        <li key={r.repository} className="flex items-center justify-between gap-3" data-repo={r.repository} data-approval={r.approval}>
          <span className="truncate font-mono text-xs">{r.repository}</span>
          <RepoStatus repo={r} />
        </li>
      ))}
    </ul>
  )
}

export function GithubControl({ linked, repos, onReposChanged }: { linked?: LinkedAccounts | null; repos?: ReposState; onReposChanged?: () => void }) {
  const loadedLinked = useLinkedAccounts()
  const loadedRepos = useRepositories()
  const accounts = linked === undefined ? loadedLinked : linked
  const list = repos ?? loadedRepos.state
  const reload = onReposChanged ?? loadedRepos.reload
  const [connecting, setConnecting] = useState(false)

  if (!accounts) return null // not known yet: nothing rather than a guess

  if (!accounts.github) {
    if (!accounts.manageUrl)
      return (
        <Button size="sm" variant="outline" disabled title={NOT_YET} data-github-control="none">
          <GithubMark />
          Link GitHub
        </Button>
      )
    return (
      <Button size="sm" variant="outline" asChild data-github-control="none">
        <a href={accounts.manageUrl} rel="noreferrer">
          <GithubMark />
          Link GitHub
        </a>
      </Button>
    )
  }

  const canConnect = list.kind === "ready" && list.connect
  const count = list.kind === "ready" ? list.repos.length : null
  return (
    <>
      {/* Not modal: the Connect repository dialog opens from it, and a modal menu would fight the
          dialog for focus as it closes. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" aria-label={`GitHub ${accounts.github}`} data-github-control="linked">
            <GithubMark />
            <span className="max-w-32 truncate">{accounts.github}</span>
            <ChevronDown className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80" data-github-menu>
          <DropdownMenuLabel className="flex items-center justify-between font-normal">
            <span className="text-xs text-muted-foreground">Connected repositories</span>
            <span className="text-xs font-medium">{accounts.github}</span>
          </DropdownMenuLabel>
          <RepoList repos={list} />
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild data-view-all>
            <Link href="/settings?tab=repositories">
              <ArrowRight />
              View all{count !== null && count > MENU_REPOS ? ` (${count})` : ""}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canConnect}
            title={canConnect ? undefined : "Connecting repositories comes with Mynt's next update"}
            onSelect={() => setConnecting(true)}
            data-menu-connect
          >
            <GitBranchPlus />
            Connect repository
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {accounts.manageUrl ? (
            <DropdownMenuItem asChild data-manage-github>
              <a href={accounts.manageUrl} rel="noreferrer">
                <ExternalLink />
                Manage linked accounts
              </a>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled title={NOT_YET} data-manage-github>
              <ExternalLink />
              Manage linked accounts
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConnectRepository enabled={canConnect} onConnected={reload} open={connecting} onOpenChange={setConnecting} trigger={false} />
    </>
  )
}
