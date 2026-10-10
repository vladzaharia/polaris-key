import * as React from "react";
import { ChevronDown, KeyRound, LogOut, Palette, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/DropdownMenu.js";
import { cn } from "../../lib/cn.js";
import type { PortalAccount } from "../api.js";
import { href } from "../router.js";
import { Avatar } from "./Avatar.js";
import { t } from "../../lib/copy.js";

/**
 * The account menu (PORTAL.md §3.2): the avatar chip ("Account: <name or email>"), then Account,
 * Sign-in methods, Appearance and Sign out. The chip and the menu's header show the profile
 * picture (PX-22, §4.30 rule 5) from the signed-in session, else the initials. Approve a new device waits for G29 and Help for a
 * public help URL; both are left out rather than shown as dead ends.
 *
 * The chip (§8): from 1180 px it adds the full name and a chevron, the name truncating in the room
 * the ⌘K field gives up (never its first word alone: "Dr.", a compound prefix, a family name first);
 * with no name, and below 1180 px, it is the avatar alone. The menu's header keeps the full name
 * and the email. 40 px tall like the header's other controls, 44 px on a coarse pointer.
 *
 * Sign out is a form POST (R1-03): a state change is never a link.
 */
export function AccountMenu({
  account,
}: {
  account: PortalAccount;
}): React.ReactElement {
  const formRef = React.useRef<HTMLFormElement>(null);
  // The person's name when we have one (profile import, a provider), else their email.
  const name = account.name?.trim();
  const named = Boolean(name) && name !== account.email;
  const label = named ? name! : account.email || name || "Account";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Account: ${label}`}
            // The avatar alone on phones and tablets, and with no name (PORTAL.md §8); from 1180
            // px the full name and the chevron, the name truncating (min-w-0) only once the ⌘K
            // trigger has given way (PortalShell).
            className={cn(
              "inline-flex h-10 w-10 min-w-0 max-w-[18rem] shrink-0 items-center justify-center gap-2 rounded-full border border-border bg-surface-raised p-1 text-sm text-fg-strong hover:bg-hover pointer-coarse:h-11",
              named
                ? "max-wide:pointer-coarse:w-11 wide:w-auto wide:shrink wide:justify-start wide:pr-3"
                : "pointer-coarse:w-11",
            )}
          >
            <Avatar
              name={account.name}
              email={account.email}
              picture={account.avatarUrl}
            />
            {named ? (
              <>
                <span
                  dir="auto"
                  className="hidden min-w-0 truncate wide:inline"
                >
                  {name}
                </span>
                <ChevronDown
                  aria-hidden
                  className="hidden size-4 shrink-0 text-fg-muted wide:inline"
                />
              </>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-64">
          <DropdownMenuLabel>
            <div className="flex items-center gap-3">
              <Avatar
                name={account.name}
                email={account.email}
                picture={account.avatarUrl}
                size={40}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                {account.name && account.name !== account.email ? (
                  <span
                    dir="auto"
                    className="truncate text-sm font-medium text-fg-strong"
                  >
                    {account.name}
                  </span>
                ) : null}
                <span className="truncate text-xs font-normal text-fg-muted">
                  {account.email}
                </span>
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <a href={href.account()}>
              <User aria-hidden />
              Account
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={href.account("methods")}>
              <KeyRound aria-hidden />
              Sign-in methods
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={href.account("appearance")}>
              <Palette aria-hidden />
              Appearance
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => formRef.current?.requestSubmit()}>
            <LogOut aria-hidden />
            {t("common.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <form ref={formRef} method="post" action="/logout" hidden />
    </>
  );
}
