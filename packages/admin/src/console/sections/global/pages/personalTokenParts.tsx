/**
 * What the two Personal tokens tabs share (ST-34.11): the scope tag, the token cell, the phone
 * card, the revoke copy and the link to Account → Packages in Polaris Locker.
 */

import * as React from "react";
import { Package, Terminal } from "lucide-react";
import { fromSeconds } from "../../../../lib/format.js";
import { cn } from "../../../../lib/cn.js";
import type { DataColumn } from "../../../../ui/data-table/index.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { useCachedMe } from "../../../access/useCan.js";

/** The fields both lists carry. */
export interface TokenLike {
  label: string;
  hint: string;
  scope: string;
  status: "active" | "expired" | "revoked";
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export const STATUS_PILL: Record<
  TokenLike["status"],
  { tone: "success" | "warning" | "neutral"; label: string }
> = {
  active: { tone: "success", label: "Active" },
  expired: { tone: "warning", label: "Expired" },
  revoked: { tone: "neutral", label: "Revoked" },
};

const SCOPE_TAG: Record<string, string> = {
  admin: "Admin",
  "packages:read": "Packages",
};

export const scopeName = (scope: string): string => SCOPE_TAG[scope] ?? scope;

/** The host a `pkey login` token was made on, from its label "pkey on <host>"; else null. */
export function hostOfLabel(label: string): string | null {
  const m = /^pkey on (.+)$/.exec(label.trim());
  return m ? m[1]!.trim() || null : null;
}

/** Scope as a plain neutral tag with a glyph: it is a kind of token, not a status. */
export function ScopeTag({ scope }: { scope: string }): React.ReactElement {
  const Icon = scope === "admin" ? Terminal : Package;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-xs text-fg">
      <Icon aria-hidden className="size-3" />
      {scopeName(scope)}
    </span>
  );
}

/**
 * The token cell: the host as the title for a `pkey login` token (with "pkey login ·" in front of
 * the last four), else the label. It wraps anywhere on a phone and leaves room for the card's
 * Actions button.
 */
export function TokenCell({ t }: { t: TokenLike }): React.ReactElement {
  const host = t.scope === "admin" ? hostOfLabel(t.label) : null;
  return (
    <span className="inline-flex min-w-0 max-w-[15rem] flex-col max-sm:max-w-full">
      <span
        dir="auto"
        className="truncate max-sm:whitespace-normal [overflow-wrap:anywhere]"
        title={t.label}
      >
        {host ?? t.label}
      </span>
      <span className="font-mono text-xs text-fg-muted">
        {host ? "pkey login · " : ""}pkeyp_…{t.hint}
      </span>
    </span>
  );
}

/** "Last used 2 hr. ago · Expires in 4 days": the card's second line. */
export function MetaLine({ t }: { t: TokenLike }): React.ReactElement {
  return (
    <p className="text-xs text-fg-muted">
      {t.lastUsedAt === null ? (
        "Never used"
      ) : (
        <>
          Last used <Timestamp at={fromSeconds(t.lastUsedAt)} />
        </>
      )}
      {" · "}
      {t.status === "revoked" && t.revokedAt !== null ? (
        <>
          Revoked <Timestamp at={fromSeconds(t.revokedAt)} />
        </>
      ) : (
        <>
          {t.status === "expired" ? "Expired " : "Expires "}
          <Timestamp at={fromSeconds(t.expiresAt)} />
        </>
      )}
    </p>
  );
}

/** A phone card: title, [scope] [status], then the meta line. The Actions button has its corner. */
export function TokenCard({
  t,
  primary,
  extra,
}: {
  t: TokenLike;
  primary: React.ReactNode;
  extra?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <div className="@max-[18rem]:pe-9">{primary}</div>
      {extra}
      <div className="flex flex-wrap items-center gap-2">
        <ScopeTag scope={t.scope} />
        <StatusPill tone={STATUS_PILL[t.status].tone}>
          {STATUS_PILL[t.status].label}
        </StatusPill>
      </div>
      <MetaLine t={t} />
    </div>
  );
}

