import * as React from "react";
import {
  BookOpen,
  CloudUpload,
  Fingerprint,
  Keyboard,
  KeyRound,
  Library,
  LogOut,
} from "lucide-react";
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
import { useMediaQuery } from "../../ui/data-table/DataTable.js";
import { Kbd } from "../../ui/Kbd.js";
import { AppearanceMenuItems } from "./ThemeMenu.js";
import { r } from "../routes.js";
import { Link } from "../router.js";

/** The version chip's text: "v0.8.6 · prod", the short commit, or "Development build". */
export function versionChipLabel(v: PlatformIdentity): string {
  const build = v.releaseTag ?? (v.gitSha ? v.gitSha.slice(0, 7) : null);
  if (!build) return "Development build";
  return v.environment ? `${build} · ${v.environment}` : build;
}

/**
 * Tailwind's `max-sm` (under 640 px): the top bar hides its theme menu there (`TopBar`), and this
 * menu carries the theme and motion choices instead.
 */
export const NARROW_BAR_QUERY = "(width < 40rem)";

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
 * §9.1), your Personal tokens, the shortcut sheet, the docs home and Sign out. The theme lives in its own menu beside
 * this one, except under 640 px, where the bar has no room for it and this menu carries the theme
 * and motion choices.
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
  const narrow = useMediaQuery(NARROW_BAR_QUERY);
  // Picking a page: its heading keeps the focus the route gave it, not the menu button Radix
  // would restore.
  const navigated = React.useRef(false);
  const initials = (me.name || me.email || "")
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
          <span className="flex size-7 items-center justify-center rounded-full border border-border bg-surface-sunken text-xs font-medium text-fg-strong">
            {initials || "PK"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-60"
        onCloseAutoFocus={(e) => {
          if (!navigated.current) return;
          navigated.current = false;
          e.preventDefault();
        }}
      >
        <DropdownMenuLabel>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-fg-strong">
              {me.name}
            </span>
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
            <Link to={r.platformStatus()} data-version-chip="">
              <CloudUpload aria-hidden />
              <span className="flex-1">Version</span>
              <span className="rounded-full border border-border bg-surface-sunken px-2 py-0.5 font-mono text-xs text-fg">
                {versionChipLabel(version)}
              </span>
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem asChild>
          <Link
            to={r.personalTokens()}
            onClick={() => {
              navigated.current = true;
              // Already on the page: no route change moves focus, so the heading takes it.
              if (window.location.hash.split("?")[0] === r.personalTokens())
                requestAnimationFrame(() =>
                  document.querySelector<HTMLElement>("h1")?.focus(),
                );
            }}
          >
            <KeyRound aria-hidden />
            Personal tokens
          </Link>
        </DropdownMenuItem>
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
        {/* The person's own Polaris Locker library, on the customer host when there is one.
            A break-glass session has no account behind it, so there is no library to open. */}
        {me.breakGlass ? null : (
          <DropdownMenuItem asChild>
            <a
              href={`${me.customerOrigin ?? ""}/`}
              target="_blank"
              rel="noreferrer"
            >
              <Library aria-hidden />
              My library
            </a>
          </DropdownMenuItem>
        )}
        {/* The account's own methods; a break-glass session has no account behind it. */}
        {me.breakGlass ? null : (
          <DropdownMenuItem asChild>
            <Link to={r.signInMethods()}>
              <Fingerprint aria-hidden />
              Sign-in methods
            </Link>
          </DropdownMenuItem>
        )}
        {narrow ? (
          <>
            <DropdownMenuSeparator />
            <AppearanceMenuItems />
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut}>
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
