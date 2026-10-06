import * as React from "react";
import { BookOpen, CloudUpload, Keyboard, LogOut } from "lucide-react";
import type { Me, PlatformIdentity } from "../../api.js";
import { Button } from "../../ui/Button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/DropdownMenu.js";
import { Kbd } from "./bits.js";
import { r } from "../routes.js";
import { Link } from "../router.js";

/** The version chip's text: "v0.8.6 · prod", the short commit, or "Development build". */
export function versionChipLabel(v: PlatformIdentity): string {
  const build = v.releaseTag ?? (v.gitSha ? v.gitSha.slice(0, 7) : null);
  if (!build) return "Development build";
  return v.environment ? `${build} · ${v.environment}` : build;
}

/** "18:40" in the viewer's locale and clock (ADMIN.md §5.9). */
export function formatSessionEnd(epochSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

/**
 * The account menu (ADMIN.md §2.2, fixes SH-14): who is signed in, when the session ends (A-1;
 * the session is a hard 8 h, so the time is worth knowing before a long edit), the running build
 * (a chip linking to Platform → Deployment, so the version is one click from every page; notes/S-13
 * §9.1), the shortcut sheet, the docs home and Sign out. The theme lives in its own menu beside
 * this one.
 */
export function UserMenu({
  me,
  version,
  onShortcuts,
  onSignOut,
}: {
  me: Me;
  version?: PlatformIdentity | null;
  onShortcuts: () => void;
  onSignOut: () => void;
}): React.ReactElement {
  const initials = me.name
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu">
          <span className="flex size-7 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-on">
            {initials || "PK"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        <DropdownMenuLabel>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-bold text-fg-strong">{me.name}</span>
            <span className="truncate text-xs font-normal text-fg-muted">
              {me.email}
            </span>
            {me.sessionExpiresAt ? (
              <span className="text-xs font-normal text-fg-muted">
                Session ends {formatSessionEnd(me.sessionExpiresAt)}
              </span>
            ) : null}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {version ? (
          <DropdownMenuItem asChild>
            <Link to={r.platformDeployment()} data-version-chip="">
              <CloudUpload aria-hidden />
              <span className="flex-1">Version</span>
              <span className="rounded-full border border-border bg-surface-sunken px-2 py-0.5 font-mono text-xs text-fg">
                {versionChipLabel(version)}
              </span>
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onShortcuts}>
          <Keyboard aria-hidden />
          Keyboard shortcuts
          <Kbd keys="?" />
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="/docs/" target="_blank" rel="noreferrer">
            <BookOpen aria-hidden />
            Docs home
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut}>
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
