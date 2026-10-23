/**
 * Settings → Members, the parts (ST-31.14): the two tables' shared column template, the person
 * cell, the platform-roles rows, the focus helpers and the Remove / Withdraw confirmation.
 * `SettingsMembers.tsx` composes them.
 */

import * as React from "react";
import {
  ApiError,
  type Member,
  type MemberInvite,
  type MemberRole,
  type ProductPlatformRole,
} from "../../../../api.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { useNarrowRem } from "../../../../ui/data-table/index.js";
import { toast } from "../../../../ui/toast.js";
import { roleLabel } from "../../../access/can.js";
import type { ProductName } from "../../../access/InviteDrawerParts.js";
import {
  describeMembersError,
  type MemberRow,
} from "../../../access/membersModel.js";
import { RoleSet } from "../../../access/RoleTag.js";
import { mutate } from "../../../data/mutations.js";
import { navigate } from "../../../router.js";
import { r as routes } from "../../../routes.js";
import { Avatar } from "../../platform/pages/platformMembersParts.js";

/* The stacked layout starts below 64 rem of window (so text size counts as much as width, as in
   Platform → Members): `data-stacked` on the table, read by `group-data-[stacked]/t:` below. */
const STACK_REM = 64;

/** The roles a row holds on this product; an invite is its one role. */
export const rolesOf = (r: MemberRow): MemberRole[] =>
  r.kind === "member"
    ? r.member.roles
    : [
        {
          role: r.invite.role,
          scope: r.invite.scope,
          areas: r.invite.areas,
          source: "invite",
          bindingId: r.invite.bindingId,
          grantedBy: r.invite.invitedBy,
          grantedAt: r.invite.sentAt,
        },
      ];

export function Person({
  name,
  email,
  you,
  pending,
}: {
  name: string;
  email: string;
  you: boolean;
  pending: boolean;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 max-w-[22rem] items-center gap-3">
      <Avatar name={name} email={email} pending={pending} />
      <div className="min-w-0">
        {name ? (
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-fg-strong">
            <span className="min-w-0 break-words">{name}</span>
            {you ? (
              <span className="text-xs font-normal text-fg-muted">You</span>
            ) : null}
          </p>
        ) : null}
        <p
          className={
            name
              ? "break-words text-sm text-fg-muted"
              : "break-words text-sm font-medium text-fg-strong"
          }
        >
          {email}
        </p>
      </div>
    </div>
  );
}

/** One column template for both tables: Member, Role, Access from, and the row's menu. */
export const COLS = ["w-[30%]", "w-[34%]", "w-[28%]", "w-[8%]"];

