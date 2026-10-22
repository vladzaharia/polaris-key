/**
 * Settings → Members (ST-08, then ST-31.14; mockup `admin.product-members`): who can manage this
 * product, read from `GET /products/:slug/members`. Two tables: the product's own admins (people
 * and the invites waiting, this product's role only) and, read-only, who reaches it through a
 * platform-wide role. Both share one column template, so Role and Access from line up.
 *
 * Invite people opens the Members drawer (`access/InviteDrawer.tsx`) scoped to the product: the
 * role is Product admin of it, and only the areas the signed-in member holds are offered. A row's
 * menu edits areas or removes the role. The Worker enforces every rule; the console declines to
 * offer what it would refuse, and says why. Rows given by an SSO rule are ST-32's.
 *
 * Below 64em (a rem breakpoint, so large text gets it too) the rows stack.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { api, ApiError } from "../../../../api.js";
import { ActionMenu, type ActionMenuEntry } from "../../../../ui/ActionMenu.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { InviteDrawer } from "../../../access/InviteDrawer.js";
import type { ProductName } from "../../../access/InviteDrawerParts.js";
import {
  cannotChangeProductRole,
  cannotTake,
  rowsOf,
  type MemberRow,
} from "../../../access/membersModel.js";
import { RoleSet } from "../../../access/RoleTag.js";
import { useCan, useWriteGate } from "../../../access/useCan.js";
import { useMe } from "../../../data/hooks.js";
import { qk } from "../../../data/queries.js";
import { SettingsSection } from "../../../templates/Settings.js";
import {
  AccessLines,
  accessLines,
  inviteLines,
} from "../../platform/pages/platformMembersParts.js";

import {
  CELL,
  INDENT,
  Person,
  PlatformRows,
  ROW,
  RemoveDialog,
  Table,
  actionsButton,
  focusWhen,
  inviteButton,
  rolesOf,
  rowLabel,
} from "./SettingsMembersParts.js";

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
  // A failed load announces nothing here: its alert speaks for it.
  useLoadingAnnouncement("members", (q.isPending && canView) || q.isError);
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
  // Whom the drawer was opened from, so focus goes back to that row's menu.
  const opener = React.useRef<string | null>(null);

  const view = q.data;
  const rows = React.useMemo(() => rowsOf(view), [view]);
  const editingMember =
    view?.members.find((m) => m.memberId === drawer?.member) ?? null;
  const live = write.allowed;

  // After a Retry that works the alert is gone: focus goes to Invite people, not the body.
  const wasFailed = React.useRef(false);
  React.useEffect(() => {
    if (q.isError) wasFailed.current = true;
    else if (view && wasFailed.current) {
      wasFailed.current = false;
      focusWhen(inviteButton);
    }
  }, [q.isError, view]);

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
  if (q.isPending)
    return (
      <SettingsSection
        id="members-admins"
        title="Admins"
        actions={
          <Button variant="primary" size="sm" disabled>
            Invite people
          </Button>
        }
      >
        <div className="divide-y divide-border" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-3">
              <Skeleton className="size-9 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40 max-w-full" />
                <Skeleton className="h-3.5 w-56 max-w-full" />
              </div>
              <Skeleton className="h-6 w-28 max-sm:hidden" />
            </div>
          ))}
        </div>
      </SettingsSection>
    );
  if (q.isError || !view)
    return (
      <SettingsSection id="members-admins" title="Admins">
        {q.error instanceof ApiError && q.error.status === 403 ? (
          <EmptyState
            kind="not-found"
            variant="inline"
            title={`You can't see who manages ${name}`}
            description="Ask a Superadmin."
          />
        ) : (
          <div className="p-5">
            <ErrorState
              error={q.error}
              onRetry={() => void q.refetch()}
              thing="Members"
              compact
            />
          </div>
        )}
      </SettingsSection>
    );

  const menu = (r: MemberRow, why: string | undefined): ActionMenuEntry[] => {
    if (r.kind === "invite") {
      const cant = cannotTake(me, rolesOf(r)[0]!, productName, "revoke");
      return [
        {
          label: "Withdraw invite…",
          tone: "danger",
          onSelect: () => setRemoving(r),
          ...(cant ? { disabledReason: cant } : {}),
        },
      ];
    }
    const narrowable = r.member.roles.find(
      (x) => x.role === "product_admin" && x.bindingId !== null,
    );
    const hint = why ? "Not available. See the row." : undefined;
    return [
      {
        label: "Edit areas…",
        onSelect: () => {
          opener.current = rowLabel(r);
          setDrawer({ member: r.member.memberId, areas: true });
        },
        ...(why || !narrowable
          ? { disabledReason: hint ?? "This comes from a rule." }
          : {}),
      },
      { type: "separator" },
      {
        label: r.member.you ? `Remove yourself…` : `Remove from ${name}…`,
        tone: "danger",
        onSelect: () => setRemoving(r),
        ...(why ? { disabledReason: hint! } : {}),
      },
    ];
  };

  /** One reason per member row: the first role they hold here that the viewer cannot change. */
  const reasonOf = (r: MemberRow): string | undefined => {
    if (r.kind !== "member") return undefined;
    const who = r.member.name || r.member.email;
    const mine = r.member.roles;
    if (mine.length === 0) return undefined;
    for (const x of mine) {
      const why = cannotChangeProductRole(me, who, x, slug, productName);
      if (why) return why;
    }
    return undefined;
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
        description={!live ? write.disabledReason : undefined}
        actions={
          <Button
            id="members-invite"
            variant="primary"
            size="sm"
            iconStart={<UserPlus className="size-4" aria-hidden="true" />}
            disabled={!live}
            disabledReason={write.disabledReason}
            onClick={() => {
              opener.current = null;
              setDrawer({ member: null });
            }}
          >
            Invite people
          </Button>
        }
      >
        {rows.length === 0 ? (
          <div className="p-5">
            <EmptyState
              kind="first-run"
              variant="inline"
              title={`No one has ${name} admin yet`}
              description={
                view.platformRoles.length > 0
                  ? `Platform roles below can still manage ${name}.`
                  : undefined
              }
            />
          </div>
        ) : (
          <Table
            label="Admins"
            head={["Member", "Role", "Access from", ...(live ? [""] : [])]}
          >
            {rows.map((r) => {
              const email =
                r.kind === "member" ? r.member.email : r.invite.email;
              const who = r.kind === "member" ? r.member.name : "";
              const why = reasonOf(r);
              const items = menu(r, why);
              const rule =
                r.kind === "member" &&
                r.member.roles.some((x) => x.bindingId === null);
              return (
                <tr key={r.id} role="row" className={ROW}>
                  <td
                    role="cell"
                    className={`${CELL} group-data-[stacked]/t:pe-10`}
                  >
                    <Person
                      name={who}
                      email={email}
                      you={r.kind === "member" && r.member.you}
                      pending={r.kind === "invite"}
                    />
                  </td>
                  <td role="cell" className={`${CELL} ${INDENT}`}>
                    <span className="flex min-w-0 flex-col items-start gap-1.5">
                      {rolesOf(r).map((x, i) => (
                        <RoleSet
                          key={x.bindingId ?? i}
                          role={x}
                          productName={productName}
                        />
                      ))}
                    </span>
                    {why && live ? (
                      <p className="mt-1.5 text-xs text-fg-muted">{why}</p>
                    ) : null}
                  </td>
                  <td
                    role="cell"
                    className={`${CELL} ${INDENT} group-data-[stacked]/t:pb-0`}
                  >
                    {rule ? (
                      <span className="text-sm text-fg-muted">
                        Comes from a rule
                      </span>
                    ) : (
                      <AccessLines
                        lines={
                          r.kind === "invite"
                            ? inviteLines(r.invite)
                            : accessLines(r.member, null, productName)
                        }
                      />
                    )}
                  </td>
                  {live ? (
                    <td
                      role="cell"
                      className={`px-5 py-3 text-end group-data-[stacked]/t:absolute group-data-[stacked]/t:end-2 group-data-[stacked]/t:top-2 group-data-[stacked]/t:w-auto group-data-[stacked]/t:p-0`}
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
        onClose={() => {
          setDrawer(null);
          const back = opener.current;
          if (back) focusWhen(() => actionsButton(back));
        }}
        me={me}
        members={view.members}
        invites={view.invites}
        platformRoles={view.platformRoles}
        products={products}
        productName={productName}
        writeReason={write.disabledReason}
        productScope={{ slug, name }}
      />
      <RemoveDialog
        slug={slug}
        name={name}
        row={removing}
        rows={rows}
        members={view.members}
        onClose={() => setRemoving(null)}
        productName={productName}
      />
    </div>
  );
}
