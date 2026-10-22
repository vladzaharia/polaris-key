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
import { LogIn } from "lucide-react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, ApiError, type OwnPersonalToken } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
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
import { CopyButton } from "../../../../ui/CopyButton.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { r } from "../../../routes.js";
import { qk } from "../../../data/queries.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { intentOf } from "../../core/pages/confirmGate.js";
import {
  AccountPackagesLink,
  PackagesNote,
  ScopeTag,
  TokenCard,
  TokenCell,
  STATUS_PILL,
  expiresColumn,
  focusActionsAfter,
  lastUsedColumn,
  revokeCopy,
  scopeName,
} from "./personalTokenParts.js";

export function useMyPersonalTokens(): UseQueryResult<OwnPersonalToken[]> {
  return useQuery({
    queryKey: qk.myPersonalTokens(),
    queryFn: () => api.myPersonalTokens().then((r) => r.tokens),
    // A v1 cookie's answer is permanent for the session: do not retry it.
    retry: (n, e) => !(e instanceof ApiError && e.status === 409) && n < 2,
  });
}

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

/** Token, Scope, Status, Last used, Expires: the same order as Everyone, less its Account. */
const COLUMNS: DataColumn<OwnPersonalToken>[] = [
  {
    id: "label",
    header: "Token",
    accessorFn: (t) => t.label,
    meta: { priority: 1, primary: true, alwaysVisible: true, label: "Token" },
    cell: ({ row }) => <TokenCell t={row.original} />,
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
  lastUsedColumn<OwnPersonalToken>(),
  expiresColumn<OwnPersonalToken>(),
];

export function OwnPersonalTokens(): React.ReactElement {
  const tokens = useMyPersonalTokens();
  // Two tables share the page's query across the tabs: each keeps its own keys.
  const [state, setState] = useTableUrlState("yours", {
    facets: ["status"],
    namespace: true,
  });
  const [revoking, setRevoking] = React.useState<OwnPersonalToken | null>(null);
  const rowActions = (t: OwnPersonalToken): RowActionItem[] =>
    t.status === "active"
      ? [{ label: "Revoke…", tone: "danger", onSelect: () => setRevoking(t) }]
      : [];
  const reauth =
    tokens.error instanceof ApiError &&
    tokens.error.status === 409 &&
    tokens.error.code === "reauth";
  const copy = revoking ? revokeCopy(revoking) : null;
  if (tokens.isError && !tokens.data) {
    return reauth ? (
      <Callout
        tone="info"
        title="Sign in again to see your tokens"
        action={
          <Button
            iconStart={<LogIn aria-hidden />}
            onClick={() =>
              void mutate("logout").finally(() => {
                window.location.href = `/manage/login?returnTo=${encodeURIComponent(`/manage/${r.personalTokens()}`)}`;
              })
            }
          >
            Sign in again
          </Button>
        }
      >
        Your session is older than this page.
      </Callout>
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
        id="yours"
        caption="Personal tokens"
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
        mobileCard={(t, primary) => <TokenCard t={t} primary={primary} />}
        empty={
          <EmptyState
            kind="first-run"
            title="No personal tokens yet"
            description={
              <>
                Sign in from a terminal with{" "}
                <span className="inline-flex items-center gap-1 align-middle">
                  <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">
                    pkey login
                  </code>
                  <CopyButton value="pkey login" label="Copy pkey login" />
                </span>
                , or{" "}
                <AccountPackagesLink>
                  create a personal token
                </AccountPackagesLink>{" "}
                for installs.
              </>
            }
            docs={docsUrl("cliReference")}
          />
        }
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        intent={copy ? intentOf(copy.action) : "neutral"}
        title={
          <span className="text-balance">{copy?.title ?? "Revoke token?"}</span>
        }
        consequences={copy?.consequences}
        confirmLabel="Revoke token"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("revokeMyPersonalToken", revoking!.id);
          toast.success("Token revoked");
          focusActionsAfter(tokens.data ?? [], revoking!.id);
        }}
      >
        {copy?.packagesNote ? <PackagesNote /> : null}
      </ConfirmDialog>
    </>
  );
}
