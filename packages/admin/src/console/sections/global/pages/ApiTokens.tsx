/**
 * API tokens (`#/tokens`): the deployment's machine credential for the admin API (`pkeya_…`, what
 * `pkey bundle` presents), listed, minted and revoked.
 *
 * Platform-scoped like the registry: a token belongs to the deployment, not to a product, and the
 * worker gates the whole surface on the Platform area and on a console SESSION (a token cannot
 * list, mint or revoke a token, including itself). A token is shown once, in `MintApiTokenFlow`,
 * which owns the plaintext; this page holds none of it, and the list is read from the server
 * after every write. Revoking is L2: a revoked token cannot be restored, only replaced, and its
 * row stays so the history survives.
 */

import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  api,
  type AdminApiToken,
  type AdminApiTokenStatus,
} from "../../../../api.js";
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
import { MintApiTokenFlow } from "../components/MintApiTokenFlow.js";

export function fetchApiTokens(): Promise<AdminApiToken[]> {
  return api.apiTokens().then((r) => r.tokens);
}

export function useApiTokens(): UseQueryResult<AdminApiToken[]> {
  return useQuery({ queryKey: qk.apiTokens(), queryFn: fetchApiTokens });
}

/** Active, expired and revoked each read differently: the list's whole triage value. */
const STATUS_PILL: Record<
  AdminApiTokenStatus,
  { tone: "success" | "warning" | "neutral"; label: string }
> = {
  active: { tone: "success", label: "Active" },
  expired: { tone: "warning", label: "Expired" },
  revoked: { tone: "neutral", label: "Revoked" },
};

const STATUS_FACET: Facet<AdminApiToken> = {
  id: "status",
  label: "Status",
  options: Object.entries(STATUS_PILL).map(([value, { label }]) => ({
    value,
    label,
  })),
  accessor: (t) => t.status,
};

const COLUMNS: DataColumn<AdminApiToken>[] = [
  {
    id: "label",
    header: "Token",
    accessorFn: (t) => t.label,
    meta: { priority: 1, primary: true, alwaysVisible: true, label: "Token" },
    cell: ({ row }) => (
      <span className="inline-flex min-w-0 flex-col">
        <span className="truncate">{row.original.label}</span>
        <span className="font-mono text-xs text-fg-muted">
          {row.original.id}
        </span>
      </span>
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
    id: "scopes",
    header: "Scopes",
    accessorFn: (t) => t.scopes.join(" "),
    enableSorting: false,
    meta: { priority: 2, label: "Scopes" },
    cell: ({ row }) =>
      // A row whose scope list would not parse can call nothing: say so, rather than an empty
      // cell that reads like "unrestricted".
      row.original.scopes.length === 0 ? (
        <span className="text-fg-muted">
          None: this token can't call anything
        </span>
      ) : (
        <span className="font-mono text-xs">
          {row.original.scopes.join(", ")}
        </span>
      ),
  },
  {
    id: "createdAt",
    header: "Created",
    accessorKey: "createdAt",
    meta: { numeric: true, priority: 3, label: "Created" },
    cell: ({ row }) => <Timestamp at={fromSeconds(row.original.createdAt)} />,
  },
  {
    id: "expiresAt",
    header: "Expires",
    accessorKey: "expiresAt",
    meta: { numeric: true, priority: 2, label: "Expires" },
    cell: ({ row }) => <Timestamp at={fromSeconds(row.original.expiresAt)} />,
  },
  {
    id: "lastUsedAt",
    header: "Last used",
    accessorFn: (t) => t.lastUsedAt ?? 0,
    meta: { numeric: true, priority: 2, label: "Last used" },
    // "Never", not a dash: an unused machine credential is a finding, not missing data.
    cell: ({ row }) =>
      row.original.lastUsedAt === null ? (
        <span className="text-fg-muted">Never</span>
      ) : (
        <Timestamp at={fromSeconds(row.original.lastUsedAt)} />
      ),
  },
];

export function ApiTokens(): React.ReactElement {
  const tokens = useApiTokens();
  useLoadingAnnouncement("API tokens", tokens.isPending);
  // ST-29: tokens are the Platform area's, like the rest of the deployment's credentials.
  const write = useWriteGate("platform");
  const [state, setState] = useTableUrlState("api-tokens", {
    facets: ["status"],
  });
  // The ONLY mint-related state this page holds. Deliberately not the secret: see the flow.
  const [minting, setMinting] = React.useState(false);
  const [revoking, setRevoking] = React.useState<AdminApiToken | null>(null);

  // An expired token is still revocable: an operator who no longer trusts a credential should
  // not have to reason about whether its clock already saved them.
  const rowActions = (t: AdminApiToken): RowActionItem[] =>
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
          title="API tokens"
          description={
            <>
              Scoped, individually revocable credentials for build and CI jobs,
              such as <code className="font-mono">pkey bundle</code>. A token
              cannot manage tokens: this page needs your console session.{" "}
              <a
                className="underline underline-offset-2 hover:text-fg-strong"
                href={docsUrl("mintApiToken")}
                target="_blank"
                rel="noreferrer"
              >
                Learn more
              </a>
            </>
          }
          refetching={tokens.isFetching && !tokens.isPending}
          primaryAction={
            <Button
              iconStart={<Plus aria-hidden />}
              onClick={() => setMinting(true)}
              disabledReason={write.disabledReason}
            >
              New token…
            </Button>
          }
        />
      }
    >
      {tokens.isError && !tokens.data ? (
        <ErrorState
          error={tokens.error}
          onRetry={() => void tokens.refetch()}
          context={{ thing: "API tokens" }}
        />
      ) : (
        <DataTable<AdminApiToken>
          id="api-tokens"
          caption="API tokens"
          data={tokens.data ?? []}
          columns={COLUMNS}
          getRowId={(t) => t.id}
          rowLabel={(t) => t.label}
          rowActions={rowActions}
          facets={[STATUS_FACET]}
          search={{ placeholder: "Search label or id", columns: ["label"] }}
          state={state}
          onStateChange={setState}
          loading={tokens.isPending}
          exportCsv={false}
          mobile="cards"
          empty={
            <EmptyState
              kind="first-run"
              title="No API tokens"
              description="Mint one to let a build or a CI job call the admin API without an operator's browser session."
              docs={docsUrl("mintApiToken")}
            />
          }
        />
      )}

      {/* Mounted only while minting: unmounting is what destroys the minted secret. */}
      {minting ? <MintApiTokenFlow onClose={() => setMinting(false)} /> : null}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        intent={intentOf("apiToken.revoke")}
        title={`Revoke ${revoking?.label ?? "token"}?`}
        consequences={[
          "Anything using it, such as a CI job or a build script, is refused from its next request.",
          "A revoked token cannot be restored: mint a new one instead.",
          "The row stays in the list, so the history survives.",
        ]}
        confirmLabel="Revoke token"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("revokeApiToken", revoking!.id);
          toast.success("API token revoked");
        }}
      />
    </CollectionTemplate>
  );
}