/** "Account → Packages", linked to Polaris Locker as "My library" is. */
export function AccountPackagesLink({
  children = "Account → Packages",
}: {
  children?: React.ReactNode;
}): React.ReactElement {
  const origin = useCachedMe()?.customerOrigin ?? "";
  return (
    <a
      className="underline underline-offset-2 hover:text-fg-strong"
      href={`${origin}/#/account/packages`}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

export type RevokeAction = "ownToken.revokeAdmin" | "ownToken.revokePackages";

/**
 * What the confirm says stops. `owner` is the person's email on the Everyone tab, where it is
 * someone else's token.
 *
 * Revoking your own packages token is L1, a deliberate exception to ADMIN §5.2 (irreversible is
 * L2): it is your own credential, a new one takes seconds, and only your installs stop.
 */
export function revokeCopy(
  t: Pick<TokenLike, "scope" | "label">,
  owner?: string | null,
): {
  action: RevokeAction;
  title: string;
  consequences: string[];
  packagesNote: boolean;
} {
  const forOwner = owner ? `, for ${owner}` : "";
  if (t.scope === "admin") {
    const host = hostOfLabel(t.label);
    return {
      action: "ownToken.revokeAdmin",
      title: host ? `Revoke pkey on ${host}?` : "Revoke this admin token?",
      consequences: [
        host
          ? `pkey on that computer stops working at once${forOwner}.`
          : `This admin token stops working at once${forOwner}.`,
        owner
          ? "They run pkey login there to sign in again."
          : "Run pkey login there to sign in again.",
      ],
      packagesNote: false,
    };
  }
  return {
    action: "ownToken.revokePackages",
    title: `Revoke ${t.label}?`,
    consequences: [
      `Installs using “${t.label}” stop within 30 seconds${forOwner}.`,
    ],
    packagesNote: true,
  };
}

/** Under the packages consequences: where a new token is made. */
export function PackagesNote({
  owner,
}: {
  owner?: string | null;
}): React.ReactElement {
  return (
    <p className={cn("text-sm text-fg-muted")}>
      {owner ? "Its owner makes" : "Make"} a new one in <AccountPackagesLink />.
    </p>
  );
}

/** The Last used column both tabs share. */
export function lastUsedColumn<T extends TokenLike>(): DataColumn<T> {
  return {
    id: "lastUsedAt",
    header: "Last used",
    accessorFn: (t) => t.lastUsedAt ?? 0,
    meta: { numeric: true, priority: 1, label: "Last used" },
    cell: ({ row }) =>
      row.original.lastUsedAt === null ? (
        <span className="text-fg-muted">Never</span>
      ) : (
        <Timestamp at={fromSeconds(row.original.lastUsedAt)} />
      ),
  };
}

/** The Expires column both tabs share; a revoked token says when it ended instead. */
export function expiresColumn<T extends TokenLike>(): DataColumn<T> {
  return {
    id: "expiresAt",
    header: "Expires",
    accessorKey: "expiresAt",
    meta: { numeric: true, priority: 1, label: "Expires" },
    cell: ({ row }) =>
      row.original.status === "revoked" && row.original.revokedAt !== null ? (
        <span>
          Revoked <Timestamp at={fromSeconds(row.original.revokedAt)} />
        </span>
      ) : (
        <Timestamp at={fromSeconds(row.original.expiresAt)} />
      ),
  };
}

/**
 * After a revoke the dialog closes onto nothing: the next row's (or card's) Actions button takes
 * focus, else the heading.
 */
export function focusActionsAfter(
  rows: readonly { id: string }[],
  id: string,
): void {
  const at = rows.findIndex((t) => t.id === id);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const buttons = document.querySelectorAll<HTMLElement>(
        '.pk-vt-table button[aria-label^="Actions for"]',
      );
      (
        buttons[Math.min(Math.max(at, 0), buttons.length - 1)] ??
        document.querySelector<HTMLElement>("h1")
      )?.focus();
    }),
  );
}
