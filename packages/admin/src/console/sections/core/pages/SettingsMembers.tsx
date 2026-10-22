/**
 * Settings → Members (ST-08, then ST-31.14; mockup `admin.product-members`): who can administer
 * this product, read from `GET /products/:slug/members`. Two tables: the product's own admins
 * (people and the invites waiting, this product's role only) and, read-only, who reaches it
 * through a platform-wide role.
 *
 * Invite people opens the Members drawer (`access/InviteDrawer.tsx`) scoped to the product: the
 * role is Product admin of it, and only the areas the signed-in member holds are offered. A row's
 * menu edits areas or removes the role. The Worker enforces every rule; the console declines to
 * offer what it would refuse, and says why. Rows given by an SSO rule are ST-32's.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import {
  api,
  ApiError,
  type Member,
  type MemberInvite,
  type MemberRole,
  type ProductPlatformRole,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { ActionMenu, type ActionMenuEntry } from "../../../../ui/ActionMenu.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { toast } from "../../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { roleLabel } from "../../../access/can.js";
import { InviteDrawer } from "../../../access/InviteDrawer.js";
import type { ProductName } from "../../../access/InviteDrawerParts.js";
import {
  cannotEditAreas,
  cannotTake,
  describeMembersError,
  rowsOf,
  type MemberRow,
} from "../../../access/membersModel.js";
import { RoleSet } from "../../../access/RoleTag.js";
import { useCan, useWriteGate } from "../../../access/useCan.js";
import { useMe } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { SettingsSection } from "../../../templates/Settings.js";
import {
  AccessLines,
  accessLines,
  Avatar,
  inviteLines,
} from "../../platform/pages/platformMembersParts.js";

/** The roles a row holds on this product; an invite is its one role. */
const rolesOf = (r: MemberRow): MemberRole[] =>
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

function Person({
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
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={name} email={email} pending={pending} />
      <div className="min-w-0">
        {name ? (
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-fg-strong">
            <span className="[overflow-wrap:anywhere]">{name}</span>
            {you ? (
              <span className="text-xs font-normal text-fg-muted">You</span>
            ) : null}
          </p>
        ) : null}
        <p
          className={
            name
              ? "text-sm text-fg-muted [overflow-wrap:anywhere]"
              : "text-sm font-medium text-fg-strong [overflow-wrap:anywhere]"
          }
        >
          {email}
        </p>
      </div>
    </div>
  );
}

