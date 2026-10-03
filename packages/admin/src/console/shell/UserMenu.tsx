import * as React from "react";
import { BookOpen, Keyboard, LogOut } from "lucide-react";
import type { Me } from "../../api.js";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/index.js";
import { Kbd } from "./bits.js";

/** "18:40" in the viewer's locale and clock (ADMIN.md §5.9). */
export function formatSessionEnd(epochSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

/**
 * The account menu (ADMIN.md §2.2, fixes SH-14): who is signed in, when the session ends (A-1;
 * the session is a hard 8 h, so the time is worth knowing before a long edit), the shortcut sheet,
 * the docs home and Sign out. The theme lives in its own menu beside this one.
 */
export function UserMenu({
  me,
  onShortcuts,
  onSignOut,
}: {
  me: Me;
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
