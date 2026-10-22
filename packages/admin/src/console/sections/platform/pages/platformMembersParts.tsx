/**
 * Platform → Members, the row parts (ST-31.11): the avatar, the "Access from" lines, the last
 * sign-in and the stacked row below ~1000 px.
 */

import * as React from "react";
import { Lock, Mail } from "lucide-react";
import type { Member, MemberInvite } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { RoleTags } from "../../../access/RoleTag.js";
import {
  initialsOf,
  productOfScope,
  visibleRoles,
  type MemberRow,
} from "./platformMembersModel.js";
import type { ProductName } from "./platformMembersRoleForm.js";

export function Avatar({
  name,
  email,
  pending,
}: {
  name: string;
  email: string;
  pending?: boolean;
}): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        pending
          ? "border border-dashed border-border-strong text-fg-muted"
          : "bg-surface-sunken text-fg-strong",
      )}
    >
      {pending ? <Mail className="size-4" /> : initialsOf(name, email)}
    </span>
  );
}

export interface AccessLine {
  key: string;
  /** The line as plain text, for its title when it is cut. */
  text: string;
  node: React.ReactNode;
}

/** One "Access from" line per distinct source of a member's roles. */
export function accessLines(
  m: Member,
  group: string | null,
  productName: ProductName,
): AccessLine[] {
  const seen = new Set<string>();
  const lines: AccessLine[] = [];
  for (const r of m.roles) {
    const by = r.grantedBy?.name ?? null;
    const key = `${r.source}:${by ?? ""}:${r.grantedAt ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.source === "root")
      lines.push({
        key,
        text: `Root rule${group ? ` ${group}` : ""}`,
        node: (
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-3.5 shrink-0" aria-hidden="true" />
            Root rule
            {group ? <code className="font-mono text-xs">{group}</code> : null}
          </span>
        ),
      });
    else if (r.source === "creator") {
      const slug = productOfScope(r.scope);
      const what = `Created ${slug ? productName(slug) : "a product"}`;
      lines.push({
        key,
        text: what,
        node: (
          <span>
            {what}
            {r.grantedAt ? <Dated at={r.grantedAt} /> : null}
          </span>
        ),
      });
    } else {
      const what = `${r.source === "invite" ? "Invite from " : "Added by "}${by ?? "a former member"}`;
      lines.push({
        key,
        text: what,
        node: (
          <span>
            {what}
            {r.grantedAt ? <Dated at={r.grantedAt} /> : null}
          </span>
        ),
      });
    }
  }
  return lines;
}

/** Access lines, one per source, each on one line (cut with its text in a title). */
export function AccessLines({
  lines,
}: {
  lines: AccessLine[];
}): React.ReactElement {
  return (
    <span className="flex max-w-[22rem] flex-col gap-0.5 text-sm">
      {lines.map((l) => (
        <span key={l.key} className="block truncate" title={l.text}>
          {l.node}
        </span>
      ))}
    </span>
  );
}

/** The same fact for a member and an invite: when they last signed in. */
export function LastSeen({ row }: { row: MemberRow }): React.ReactElement {
  if (row.kind === "invite")
    return (
      <span className="tabular-nums text-fg-muted">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not signed in yet</span>
      </span>
    );
  return row.member.lastSignInAt ? (
    <Timestamp at={fromSeconds(row.member.lastSignInAt)} />
  ) : (
    <span className="tabular-nums text-fg-muted">Never</span>
  );
}

export function Dated({ at }: { at: number }): React.ReactElement {
  return (
    <span className="ms-1.5 text-fg-muted">
      <Timestamp at={fromSeconds(at)} format="date" />
    </span>
  );
}

export function inviteLines(i: MemberInvite): AccessLine[] {
  const what = `Invited by ${i.invitedBy?.name ?? "a former member"}`;
  return [
    {
      key: "invite",
      text: what,
      node: (
        <span>
          {what}
          <Dated at={i.sentAt} />
        </span>
      ),
    },
    ...(i.expiresAt
      ? [
          {
            key: "expires",
            text: "Expires",
            node: (
              <span className="text-xs text-fg-muted">
                Expires{" "}
                <Timestamp at={fromSeconds(i.expiresAt)} format="relative" />
              </span>
            ),
          },
        ]
      : []),
  ];
}

/** Below ~1000 px a row stacks: name, email · last sign-in, role tags, access (mockup `phone`). */
export function StackedRow({
  row,
  group,
  productName,
}: {
  row: MemberRow;
  group: string | null;
  productName: ProductName;
}): React.ReactElement {
  const m = row.kind === "member" ? row.member : null;
  const email = m ? m.email : row.kind === "invite" ? row.invite.email : "";
  const name = m?.name ?? "";
  return (
    <span className="flex min-w-0 items-start gap-3">
      <Avatar name={name} email={email} pending={row.kind === "invite"} />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="truncate font-medium text-fg-strong"
              title={name || email}
            >
              {name || email}
            </span>
            {m?.you ? <span className="text-xs text-fg-muted">You</span> : null}
            {m?.disabled ? (
              <span className="text-xs text-warning">Disabled</span>
            ) : null}
          </span>
          <span className="flex min-w-0 text-xs text-fg-muted">
            {name ? (
              <>
                <span className="truncate" title={email}>
                  {email}
                </span>
                <span aria-hidden="true" className="shrink-0">
                  &nbsp;·&nbsp;
                </span>
              </>
            ) : null}
            {row.kind === "member" ? (
              <span className="shrink-0 whitespace-nowrap">
                <LastSeen row={row} />
              </span>
            ) : null}
          </span>
        </span>
        <RoleTags
          productName={productName}
          roles={
            m
              ? visibleRoles(m.roles)
              : row.kind === "invite"
                ? [row.invite]
                : []
          }
        />
        <span className="flex flex-col gap-0.5 text-xs text-fg-muted">
          {(m
            ? accessLines(m, group, productName)
            : row.kind === "invite"
              ? inviteLines(row.invite)
              : []
          ).map((l) => (
            <span key={l.key}>{l.node}</span>
          ))}
        </span>
      </span>
    </span>
  );
}
