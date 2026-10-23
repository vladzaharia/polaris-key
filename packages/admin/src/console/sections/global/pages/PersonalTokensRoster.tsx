/**
 * Personal tokens, Everyone tab (`#/personal-tokens`, F-33; ST-34.11 moved the page header and the
 * tabs to `PersonalTokens.tsx`): the `pkeyp_` tokens people hold, with whose they
 * are, their last use and expiry, and Revoke.
 *
 * A Superadmin lists and revokes; the person creates their own, in Account → Packages (the portal),
 * so there is no mint here. The page holds no secret: the list carries a label and the token's last
 * four characters, never the token or its hash. Revoking is L2 and immediate (the registry host
 * drops it within 30 seconds on every isolate), and the row stays so the history does.
 */

import * as React from "react";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { type AdminPersonalToken } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
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
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { fromSeconds } from "../../../../lib/format.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteGate } from "../../../access/useCan.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { intentOf } from "../../core/pages/confirmGate.js";
import {
  AccountPackagesLink,
  PackagesNote,
  ScopeTag,
  STATUS_PILL,
  TokenCard,
  TokenCell,
  expiresColumn,
  focusActionsAfter,
  lastUsedColumn,
  revokeCopy,
  scopeName,
} from "./personalTokenParts.js";
import { globalReads } from "../data.js";

export function usePersonalTokens(): UseQueryResult<AdminPersonalToken[]> {
  return useQuery({
    ...globalReads.personalTokens(),
  });
}

const STATUS_FACET: Facet<AdminPersonalToken> = {
  id: "status",
  label: "Status",
  options: Object.entries(STATUS_PILL).map(([value, { label }]) => ({
    value,
    label,
  })),
  accessor: (t) => t.status,
};

/** Who ended a revoked token: the "by …" the Expires cell used to carry. */
const REVOKED_BY: Record<string, string> = {
  manual: "owner",
  admin: "admin",
  account_deleted: "account erasure",
  access_removed: "access removal",
};

const emailOf = (t: AdminPersonalToken): React.ReactNode =>
  t.email ? (
    <span
      dir="ltr"
      className="inline-block max-w-full align-bottom [overflow-wrap:anywhere]"
      title={t.email}
    >
      {t.email}
    </span>
  ) : (
    <span className="text-fg-muted">Erased</span>
  );

/** Token, Account, Scope, Status, Last used, Expires: Yours' order with Account after Token. */
const COLUMNS: DataColumn<AdminPersonalToken>[] = [
  {
    id: "label",
    header: "Token",
    accessorFn: (t) => t.label,
    meta: { priority: 1, primary: true, alwaysVisible: true, label: "Token" },
    cell: ({ row }) => <TokenCell t={row.original} />,
  },
  {
    id: "email",
    header: "Account",
    accessorFn: (t) => t.email ?? "",
    meta: { priority: 1, label: "Account" },
    cell: ({ row }) => emailOf(row.original),
  },
  {
    id: "scope",
    header: "Scope",
    accessorFn: (t) => scopeName(t.scope),
    meta: { priority: 1, label: "Scope" },
    cell: ({ row }) => <ScopeTag scope={row.original.scope} />,
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
  lastUsedColumn<AdminPersonalToken>(),
  {
    ...expiresColumn<AdminPersonalToken>(),
    // A revoked token also says who ended it.
    cell: ({ row }) =>
      row.original.status === "revoked" && row.original.revokedAt !== null ? (
        <span className="inline-flex flex-col items-end text-end">
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
];

export function PersonalTokensRoster(): React.ReactElement {
  const tokens = usePersonalTokens();
  const queryClient = useQueryClient();
  const statusesRef = React.useRef<ReadonlyMap<string, string>>(new Map());
  statusesRef.current = new Map(
    (tokens.data ?? []).map((t) => [t.id, t.status]),
  );
  useLoadingAnnouncement("Personal tokens", tokens.isPending);
  const write = useWriteGate("platform");
  const [state, setState] = useTableUrlState("everyone", {
    facets: ["status"],
    namespace: true,
  });
  const [revoking, setRevoking] = React.useState<AdminPersonalToken | null>(
    null,
  );
  const rowActions = (t: AdminPersonalToken): RowActionItem[] =>
    t.status === "active"
      ? [
          {
            label: "Revoke…",
            tone: "danger",
            onSelect: () => setRevoking(t),
            disabledReason: write.disabledReason,
          },
        ]
      : [];
  const copy = revoking ? revokeCopy(revoking, revoking.email) : null;
  return (
    <>
      {tokens.isError && !tokens.data ? (
        <ErrorState
          error={tokens.error}
          onRetry={() => void tokens.refetch()}
          context={{ thing: "Personal tokens" }}
        />
      ) : (
        <DataTable<AdminPersonalToken>
          id="everyone"
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
          mobileCard={(t, primary) => (
            <TokenCard
              t={t}
              primary={primary}
              extra={<p className="text-xs text-fg-muted">{emailOf(t)}</p>}
            />
          )}
          empty={
            <EmptyState
              kind="first-run"
              title="No personal tokens"
              description={
                <>
                  People make them with{" "}
                  <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">
                    pkey login
                  </code>{" "}
                  or in <AccountPackagesLink />.
                </>
              }
              docs={docsUrl("cliReference")}
            />
          }
        />
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        intent={intentOf("apiToken.revoke")}
        title={
          <span className="text-balance">{copy?.title ?? "Revoke token?"}</span>
        }
        consequences={copy?.consequences}
        confirmLabel="Revoke token"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("revokePersonalToken", revoking!.id);
          toast.success("Token revoked");
          void focusActionsAfter(
            queryClient.invalidateQueries({ queryKey: qk.personalTokens() }),
            () => statusesRef.current,
            revoking!.id,
          );
        }}
      >
        {copy?.packagesNote ? <PackagesNote owner={revoking?.email} /> : null}
      </ConfirmDialog>
    </>
  );
}
