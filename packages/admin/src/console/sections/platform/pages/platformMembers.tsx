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
import { Lock, Mail, UserPlus } from "lucide-react";
import { api, type Member, type MemberInvite } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import {
  DataTable,
  type DataColumn,
  type Facet,
  type RowActionItem,
} from "../../../../ui/data-table/index.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { RoleTags } from "../../../access/RoleTag.js";
import { useWriteGate } from "../../../access/useCan.js";
import { qk } from "../../../data/queries.js";
import { useMe } from "../../../data/hooks.js";
import { navigate, useRoute } from "../../../router.js";
import { PageTabs } from "../../../components/PageTabs.js";
import { PlatformRoles } from "./platformRoles.js";
import { r as routes } from "../../../routes.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { InviteDialog } from "./platformMembersInvite.js";
import {
  EditRolesDialog,
  RemoveMemberDialog,
  RevokeInviteDialog,
} from "./platformMembersDialogs.js";
import {
  cannotTake,
  initialsOf,
  productOfScope,
  rowsOf,
  visibleRoles,
  type MemberRow,
} from "./platformMembersModel.js";

type ProductName = (slug: string) => string;

function Avatar({
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

/** One "Access from" line per distinct source of a member's roles. */
function accessLines(
  m: Member,
  group: string | null,
  productName: ProductName,
): React.ReactNode[] {
  const seen = new Set<string>();
  const lines: React.ReactNode[] = [];
  for (const r of m.roles) {
    const by = r.grantedBy?.name ?? null;
    const key = `${r.source}:${by ?? ""}:${r.grantedAt ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.source === "root")
      lines.push(
        <span
          key={key}
          className="inline-flex items-center gap-1.5 min-[1440px]:whitespace-nowrap"
        >
          <Lock className="size-3.5 shrink-0" aria-hidden="true" />
          Root rule
          {group ? <code className="font-mono text-xs">{group}</code> : null}
        </span>,
      );
    else if (r.source === "creator") {
      const slug = productOfScope(r.scope);
      lines.push(
        <span key={key}>
          Created {slug ? productName(slug) : "a product"}
          {r.grantedAt ? <Dated at={r.grantedAt} /> : null}
        </span>,
      );
    } else
      lines.push(
        <span key={key}>
          {r.source === "invite" ? "Invite from " : "Added by "}
          {by ?? "a former member"}
          {r.grantedAt ? <Dated at={r.grantedAt} /> : null}
        </span>,
      );
  }
  return lines;
}

function Dated({ at }: { at: number }): React.ReactElement {
  return (
    <span className="ms-1.5 text-fg-muted max-sm:hidden">
      <Timestamp at={fromSeconds(at)} format="date" />
    </span>
  );
}

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
  const [inviting, setInviting] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<Member | null>(null);
  const [revoking, setRevoking] = React.useState<MemberInvite | null>(null);

  const products = React.useMemo(
    () => (me?.products ?? []).map((p) => ({ slug: p.slug, name: p.name })),
    [me?.products],
  );
  const productName = React.useCallback<ProductName>(
    (slug) => products.find((p) => p.slug === slug)?.name ?? slug,
    [products],
  );
  const group = view.data?.rootRule.group ?? null;
  const rows = React.useMemo(() => rowsOf(view.data), [view.data]);
  const editingMember =
    view.data?.members.find((m) => m.memberId === editing) ?? null;

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
          <span className="flex min-w-0 max-w-[22rem] items-center gap-3 max-sm:max-w-none">
            <Avatar name={name} email={email} pending={r.kind === "invite"} />
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="truncate font-medium text-fg-strong max-sm:whitespace-normal max-sm:break-words"
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
              {name ? (
                <span
                  className="truncate text-xs text-fg-muted max-sm:whitespace-normal max-sm:break-all"
                  title={email}
                >
                  {email}
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
      accessorFn: (r) =>
        r.kind === "member"
          ? r.member.roles.map((x) => x.role).join(" ")
          : r.invite.role,
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
        if (r.kind === "invite")
          return (
            <span className="flex flex-col gap-0.5 min-[1440px]:whitespace-nowrap text-sm">
              <span>
                Invited by {r.invite.invitedBy?.name ?? "a former member"}
                <Dated at={r.invite.sentAt} />
              </span>
              {r.invite.expiresAt ? (
                <span className="text-xs text-fg-muted">
                  Expires{" "}
                  <Timestamp
                    at={fromSeconds(r.invite.expiresAt)}
                    format="relative"
                  />
                </span>
              ) : null}
            </span>
          );
        return (
          <span className="flex flex-col gap-0.5 min-[1440px]:whitespace-nowrap text-sm">
            {accessLines(r.member, group, productName).map((l, i) => (
              <span key={i}>{l}</span>
            ))}
          </span>
        );
      },
    },
    {
      id: "lastSignIn",
      header: "Last sign-in",
      accessorFn: (r) =>
        r.kind === "member" ? (r.member.lastSignInAt ?? 0) : 0,
      meta: { priority: 2, numeric: true, label: "Last sign-in" },
      cell: ({ row }) => {
        const r = row.original;
        if (r.kind === "invite")
          return <span className="tabular-nums text-fg-muted">Not yet</span>;
        return r.member.lastSignInAt ? (
          <Timestamp at={fromSeconds(r.member.lastSignInAt)} />
        ) : (
          <span className="tabular-nums text-fg-muted">Never</span>
        );
      },
    },
  ];

  const rowActions = (r: MemberRow): RowActionItem[] => {
    if (r.kind === "invite") {
      const why = cannotTake(me, {
        ...r.invite,
        source: "invite",
        bindingId: r.invite.bindingId,
        grantedBy: null,
        grantedAt: r.invite.sentAt,
      });
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
    const stuck = m.roles.some(
      (x) => x.bindingId !== null && cannotTake(me, x) !== undefined,
    );
    const removeWhy = write.disabledReason
      ? write.disabledReason
      : hasRoot
        ? `In the root rule${group ? ` (${group})` : ""}. Take them out of the group at your identity provider.`
        : stuck
          ? "Only a Superadmin can remove a Superadmin, a Platform admin or an All products admin."
          : undefined;
    return [
      {
        label: "Edit roles…",
        onSelect: () => setEditing(m.memberId),
        disabledReason: write.disabledReason,
      },
      {
        label: "Remove from console…",
        tone: "danger",
        onSelect: () => setRemoving(m),
        disabledReason: removeWhy,
      },
      { type: "separator" },
      {
        label: "Show activity",
        onSelect: () => {
          navigate(routes.platformActivity({ actor: m.memberId }));
        },
      },
    ];
  };

  const roster = view.data;
  const onRoles = useRoute().query.get("tab") === "roles";
  const tabs = (
    <PageTabs
      label="Members"
      value={onRoles ? "roles" : "members"}
      items={[
        {
          value: "members",
          label: "Members",
          to: routes.platformMembers(),
          ...(roster
            ? {
                count: new Intl.NumberFormat("en").format(
                  roster.members.length,
                ),
              }
            : {}),
        },
        {
          value: "roles",
          label: "Roles",
          to: routes.platformMembers({ tab: "roles" }),
        },
      ]}
    />
  );
  if (onRoles)
    return (
      <CollectionTemplate
        header={
          <PageHeader
            title="Members"
            description="Everyone who can sign in to the console, and the roles they hold."
            refetching={view.isFetching && !view.isPending}
            tabs={tabs}
          />
        }
      >
        <PlatformRoles
          view={roster}
          loading={view.isPending}
          error={view.isError ? view.error : null}
          onRetry={() => void view.refetch()}
        />
      </CollectionTemplate>
    );
  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Members"
          description="Everyone who can sign in to the console, and the roles they hold."
          refetching={view.isFetching && !view.isPending}
          tabs={tabs}
          primaryAction={
            <Button
              variant="primary"
              iconStart={<UserPlus className="size-4" aria-hidden="true" />}
              disabledReason={write.disabledReason}
              disabled={!write.allowed}
              onClick={() => setInviting(true)}
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
      {roster?.truncated ? (
        <Callout tone="warning">
          The list is cut. Search to find someone who isn't shown.
        </Callout>
      ) : null}
      {roster?.incomplete ? (
        <Callout tone="warning">
          Some people couldn't be listed. Reload to try again.
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
          chrome="minimal"
          empty={
            <EmptyState
              kind="first-run"
              title="No one has a role yet"
              description="Invite people to give them access to the console."
              primaryAction={
                <Button
                  variant="primary"
                  disabled={!write.allowed}
                  disabledReason={write.disabledReason}
                  onClick={() => setInviting(true)}
                >
                  Invite people
                </Button>
              }
            />
          }
        />
      )}
      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        me={me}
        members={roster?.members ?? []}
        products={products}
        productName={productName}
      />
      <EditRolesDialog
        member={editingMember}
        me={me}
        products={products}
        productName={productName}
        onClose={() => setEditing(null)}
      />
      <RemoveMemberDialog
        member={removing}
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
