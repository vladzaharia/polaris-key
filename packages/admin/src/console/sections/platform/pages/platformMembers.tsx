/**
 * Platform → Members (`#/platform/members`, ST-31.11; mockup `admin.members`): one table of
 * everyone with a role, their roles as tags that add up, where each role came from, their last
 * console sign-in, and the invites waiting as rows of the same table (a dashed mail avatar says
 * pending). The root rule is shown above the table and cannot be removed here.
 *
 * Superadmins and Platform admins see the same list; what they may change differs (a Platform admin
 * cannot give or take the platform roles), and the controls say why they are off. The Worker
 * decides every write. Roles, SSO rules (ST-32) and the full invite drawer (ST-31.12) are
 * other slices.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { api, type Member, type MemberInvite } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import {
  DataTable,
  useMediaQuery,
  type DataColumn,
  type Facet,
  type RowActionItem,
} from "../../../../ui/data-table/index.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { roleLabel } from "../../../access/can.js";
import { RoleTags } from "../../../access/RoleTag.js";
import { useWriteGate } from "../../../access/useCan.js";
import { qk } from "../../../data/queries.js";
import { useMe } from "../../../data/hooks.js";
import { navigate } from "../../../router.js";
import { r as routes } from "../../../routes.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { InviteDrawer } from "../../../access/InviteDrawer.js";
import type { ProductName } from "../../../access/InviteDrawerParts.js";
import {
  RemoveMemberDialog,
  RevokeInviteDialog,
} from "./platformMembersDialogs.js";
import {
  AccessLines,
  accessLines,
  Avatar,
  inviteLines,
  LastSeen,
  StackedRow,
} from "./platformMembersParts.js";
import {
  cannotTake,
  removable,
  productOfScope,
  rowsOf,
  visibleRoles,
  type MemberRow,
} from "./platformMembersModel.js";

const ROLE_OPTIONS = [
  { value: "superadmin", label: "Superadmin" },
  { value: "platform_admin", label: "Platform admin" },
  { value: "product_admin", label: "Product admin" },
  { value: "console_access", label: "Console access" },
];

const SOURCE_OPTIONS = [
  { value: "root", label: "Root rule" },
  { value: "grant", label: "Added by someone" },
  { value: "creator", label: "Created a product" },
  { value: "invite", label: "Invite" },
];

export function PlatformMembers(): React.ReactElement {
  const view = useQuery({
    queryKey: qk.members(),
    queryFn: () => api.members(),
  });
  const meQ = useMe();
  const me = meQ.data;
  useLoadingAnnouncement("members", view.isPending);
  const write = useWriteGate("members", null, "Members");
  const [state, setState] = useTableUrlState("platform-members", {
    facets: ["role", "product", "source"],
  });
  // The invite / edit-roles drawer: `{ member: null }` invites, a member id edits that member.
  const [drawer, setDrawer] = React.useState<{ member: string | null } | null>(
    null,
  );
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<MemberInvite | null>(null);

  const products = React.useMemo(
    () => (me?.products ?? []).map((p) => ({ slug: p.slug, name: p.name })),
    [me?.products],
  );
  const productName = React.useCallback<ProductName>(
    (slug) => products.find((p) => p.slug === slug)?.name ?? slug,
    [products],
  );
  const folded = useMediaQuery("(max-width: 1365px)");
  const group = view.data?.rootRule.group ?? null;
  const rows = React.useMemo(() => rowsOf(view.data), [view.data]);
  const editingMember =
    view.data?.members.find((m) => m.memberId === drawer?.member) ?? null;

  const productOptions = React.useMemo(() => {
    const slugs = new Set<string>();
    for (const r of rows) {
      const roles = r.kind === "member" ? r.member.roles : [r.invite];
      for (const x of roles) {
        const s = productOfScope(x.scope);
        if (s) slugs.add(s);
      }
    }
    return [...slugs].sort().map((s) => ({ value: s, label: productName(s) }));
  }, [rows, productName]);

  const facets: Facet<MemberRow>[] = [
    {
      id: "role",
      label: "Role",
      options: ROLE_OPTIONS,
      accessor: (r) =>
        r.kind === "member"
          ? r.member.roles.map((x) => x.role)
          : [r.invite.role],
    },
    {
      id: "product",
      label: "Product",
      options: productOptions,
      accessor: (r) =>
        (r.kind === "member" ? r.member.roles : [r.invite])
          .map((x) => productOfScope(x.scope))
          .filter((s): s is string => s !== null),
    },
    {
      id: "source",
      label: "Access from",
      options: SOURCE_OPTIONS,
      accessor: (r) =>
        r.kind === "member" ? r.member.roles.map((x) => x.source) : ["invite"],
    },
  ];

  const columns: DataColumn<MemberRow>[] = [
    {
      id: "member",
      header: "Member",
      accessorFn: (r) =>
        r.kind === "member"
          ? `${r.member.name} ${r.member.email}`
          : r.invite.email,
      meta: {
        priority: 1,
        primary: true,
        alwaysVisible: true,
        label: "Member",
      },
      cell: ({ row }) => {
        const r = row.original;
        const name = r.kind === "member" ? r.member.name : "";
        const email = r.kind === "member" ? r.member.email : r.invite.email;
        return (
          <span className="flex min-w-0 max-w-[17rem] items-center gap-3 min-[1440px]:max-w-[22rem]">
            <Avatar name={name} email={email} pending={r.kind === "invite"} />
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="truncate font-medium text-fg-strong"
                  title={name || email}
                >
                  {name || email}
                </span>
                {r.kind === "member" && r.member.you ? (
                  <span className="text-xs text-fg-muted">You</span>
                ) : null}
                {r.kind === "member" && r.member.disabled ? (
                  <span className="text-xs text-warning">Disabled</span>
                ) : null}
              </span>
              {name || (folded && r.kind === "member") ? (
                <span className="flex min-w-0 text-xs text-fg-muted">
                  {name ? (
                    <span className="truncate" title={email}>
                      {email}
                    </span>
                  ) : null}
                  {folded && r.kind === "member" ? (
                    <span className="shrink-0 whitespace-nowrap">
                      {name ? (
                        <span aria-hidden="true">&nbsp;·&nbsp;</span>
                      ) : null}
                      <LastSeen row={r} />
                    </span>
                  ) : null}
                </span>
              ) : null}
            </span>
          </span>
        );
      },
    },
    {
      id: "roles",
      header: "Roles",
      // Sorted by what the tags say, not by the role ids.
      accessorFn: (r) =>
        (r.kind === "member"
          ? visibleRoles(r.member.roles)
          : [{ ...r.invite, source: "invite" }]
        )
          .map((x) => roleLabel(x, productName).label)
          .sort()
          .join(" "),
      meta: { priority: 1, label: "Roles" },
      cell: ({ row }) => {
        const r = row.original;
        return (
          <RoleTags
            productName={productName}
            roles={
              r.kind === "member" ? visibleRoles(r.member.roles) : [r.invite]
            }
          />
        );
      },
    },
    {
      id: "source",
      header: "Access from",
      accessorFn: (r) => r.kind,
      enableSorting: false,
      meta: { priority: 1, label: "Access from" },
      cell: ({ row }) => {
        const r = row.original;
        return (
          <AccessLines
            lines={
              r.kind === "invite"
                ? inviteLines(r.invite)
                : accessLines(r.member, group, productName)
            }
          />
        );
      },
    },
    ...(folded
      ? []
      : [
          {
            id: "lastSignIn",
            header: "Last sign-in",
            accessorFn: (r: MemberRow) =>
              r.kind === "member" ? (r.member.lastSignInAt ?? 0) : 0,
            meta: { priority: 2, numeric: true, label: "Last sign-in" },
            cell: ({ row }: { row: { original: MemberRow } }) => (
              <LastSeen row={row.original} />
            ),
          } satisfies DataColumn<MemberRow>,
        ]),
  ];

  const rowActions = (r: MemberRow): RowActionItem[] => {
    if (r.kind === "invite") {
      const why = cannotTake(
        me,
        {
          ...r.invite,
          source: "invite",
          bindingId: r.invite.bindingId,
          grantedBy: null,
          grantedAt: r.invite.sentAt,
        },
        productName,
      );
      return [
        {
          label: "Revoke invite…",
          tone: "danger",
          onSelect: () => setRevoking(r.invite),
          disabledReason: write.disabledReason ?? why,
        },
      ];
    }
    const m = r.member;
    const hasRoot = m.roles.some((x) => x.bindingId === null);
    // Removing someone takes back every role; one that stays would leave them in the console.
    const stuck = removable(me, m, productName).why;
    const removeWhy = write.disabledReason
      ? write.disabledReason
      : hasRoot
        ? `In the root rule${group ? ` (${group})` : ""}. Take them out of the group at your identity provider.`
        : stuck;
    return [
      {
        label: "Edit roles…",
        onSelect: () => setDrawer({ member: m.memberId }),
        disabledReason: write.disabledReason,
      },
      {
        label: "Remove from console…",
        tone: "danger",
        onSelect: () => setRemoving(m.memberId),
        disabledReason: removeWhy,
      },
      { type: "separator" },
      {
        label: "Show activity",
        onSelect: () => {
          navigate(
            routes.platformActivity({
              actor: m.memberId,
              who: m.name || m.email,
            }),
          );
        },
      },
    ];
  };

  const roster = view.data;
  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Members"
          refetching={view.isFetching && !view.isPending}
          primaryAction={
            <Button
              variant="primary"
              iconStart={<UserPlus className="size-4" aria-hidden="true" />}
              disabledReason={write.disabledReason}
              disabled={!write.allowed}
              onClick={() => setDrawer({ member: null })}
            >
              Invite people
            </Button>
          }
        />
      }
    >
      {group ? (
        <Callout
          tone="info"
          title={
            <>
              Root rule: everyone in <code className="font-mono">{group}</code>{" "}
              is a Superadmin
            </>
          }
        >
          <span className="sr-only">
            Set at deploy time. It can't be edited here.
          </span>
        </Callout>
      ) : null}
      {roster?.truncated || roster?.incomplete ? (
        <Callout tone="warning">
          {[
            roster.truncated
              ? "Showing the first 500 members and 500 invites."
              : "",
            roster.incomplete
              ? "Some people couldn't be listed. Reload to try again."
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
        </Callout>
      ) : null}
      {view.isError && !roster ? (
        <ErrorState
          error={view.error}
          onRetry={() => void view.refetch()}
          thing="Members"
          context={{ thing: "members" }}
        />
      ) : (
        <DataTable<MemberRow>
          id="platform-members"
          caption="Members"
          data={rows}
          columns={columns}
          getRowId={(r) => r.id}
          rowLabel={(r) =>
            r.kind === "member"
              ? r.member.name || r.member.email
              : r.invite.email
          }
          rowActions={rowActions}
          facets={facets}
          search={{
            placeholder: "Search by name or email",
            columns: ["member"],
          }}
          state={state}
          onStateChange={setState}
          loading={view.isPending}
          exportCsv={false}
          mobile="cards"
          cardsBelowRem={64}
          flatCards
          filtersOneRow
          mobileCard={(r) => (
            <StackedRow row={r} group={group} productName={productName} />
          )}
          chrome="minimal"
          empty={
            <EmptyState
              kind="first-run"
              title="No members to show"
              description="Invite people to give them access to the console."
            />
          }
        />
      )}
      <InviteDrawer
        open={drawer !== null && (drawer.member === null || !!editingMember)}
        member={editingMember}
        onReopen={(member) => setDrawer({ member })}
        onClose={() => setDrawer(null)}
        me={me}
        members={roster?.members ?? []}
        products={products}
        productName={productName}
        writeReason={write.disabledReason}
      />
      <RemoveMemberDialog
        memberId={removing}
        members={roster?.members ?? []}
        me={me}
        productName={productName}
        onClose={() => setRemoving(null)}
      />
      <RevokeInviteDialog
        invite={revoking}
        productName={productName}
        onClose={() => setRevoking(null)}
      />
    </CollectionTemplate>
  );
}
