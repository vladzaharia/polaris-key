/**
 * Personal tokens (`#/personal-tokens`, F-33): the `pkeyp_` tokens people hold, with whose they
 * are, their last use and expiry, and Revoke.
 *
 * A Superadmin lists and revokes; the person creates their own, in Account → Packages (the portal),
 * so there is no mint here. The page holds no secret: the list carries a label and the token's last
 * four characters, never the token or its hash. Revoking is L2 and immediate (the registry host
 * drops it within 30 seconds on every isolate), and the row stays so the history does.
 */

import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, type AdminPersonalToken } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { fromSeconds } from "../../../../lib/format.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
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
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteGate } from "../../../access/useCan.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { intentOf } from "../../core/pages/confirmGate.js";

export function usePersonalTokens(): UseQueryResult<AdminPersonalToken[]> {
  return useQuery({
    queryKey: qk.personalTokens(),
    queryFn: () => api.personalTokens().then((r) => r.tokens),
  });
}

const STATUS_PILL: Record<
  AdminPersonalToken["status"],
  { tone: "success" | "warning" | "neutral"; label: string }
> = {
  active: { tone: "success", label: "Active" },
  expired: { tone: "warning", label: "Expired" },
  revoked: { tone: "neutral", label: "Revoked" },
};

const STATUS_FACET: Facet<AdminPersonalToken> = {
  id: "status",
  label: "Status",
  options: Object.entries(STATUS_PILL).map(([value, { label }]) => ({
    value,
    label,
  })),
  accessor: (t) => t.status,
};

/** `revokeReason` as a person reads it: who ended the token. */
const REVOKED_BY: Record<string, string> = {
  manual: "owner",
  admin: "admin",
  account_deleted: "account erasure",
  access_removed: "access removal",
};

const COLUMNS: DataColumn<AdminPersonalToken>[] = [
  {
    id: "label",
    header: "Token",
    accessorFn: (t) => t.label,
    meta: { priority: 1, primary: true, alwaysVisible: true, label: "Token" },
    cell: ({ row }) => (
      <span className="inline-flex min-w-0 max-w-[16rem] flex-col">
        <span
          className="truncate max-sm:whitespace-normal max-sm:break-words"
          title={row.original.label}
        >
          {row.original.label}
        </span>
        <span className="font-mono text-xs text-fg-muted">
          pkeyp_…{row.original.hint}
        </span>
      </span>
    ),
  },
  {
    id: "email",
    header: "Account",
    accessorFn: (t) => t.email ?? "",
    meta: { priority: 1, label: "Account" },
    cell: ({ row }) =>
      row.original.email ? (
        <span
          className="inline-block max-w-[16rem] truncate align-bottom max-sm:max-w-none max-sm:whitespace-normal max-sm:break-all"
          title={row.original.email}
        >
          {row.original.email}
        </span>
      ) : (
        <span className="text-fg-muted">Erased</span>
      ),
  },
  {
    id: "status",
    header: "Status",
    accessorFn: (t) => t.status,
    meta: { priority: 1, label: "Status" },
    cell: ({ row }) => (
      <StatusPill tone={STATUS_PILL[row.original.status].tone}>
        {STATUS_PILL[row.original.status].label}
      </StatusPill>
    ),
  },
  {
    id: "expiresAt",
    header: "Expires",
    accessorKey: "expiresAt",
    meta: { numeric: true, priority: 2, label: "Expires" },
    // A revoked token's own expiry no longer matters: say when and by whom it ended.
    cell: ({ row }) =>
      row.original.status === "revoked" && row.original.revokedAt !== null ? (
        <span className="inline-flex flex-col items-end text-right">
          <span>
            Revoked <Timestamp at={fromSeconds(row.original.revokedAt)} />
          </span>
          <span className="text-xs text-fg-muted">
            by {REVOKED_BY[row.original.revokeReason ?? ""] ?? "owner"}
          </span>
        </span>
      ) : (
        <Timestamp at={fromSeconds(row.original.expiresAt)} />
      ),
  },
  {
    id: "lastUsedAt",
    header: "Last used",
    accessorFn: (t) => t.lastUsedAt ?? 0,
    meta: { numeric: true, priority: 2, label: "Last used" },
    cell: ({ row }) =>
      row.original.lastUsedAt === null ? (
        <span className="text-fg-muted">Never</span>
      ) : (
        <Timestamp at={fromSeconds(row.original.lastUsedAt)} />
      ),
  },
];

export function PersonalTokens(): React.ReactElement {
  const tokens = usePersonalTokens();
  useLoadingAnnouncement("Personal tokens", tokens.isPending);
  const write = useWriteGate("platform");
  const [state, setState] = useTableUrlState("personal-tokens", {
    facets: ["status"],
  });
  const [revoking, setRevoking] = React.useState<AdminPersonalToken | null>(
    null,
  );
  const rowActions = (t: AdminPersonalToken): RowActionItem[] =>
    t.status === "revoked"
      ? []
      : [
          {
            label: "Revoke…",
            tone: "danger",
            onSelect: () => setRevoking(t),
            disabledReason: write.disabledReason,
          },
        ];
  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Personal tokens"
          description={
            <>
              Read-only package tokens people created in their account. You can
              revoke one; only its owner can create it.{" "}
              <a
                className="underline underline-offset-2 hover:text-fg-strong"
                href={docsUrl("packageFeeds")}
                target="_blank"
                rel="noreferrer"
              >
                Learn more
              </a>
            </>
          }
          refetching={tokens.isFetching && !tokens.isPending}
        />
      }
    >
      {tokens.isError && !tokens.data ? (
        <ErrorState
          error={tokens.error}
          onRetry={() => void tokens.refetch()}
          context={{ thing: "personal tokens" }}
        />
      ) : (
        <DataTable<AdminPersonalToken>
          id="personal-tokens"
          caption="Personal tokens"
          data={tokens.data ?? []}
          columns={COLUMNS}
          getRowId={(t) => t.id}
          rowLabel={(t) => t.label}
          rowActions={rowActions}
          facets={[STATUS_FACET]}
          search={{
            placeholder: "Search label or account",
            columns: ["label", "email"],
          }}
          state={state}
          onStateChange={setState}
          loading={tokens.isPending}
          exportCsv={false}
          mobile="cards"
          empty={
            <EmptyState
              kind="first-run"
              title="No personal tokens"
              description="People create them in Account → Packages."
              docs={docsUrl("packageFeeds")}
            />
          }
        />
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        intent={intentOf("apiToken.revoke")}
        title={`Revoke ${revoking?.label ?? "token"}?`}
        consequences={[
          `Installs using it stop within 30 seconds${revoking?.email ? `, for ${revoking.email}` : ""}.`,
          "A revoked token cannot be restored: its owner creates a new one.",
        ]}
        confirmLabel="Revoke token"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("revokePersonalToken", revoking!.id);
          toast.success("Personal token revoked");
          // The dialog closes onto nothing: the next row's Actions button takes focus.
          const at = (tokens.data ?? []).findIndex(
            (t) => t.id === revoking!.id,
          );
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const buttons = document.querySelectorAll<HTMLElement>(
                'table button[aria-label^="Actions for"]',
              );
              (
                buttons[Math.min(Math.max(at, 0), buttons.length - 1)] ??
                document.querySelector<HTMLElement>("h1")
              )?.focus();
            }),
          );
        }}
      />
    </CollectionTemplate>
  );
}