/** One table: Member, Role, and the optional Access-from and Actions columns. */
function Table({
  label,
  head,
  children,
}: {
  label: string;
  head: string[];
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <table
      role="table"
      className="w-full text-start max-sm:block"
      aria-label={label}
    >
      <thead role="rowgroup" className="max-sm:sr-only">
        <tr
          role="row"
          className="border-b border-border bg-surface-sunken text-sm text-fg-strong"
        >
          {head.map((h) => (
            <th
              key={h || "actions"}
              role="columnheader"
              scope="col"
              className={cn(
                "px-5 py-2.5 text-start font-medium",
                h === "Role" && "w-48",
              )}
            >
              {h || <span className="sr-only">Actions</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody role="rowgroup" className="divide-y divide-border max-sm:block">
        {children}
      </tbody>
    </table>
  );
}

const ROW = "max-sm:block max-sm:px-5 max-sm:py-3 align-top";
const CELL = "px-5 py-3 max-sm:block max-sm:p-0 max-sm:pb-2";

function PlatformRows({
  rows,
  productName,
}: {
  rows: ProductPlatformRole[];
  productName: ProductName;
}): React.ReactElement {
  return (
    <Table label="Platform roles" head={["Member", "Role", "Access from"]}>
      {rows.map((r) => (
        <tr key={`${r.memberId}:${r.scope}`} role="row" className={ROW}>
          <td role="cell" className={CELL}>
            <Person name={r.name} email={r.email} you={false} pending={false} />
          </td>
          <td role="cell" className={CELL}>
            <RoleSet
              role={{ role: r.role, scope: r.scope, areas: r.areas }}
              productName={productName}
            />
          </td>
          <td role="cell" className={`${CELL} text-sm text-fg-muted`}>
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

export function SettingsMembersPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const meQ = useMe();
  const me = meQ.data;
  const canView = useCan("members", slug);
  const write = useWriteGate("members", slug, "Members");
  const q = useQuery({
    queryKey: qk.productMembers(slug),
    queryFn: () => api.productMembers(slug),
    enabled: canView,
  });
  useLoadingAnnouncement("members", q.isPending && canView);
  const products = React.useMemo(
    () => (me?.products ?? []).map((p) => ({ slug: p.slug, name: p.name })),
    [me?.products],
  );
  const productName = React.useCallback<ProductName>(
    (s) => products.find((p) => p.slug === s)?.name ?? s,
    [products],
  );
  const name = productName(slug);
  const [drawer, setDrawer] = React.useState<{
    member: string | null;
    areas?: boolean;
  } | null>(null);
  const [removing, setRemoving] = React.useState<MemberRow | null>(null);

  const view = q.data;
  const rows = React.useMemo(() => rowsOf(view), [view]);
  const editingMember =
    view?.members.find((m) => m.memberId === drawer?.member) ?? null;
  const live = write.allowed;

  if (!canView)
    return (
      <SettingsSection id="members-admins" title="Admins">
        <EmptyState
          kind="not-found"
          variant="inline"
          title="You can't see who manages this product"
          description={write.disabledReason}
        />
      </SettingsSection>
    );
  if (q.isPending && canView)
    return (
      <SettingsSection id="members-admins" title="Admins">
        <div className="space-y-3 p-5" aria-busy="true">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      </SettingsSection>
    );
  if (q.isError || !view)
    return (
      <SettingsSection id="members-admins" title="Admins">
        <div className="p-5">
          <ErrorState
            error={q.error}
            onRetry={() => void q.refetch()}
            thing="Members"
            compact
          />
        </div>
      </SettingsSection>
    );

  const menu = (r: MemberRow): ActionMenuEntry[] => {
    if (r.kind === "invite") {
      const why = cannotTake(me, rolesOf(r)[0]!, productName, "revoke");
      return [
        {
          label: "Withdraw invite…",
          tone: "danger",
          onSelect: () => setRemoving(r),
          ...(why ? { disabledReason: why } : {}),
        },
      ];
    }
    const mine = r.member.roles.filter((x) => x.bindingId !== null);
    const narrowable = mine.find((x) => x.role === "product_admin");
    const editWhy = narrowable
      ? cannotEditAreas(me, narrowable, productName)
      : "Nothing to narrow.";
    const removeWhy =
      mine.map((x) => cannotTake(me, x, productName)).find(Boolean) ??
      (mine.length === 0
        ? "This comes from a rule. It can't be removed here."
        : undefined);
    return [
      {
        label: "Edit areas…",
        onSelect: () => setDrawer({ member: r.member.memberId, areas: true }),
        ...(editWhy ? { disabledReason: editWhy } : {}),
      },
      { type: "separator" },
      {
        label: `Remove from ${name}…`,
        tone: "danger",
        onSelect: () => setRemoving(r),
        ...(removeWhy ? { disabledReason: removeWhy } : {}),
      },
    ];
  };

  return (
    <div className="space-y-6" data-template="members">
      {view.truncated || view.incomplete ? (
        <Callout tone="warning">
          {[
            view.truncated
              ? "Showing the first 500 members and 500 invites."
              : "",
            view.incomplete
              ? "Some people couldn't be listed. Reload to try again."
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
        </Callout>
      ) : null}
      <SettingsSection
        id="members-admins"
        title="Admins"
        actions={
          <Button
            variant="primary"
            size="sm"
            iconStart={<UserPlus className="size-4" aria-hidden="true" />}
            disabled={!live}
            disabledReason={write.disabledReason}
            onClick={() => setDrawer({ member: null })}
          >
            Invite people
          </Button>
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            kind="first-run"
            variant="inline"
            title="No product admins"
            description="Superadmins below can still administer this product."
          />
        ) : (
          <Table
            label="Admins"
            head={["Member", "Role", "Access from", ...(live ? [""] : [])]}
          >
            {rows.map((r) => {
              const email =
                r.kind === "member" ? r.member.email : r.invite.email;
              const who = r.kind === "member" ? r.member.name : "";
              const items = menu(r);
              return (
                <tr key={r.id} role="row" className={ROW}>
                  <td role="cell" className={CELL}>
                    <Person
                      name={who}
                      email={email}
                      you={r.kind === "member" && r.member.you}
                      pending={r.kind === "invite"}
                    />
                  </td>
                  <td role="cell" className={CELL}>
                    <span className="flex min-w-0 flex-col items-start gap-1.5">
                      {rolesOf(r).map((x, i) => (
                        <RoleSet
                          key={x.bindingId ?? i}
                          role={x}
                          productName={productName}
                        />
                      ))}
                    </span>
                  </td>
                  <td role="cell" className={`${CELL} max-sm:pb-0`}>
                    <AccessLines
                      lines={
                        r.kind === "invite"
                          ? inviteLines(r.invite)
                          : accessLines(r.member, null, productName)
                      }
                    />
                  </td>
                  {live ? (
                    <td
                      role="cell"
                      className="w-12 px-5 py-3 text-end max-sm:block max-sm:px-0 max-sm:py-0 max-sm:pt-2 max-sm:text-start"
                    >
                      <ActionMenu
                        label={`Actions for ${who || email}`}
                        items={items}
                      />
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </Table>
        )}
      </SettingsSection>
      {view.platformRoles.length > 0 ? (
        <SettingsSection
          id="members-platform"
          title="Platform roles"
          description="Read-only here."
        >
          <PlatformRows rows={view.platformRoles} productName={productName} />
        </SettingsSection>
      ) : null}
      <InviteDrawer
        open={drawer !== null && (drawer.member === null || !!editingMember)}
        member={editingMember}
        {...(drawer?.areas ? { startView: "areas" as const } : {})}
        onReopen={(member) => setDrawer({ member })}
        onClose={() => setDrawer(null)}
        me={me}
        members={view.members}
        invites={view.invites}
        products={products}
        productName={productName}
        writeReason={write.disabledReason}
        productScope={{ slug, name }}
      />
      <RemoveDialog
        slug={slug}
        name={name}
        row={removing}
        members={view.members}
        onClose={() => setRemoving(null)}
        productName={productName}
      />
    </div>
  );
}

/** Remove a person's roles on this product, or withdraw an invite. They keep their other roles. */
function RemoveDialog({
  slug,
  name,
  row,
  members,
  onClose,
  productName,
}: {
  slug: string;
  name: string;
  row: MemberRow | null;
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
          : `Remove ${who} from ${name}?`
      }
      consequences={
        invite
          ? [`The link stops working. ${label} is not given.`]
          : [
              `${who} loses ${label}. Any other role they hold stays.`,
              "The role stops applying within 30 seconds.",
              "Every Superadmin is told.",
            ]
      }
      confirmLabel={invite ? "Withdraw invite" : `Remove from ${name}`}
      describeError={describeMembersError}
      onConfirm={async () => {
        for (const id of ids) {
          try {
            await mutate("revokeProductMember", slug, id);
          } catch (e) {
            // Already gone is the outcome we want.
            if (!(e instanceof ApiError && e.status === 404)) throw e;
          }
        }
        toast.success(
          invite ? "Invite withdrawn" : `Removed ${who} from ${name}`,
        );
      }}
    />
  );
}
