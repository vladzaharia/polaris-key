/**
 * Core → Users (I-12; S-16 §5.2). Every product has one, whatever its Identity toggle: the
 * Polaris Key account is platform-level and licences of every product attach to it.
 *
 * - A row is one pairwise subject of THIS product (`ps_…`), never the account: the server never
 *   sends the account id, the account's sign-in methods, or anything of another product.
 * - With Identity on the table adds the sign-in columns (signed-in devices, last sign-in); with it
 *   off they are absent, not empty.
 * - Search is the server's: a subject prefix, a licence id, or a buyer email prefix (the
 *   developer's own records), never the account's own email.
 * - The record is a page (`users/:subject[/:tab]`, `UserRecord`).
 */

import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  api,
  type ProductUserSummary,
  type ProductUsersPage,
} from "../../../api.js";
import { formatCount, fromSeconds } from "../../../lib/format.js";
import {
  DataTable,
  type DataColumn,
  type RowActionItem,
} from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { PageHeader } from "../../components/PageHeader.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { Link, navigate } from "../../router.js";
import { r } from "../../routes.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { UserRecord } from "./UserRecord.js";

const PAGE_SIZE = 50;

/** Where a contact email came from, said once in the cell. */
export function contactNote(
  source: ProductUserSummary["contactSource"],
): string | null {
  if (source === "license") return "From the license";
  if (source === "consented") return "Shared by the user";
  return null;
}

export function UsersPage({
  slug,
  subject,
  tab,
}: {
  slug: string;
  subject?: string;
  tab?: string;
}): React.ReactElement {
  if (subject) return <UserRecord slug={slug} subject={subject} tab={tab} />;
  return <UsersCollection slug={slug} />;
}

function UsersCollection({ slug }: { slug: string }): React.ReactElement {
  const [state, setState] = useTableUrlState("users", { facets: [] });
  const q = state.q.trim();

  const list = useInfiniteQuery(
    {
      queryKey: [...qk.users(slug), "list", q],
      queryFn: ({ pageParam }) =>
        api.productUsers(slug, {
          ...(q ? { q } : {}),
          limit: PAGE_SIZE,
          cursor: pageParam,
        }),
      initialPageParam: null as string | null,
      getNextPageParam: (last: ProductUsersPage) =>
        last.nextCursor ?? undefined,
    },
    queryClient,
  );
  useLoadingAnnouncement("users", list.isPending);

  const rows = React.useMemo(
    () => list.data?.pages.flatMap((p) => p.users) ?? [],
    [list.data],
  );
  const identityOn = list.data?.pages[0]?.identityOn ?? false;

  const columns = React.useMemo<DataColumn<ProductUserSummary>[]>(() => {
    const cols: DataColumn<ProductUserSummary>[] = [
      {
        id: "subject",
        header: "User",
        accessorFn: (u) => u.subject,
        meta: { priority: 1, primary: true, mono: true },
        cell: ({ row }) => (
          <span className="truncate font-mono text-xs">
            {row.original.subject}
          </span>
        ),
      },
      {
        id: "contact",
        header: "Contact",
        accessorFn: (u) => u.contactEmail ?? "",
        meta: { priority: 1 },
        cell: ({ row }) => {
          const u = row.original;
          if (!u.contactEmail)
            return <span className="text-fg-muted">None shared</span>;
          return (
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{u.contactEmail}</span>
              <span className="truncate text-xs text-fg-muted">
                {contactNote(u.contactSource)}
              </span>
            </span>
          );
        },
      },
      {
        id: "licenses",
        header: "Licenses",
        accessorKey: "licenses",
        meta: { priority: 1, numeric: true },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatCount(row.original.licenses)}
          </span>
        ),
      },
      {
        id: "devices",
        header: "Devices",
        accessorKey: "devices",
        meta: { priority: 2, numeric: true },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatCount(row.original.devices)}
          </span>
        ),
      },
    ];
    if (identityOn) {
      cols.push({
        id: "lastSignIn",
        header: "Last sign-in",
        accessorFn: (u) => u.lastSignInAt ?? 0,
        meta: { priority: 2, numeric: true },
        cell: ({ row }) =>
          row.original.lastSignInAt ? (
            <Timestamp at={fromSeconds(row.original.lastSignInAt)} />
          ) : (
            <span className="text-fg-muted">Never</span>
          ),
      });
    }
    cols.push({
      id: "createdAt",
      header: "First seen",
      accessorKey: "createdAt",
      meta: { priority: 3, numeric: true },
      cell: ({ row }) => <Timestamp at={fromSeconds(row.original.createdAt)} />,
    });
    return cols;
  }, [identityOn]);

  const rowHref = (u: ProductUserSummary): string => r.user(slug, u.subject);

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Users"
          description="People who hold a license of this product or signed in to it. Each has an id of their own for this product only."
          refetching={list.isRefetching}
        />
      }
    >
      <DataTable<ProductUserSummary>
        id="users"
        caption="Users"
        data={rows}
        columns={columns}
        getRowId={(u) => u.subject}
        rowLabel={(u) => u.contactEmail ?? u.subject}
        rowHref={rowHref}
        linkComponent={Link}
        rowActions={(u) =>
          [
            { label: "Open", onSelect: () => navigate(rowHref(u)) },
            {
              label: "Open licenses",
              onSelect: () => navigate(r.user(slug, u.subject, "licenses")),
            },
          ] satisfies RowActionItem[]
        }
        search={{
          placeholder: "User id, license id or email starts with…",
          columns: ["subject", "contact"],
        }}
        state={state}
        onStateChange={setState}
        loading={list.isPending}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        pagination={{
          mode: "cursor",
          onLoadMore: () => void list.fetchNextPage(),
          hasMore: list.hasNextPage,
          loadingMore: list.isFetchingNextPage,
        }}
        empty={
          q ? undefined : (
            <EmptyState
              kind="first-run"
              title="No users yet"
              description={
                identityOn
                  ? "A user appears here once they hold a license of this product or sign in to it."
                  : "A user appears here once a license of this product is in their Polaris Key account."
              }
              docs="/docs/admin/users/"
            />
          )
        }
        mobile="cards"
      />
    </CollectionTemplate>
  );
}
