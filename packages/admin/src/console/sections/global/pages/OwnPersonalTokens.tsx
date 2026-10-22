/**
 * Personal tokens, Yours tab (`#/personal-tokens`, ST-34.11): the signed-in member's own `pkeyp_`
 * tokens in both scopes. An `admin` token is what `pkey login` made for a terminal; a `packages`
 * token reads the packages their licenses include and is made in Account → Packages (the portal).
 *
 * Revoke is an L1 confirm for a packages token and an L2 for an admin one, and says what stops.
 * The label `pkey login` writes is "pkey on <host>", so the host is read back from it. A v1 cookie
 * names no account: the list answers 409 `reauth` and the page says to sign in again.
 */

import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, ApiError, type OwnPersonalToken } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import {
  DataTable,
  type DataColumn,
  type Facet,
  type RowActionItem,
} from "../../../../ui/data-table/index.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { intentOf } from "../../core/pages/confirmGate.js";

export function useMyPersonalTokens(): UseQueryResult<OwnPersonalToken[]> {
  return useQuery({
    queryKey: qk.myPersonalTokens(),
    queryFn: () => api.myPersonalTokens().then((r) => r.tokens),
    // A v1 cookie's answer is permanent for the session: do not retry it.
    retry: (n, e) => !(e instanceof ApiError && e.status === 409) && n < 2,
  });
}

/** The host a `pkey login` token was made on, from its label "pkey on <host>"; else null. */
export function hostOfLabel(label: string): string | null {
  const m = /^pkey on (.+)$/.exec(label);
  return m ? m[1]!.trim() || null : null;
}

const SCOPE_TAG: Record<OwnPersonalToken["scope"], string> = {
  admin: "Admin",
  "packages:read": "Packages",
};

const STATUS_PILL: Record<
  OwnPersonalToken["status"],
  { tone: "success" | "warning" | "neutral"; label: string }
> = {
  active: { tone: "success", label: "Active" },
  expired: { tone: "warning", label: "Expired" },
  revoked: { tone: "neutral", label: "Revoked" },
};

const FACETS: Facet<OwnPersonalToken>[] = [
  {
    id: "status",
    label: "Status",
    options: Object.entries(STATUS_PILL).map(([value, { label }]) => ({
      value,
      label,
    })),
    accessor: (t) => t.status,
  },
];

const COLUMNS: DataColumn<OwnPersonalToken>[] = [
  {
    id: "label",
    header: "Token",
    accessorFn: (t) => t.label,
    meta: { priority: 1, primary: true, alwaysVisible: true, label: "Token" },
    cell: ({ row }) => (
      <span className="inline-flex min-w-0 max-w-[18rem] flex-col">
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
    id: "scope",
    header: "Scope",
    accessorFn: (t) => SCOPE_TAG[t.scope] ?? t.scope,
    meta: { priority: 1, label: "Scope" },
    cell: ({ row }) => (
      <StatusPill tone={row.original.scope === "admin" ? "info" : "neutral"}>
        {SCOPE_TAG[row.original.scope] ?? row.original.scope}
      </StatusPill>
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
  {
    id: "expiresAt",
    header: "Expires",
    accessorKey: "expiresAt",
    meta: { numeric: true, priority: 2, label: "Expires" },
    cell: ({ row }) =>
      row.original.status === "revoked" && row.original.revokedAt !== null ? (
        <span>
          Revoked <Timestamp at={fromSeconds(row.original.revokedAt)} />
        </span>
      ) : (
        <Timestamp at={fromSeconds(row.original.expiresAt)} />
      ),
  },
];

/** What the confirm says stops: the CLI on a host, or installs. */
export function revokeCopy(t: OwnPersonalToken): {
  action: "ownToken.revokeAdmin" | "ownToken.revokePackages";
  consequences: string[];
} {
  if (t.scope === "admin") {
    const host = hostOfLabel(t.label);
    return {
      action: "ownToken.revokeAdmin",
      consequences: [
        host
          ? `pkey on ${host} stops working.`
          : `${t.label} stops working: pkey and any automation using it.`,
        "Run pkey login to sign in again.",
      ],
    };
  }
  return {
    action: "ownToken.revokePackages",
    consequences: [
      `Installs using ${t.label} stop within 30 seconds.`,
      "Make a new one in Account → Packages.",
    ],
  };
}

export function OwnPersonalTokens(): React.ReactElement {
  const tokens = useMyPersonalTokens();
  const [state, setState] = useTableUrlState("own-personal-tokens", {
    facets: ["status"],
  });
  const [revoking, setRevoking] = React.useState<OwnPersonalToken | null>(null);
  const rowActions = (t: OwnPersonalToken): RowActionItem[] =>
    t.status === "revoked"
      ? []
      : [{ label: "Revoke…", tone: "danger", onSelect: () => setRevoking(t) }];
  const reauth =
    tokens.error instanceof ApiError &&
    tokens.error.status === 409 &&
    tokens.error.code === "reauth";
  const copy = revoking ? revokeCopy(revoking) : null;
  if (tokens.isError && !tokens.data) {
    return reauth ? (
      <EmptyState
        kind="not-found"
        title="Sign in again to see your tokens"
        description="This session can't tell which tokens are yours. Sign out and back in."
        primaryAction={
          <Button
            variant="outline"
            onClick={() =>
              void mutate("logout").finally(() => {
                window.location.href = "/manage/login?signedOut=1";
              })
            }
          >
            Sign out
          </Button>
        }
      />
    ) : (
      <ErrorState
        error={tokens.error}
        onRetry={() => void tokens.refetch()}
        context={{ thing: "your tokens" }}
      />
    );
  }
  return (
    <>
      <DataTable<OwnPersonalToken>
        id="own-personal-tokens"
        caption="Your personal tokens"
        data={tokens.data ?? []}
        columns={COLUMNS}
        getRowId={(t) => t.id}
        rowLabel={(t) => t.label}
        rowActions={rowActions}
        facets={FACETS}
        search={{ placeholder: "Search label", columns: ["label"] }}
        state={state}
        onStateChange={setState}
        loading={tokens.isPending}
        exportCsv={false}
        mobile="cards"
        empty={
          <EmptyState
            kind="first-run"
            title="No tokens yet"
            description="Run pkey login in a terminal for an admin token, or make a packages token in Account → Packages."
            docs={docsUrl("packageFeeds")}
          />
        }
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        intent={copy ? intentOf(copy.action) : "neutral"}
        title={`Revoke ${revoking?.label ?? "token"}?`}
        consequences={copy?.consequences}
        confirmLabel="Revoke token"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("revokeMyPersonalToken", revoking!.id);
          toast.success("Token revoked");
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
    </>
  );
}