export function Table({
  label,
  head,
  pad = false,
  children,
}: {
  label: string;
  head: string[];
  /** Draw the empty fourth header cell, so a table without actions keeps the band. */
  pad?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const stacked = useNarrowRem(STACK_REM);
  return (
    <table
      role="table"
      data-stacked={stacked ? "" : undefined}
      className="group/t w-full table-fixed text-start data-[stacked]:block"
      aria-label={label}
    >
      <colgroup>
        {COLS.map((w) => (
          <col key={w} className={w} />
        ))}
      </colgroup>
      <thead role="rowgroup" className={`group-data-[stacked]/t:sr-only`}>
        <tr
          role="row"
          className="border-b border-border bg-surface-sunken text-sm text-fg-strong"
        >
          {head.map((h) => (
            <th
              key={h || "actions"}
              role="columnheader"
              scope="col"
              className="px-5 py-2.5 text-start font-medium"
            >
              {h || <span className="sr-only">Actions</span>}
            </th>
          ))}
          {pad ? <th aria-hidden="true" className="px-5 py-2.5" /> : null}
        </tr>
      </thead>
      <tbody
        role="rowgroup"
        className={`divide-y divide-border group-data-[stacked]/t:block`}
      >
        {children}
      </tbody>
    </table>
  );
}

export const ROW = `align-top group-data-[stacked]/t:relative group-data-[stacked]/t:block group-data-[stacked]/t:px-5 group-data-[stacked]/t:py-3`;
export const CELL = `px-5 py-3 group-data-[stacked]/t:block group-data-[stacked]/t:p-0 group-data-[stacked]/t:pb-2`;
/** Below the breakpoint the role and source sit under the name, past the avatar. */
export const INDENT = `group-data-[stacked]/t:ps-12`;

export function PlatformRows({
  rows,
  productName,
}: {
  rows: ProductPlatformRole[];
  productName: ProductName;
}): React.ReactElement {
  return (
    <Table label="Platform roles" head={["Member", "Role", "Access from"]} pad>
      {rows.map((r) => (
        <tr key={`${r.memberId}:${r.scope}`} role="row" className={ROW}>
          <td role="cell" className={`${CELL} group-data-[stacked]/t:pe-10`}>
            <Person name={r.name} email={r.email} you={false} pending={false} />
          </td>
          <td role="cell" className={`${CELL} ${INDENT}`}>
            <RoleSet
              role={{ role: r.role, scope: r.scope, areas: r.areas }}
              productName={productName}
            />
          </td>
          <td
            role="cell"
            className={`${CELL} text-sm text-fg-muted ${INDENT} group-data-[stacked]/t:pb-0`}
          >
            {r.source === "root"
              ? "Root rule"
              : r.source === "creator"
                ? "Created a product"
                : "Added by a Superadmin"}
          </td>
        </tr>
      ))}
    </Table>
  );
}

export const rowLabel = (r: MemberRow): string =>
  r.kind === "member" ? r.member.name || r.member.email : r.invite.email;

/** Move focus to a control once it is there (a refetch may still be redrawing the rows). */
export function focusWhen(find: () => HTMLElement | null, tries = 30): void {
  const go = (n: number): void => {
    const el = find();
    if (el) el.focus();
    else if (n > 0) window.setTimeout(() => go(n - 1), 50);
  };
  window.setTimeout(() => go(tries), 0);
}

export const actionsButton = (label: string): HTMLElement | null =>
  [
    ...document.querySelectorAll<HTMLElement>(
      'table[aria-label="Admins"] button[aria-label^="Actions for "]',
    ),
  ].find((b) => b.getAttribute("aria-label") === `Actions for ${label}`) ??
  null;
export const inviteButton = (): HTMLElement | null =>
  document.getElementById("members-invite");

/** Remove a person's roles on this product, or withdraw an invite. They keep their other roles. */
export function RemoveDialog({
  slug,
  name,
  row,
  rows,
  members,
  onClose,
  productName,
}: {
  slug: string;
  name: string;
  row: MemberRow | null;
  rows: readonly MemberRow[];
  members: readonly Member[];
  onClose: () => void;
  productName: ProductName;
}): React.ReactElement {
  const invite: MemberInvite | null =
    row?.kind === "invite" ? row.invite : null;
  const live =
    row?.kind === "member"
      ? (members.find((m) => m.memberId === row.member.memberId) ?? row.member)
      : null;
  const self = Boolean(live?.you);
  const who = live ? live.name || live.email : (invite?.email ?? "");
  const ids = live
    ? live.roles.flatMap((r) => (r.bindingId ? [r.bindingId] : []))
    : invite
      ? [invite.bindingId]
      : [];
  const label = invite
    ? roleLabel(
        {
          role: invite.role,
          scope: invite.scope,
          areas: invite.areas,
          source: "invite",
        },
        productName,
      ).label
    : `${name} admin`;
  return (
    <ConfirmDialog
      open={row !== null}
      onOpenChange={(o) => !o && onClose()}
      intent="caution"
      title={
        invite
          ? `Withdraw the invite for ${who}?`
          : self
            ? `Remove yourself from ${name}?`
            : `Remove ${who} from ${name}?`
      }
      consequences={
        invite
          ? [`The link stops working. They won't get ${label}.`]
          : self
            ? [
                `You lose access to ${name}, including this page.`,
                `Only another ${name} admin with Members, or a Superadmin, can add you back.`,
                "Every Superadmin is told.",
              ]
            : [
                `${who} loses ${label}. Any other role they hold stays.`,
                "The role stops applying within 30 seconds.",
                "Every Superadmin is told.",
              ]
      }
      confirmLabel={
        invite
          ? "Withdraw invite"
          : self
            ? "Remove yourself"
            : `Remove from ${name}`
      }
      describeError={describeMembersError}
      onConfirm={async () => {
        // The next row (else Invite people) takes focus once this one is gone.
        const at = row ? rows.findIndex((x) => x.id === row.id) : -1;
        const next = rows[at + 1] ?? rows[at - 1];
        const mine = row ? rowLabel(row) : "";
        for (const id of ids) {
          try {
            await mutate("revokeProductMember", slug, id);
          } catch (e) {
            // Already gone is the outcome we want.
            if (!(e instanceof ApiError && e.status === 404)) throw e;
          }
        }
        if (self) {
          toast.success(`You were removed from ${name}`);
          navigate(routes.home());
          return;
        }
        toast.success(
          invite ? "Invite withdrawn" : `Removed ${who} from ${name}`,
        );
        focusWhen(() =>
          actionsButton(mine)
            ? null
            : next
              ? actionsButton(rowLabel(next))
              : inviteButton(),
        );
      }}
    />
  );
}
