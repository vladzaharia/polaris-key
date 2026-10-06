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
import type { PortalAccount } from "../api.js";
import { href } from "../router.js";
import { Avatar } from "./Avatar.js";

/**
 * The account menu (PORTAL.md §3.2): the avatar chip ("Account: <email>"), then Account,
 * Sign-in methods, Appearance and Sign out. The chip and the menu's header show the profile
 * picture (PX-22, §4.30 rule 5) from the signed-in session, else the initials. Approve a new device waits for G29 and Help for a
 * public help URL; both are left out rather than shown as dead ends.
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
  const label =
    name && name !== account.email ? name : account.email || name || "Account";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Account: ${label}`}
            className="inline-flex h-11 max-w-[18rem] items-center gap-2 rounded-full border border-border bg-surface-raised p-1 text-sm text-fg-strong hover:bg-hover desk:pr-3"
          >
            <Avatar
              name={account.name}
              email={account.email}
              picture={account.avatarUrl}
            />
            <span className="hidden truncate desk:inline">{label}</span>
            <ChevronDown
              aria-hidden
              className="hidden size-4 shrink-0 text-fg-muted desk:inline"
            />
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
                  <span className="truncate text-sm font-bold text-fg-strong">
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
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <form ref={formRef} method="post" action="/logout" hidden />
    </>
  );
}
