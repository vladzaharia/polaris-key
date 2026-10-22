/**
 * Registry tokens (F-21, plans/F-20.md §6.5) and Service tokens (F-33b.4): the credentials
 * package-feed clients present on the registry host, in three places with one component set:
 *
 * - **Distribution → Package feeds → Tokens** (`#/p/:slug/distribution/feeds/tokens`): the
 *   product's **Service tokens**: read `pkeyci_` tokens (F-33b.3), publish `pkeyr_` tokens, the
 *   licence-bound ones, and the retired owner-wide read `pkeyr_` marked Legacy until they expire;
 * - **Platform → Package feeds → Tokens** (`#/platform/feeds/tokens`): the system product's;
 * - **the licence page's Registry tokens panel**: one licence's tokens (`LicenseRegistryTokens`).
 *
 * A token is shown once, in a dialog that also renders every client's setup with the real value
 * (`feedSetupSnippets` with a `token` credential). Revoking is L2; Revoke all needs confirmation.
 * A licensee can mint their own read tokens in the portal; those are listed here too. The
 * platform scope has no Create: team members install with their personal token.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban, Plus } from "lucide-react";
import {
  api,
  type MintedRegistryToken,
  type RegistryTokensDto,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { DataTable } from "../../../../ui/data-table/index.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { OneTimeSecretDialog } from "../../../../ui/OneTimeSecretPanel.js";
import { toast } from "../../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { mutate } from "../../../data/mutations.js";
import { useWriteGate } from "../../../access/useCan.js";
import { qk } from "../../../data/queries.js";
import { intentOf } from "../../core/pages/confirmGate.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import { FeedNav } from "./FeedsArea.js";
import { MintDialog, MintedSnippets } from "./RegistryTokenMint.js";
import {
  columns,
  dateOf,
  serviceRow,
  type TokenRow,
} from "./registryTokenRows.js";
import { feedSetupSnippets, type FeedScope } from "../model/model.js";

export function fetchRegistryTokens(
  scope: FeedScope,
  licenseId?: string,
): Promise<RegistryTokensDto> {
  return api.registryTokens(scope, licenseId);
}

export function useRegistryTokens(scope: FeedScope, licenseId?: string) {
  return useQuery({
    queryKey: qk.pkgFeedTokens(scope, licenseId ?? ""),
    queryFn: () => fetchRegistryTokens(scope, licenseId),
  });
}

/** The table, the mint dialog, the shown-once dialog and the revoke dialogs, for one scope. */
function TokensTable({
  scope,
  licenseId,
  minting,
  onMintingChange,
  revokingAll,
  onRevokingAllChange,
}: {
  scope: FeedScope;
  licenseId?: string;
  minting: boolean;
  onMintingChange: (open: boolean) => void;
  revokingAll: boolean;
  onRevokingAllChange: (open: boolean) => void;
}): React.ReactElement {
  const query = useRegistryTokens(scope, licenseId);
  useLoadingAnnouncement("registry tokens", query.isPending);
  const [minted, setMinted] = React.useState<MintedRegistryToken | null>(null);
  const [revoking, setRevoking] = React.useState<TokenRow | null>(null);
  const cols = React.useMemo(
    () => columns(licenseId === undefined),
    [licenseId],
  );
  const rows = React.useMemo<TokenRow[]>(
    () => [
      ...(licenseId === undefined
        ? (query.data?.serviceTokens ?? []).map(serviceRow)
        : []),
      ...(query.data?.tokens ?? []),
    ],
    [query.data, licenseId],
  );
  const live = rows.filter((t) => t.status === "active");
  const service = licenseId === undefined && scope.kind === "product";
  const noun = service ? "Service token" : "Registry token";
  return (
    <>
      <DataTable<TokenRow>
        id={`registry-tokens-${scope.kind}${licenseId ? "-license" : ""}`}
        caption={service ? "Service tokens" : "Registry tokens"}
        data={rows}
        columns={cols}
        getRowId={(t) => t.tokenId}
        rowLabel={(t) => t.label}
        rowActions={(t) =>
          t.status === "active"
            ? [
                {
                  label: "Revoke…",
                  tone: "danger",
                  onSelect: () => setRevoking(t),
                },
              ]
            : []
        }
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        exportCsv={false}
        mobile="cards"
        empty={
          <EmptyState
            kind="first-run"
            variant="inline"
            headingLevel={3}
            title={service ? "No service tokens" : "No registry tokens"}
            description={
              licenseId
                ? "Tokens bound to this license appear here, whether an operator or the licensee minted them."
                : service
                  ? "CI and servers present one to install from feeds that are not public. Public feeds need none."
                  : "Team members install with their personal token. Public feeds need none."
            }
          />
        }
      />
      {query.data ? (
        <MintDialog
          scope={scope}
          data={query.data}
          licenseId={licenseId}
          open={minting}
          onOpenChange={onMintingChange}
          onMinted={(m) => {
            onMintingChange(false);
            setMinted(m);
          }}
        />
      ) : null}
      <OneTimeSecretDialog
        open={minted !== null}
        onOpenChange={(o) => {
          if (!o) setMinted(null);
        }}
        size="lg"
        title={`${minted?.view.tokenId.startsWith("cit_") ? "Service" : "Registry"} token created`}
        description={
          minted
            ? `Token ${minted.view.tokenId}, expiring ${dateOf(minted.view.expiresAt)}.`
            : undefined
        }
        label={
          minted?.view.tokenId.startsWith("cit_")
            ? "Service token"
            : "Registry token"
        }
        value={minted?.token ?? ""}
        hint="Shown once. Polaris Key stores only its hash. The setup below already holds it."
        details={
          minted && query.data ? (
            <MintedSnippets data={query.data} minted={minted} />
          ) : null
        }
        onDone={() => setMinted(null)}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        intent={intentOf("registryToken.revoke")}
        title={`Revoke ${revoking?.label ?? "token"}?`}
        consequences={[
          "Clients presenting it are refused within 30 seconds.",
          "A revoked token cannot be restored; mint a new one instead.",
        ]}
        confirmLabel="Revoke token"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("revokeRegistryToken", scope, revoking!.tokenId);
          toast.success(`${noun} revoked`);
        }}
      />
      <ConfirmDialog
        open={revokingAll}
        onOpenChange={onRevokingAllChange}
        intent={intentOf("registryToken.revokeAll")}
        title={
          licenseId
            ? "Revoke every token of this license?"
            : service
              ? "Revoke every service token?"
              : "Revoke every registry token?"
        }
        consequences={[
          `${live.length} active token${live.length === 1 ? "" : "s"} stop${live.length === 1 ? "s" : ""} working within 30 seconds, including those licensees minted in Polaris Locker.`,
          service
            ? "Includes service, publish and legacy tokens. CI and servers need a new service token."
            : "Clients of feeds that are not public need a new token.",
        ]}
        confirmLabel="Revoke all"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          const res = await mutate("revokeAllRegistryTokens", scope, licenseId);
          toast.success(
            `${res.revoked} token${res.revoked === 1 ? "" : "s"} revoked`,
          );
        }}
      />
    </>
  );
}

/** Distribution → Package feeds → Tokens, or Platform → Package feeds → Tokens. */
export function RegistryTokensPage({
  scope,
}: {
  scope: FeedScope;
}): React.ReactElement {
  const [minting, setMinting] = React.useState(false);
  const [revokingAll, setRevokingAll] = React.useState(false);
  const query = useRegistryTokens(scope);
  const anyLive = [
    ...(query.data?.tokens ?? []),
    ...(query.data?.serviceTokens ?? []),
  ].some((t) => t.status === "active");
  const product = scope.kind === "product";
  const keys = useWriteGate("keys", product ? scope.slug : null);
  // A member without Keys can still mint a publish token, when the product has a publish feed.
  const mintReason = !query.data
    ? "Loading"
    : keys.allowed || (query.data.limits.publishEcosystems ?? []).length > 0
      ? undefined
      : keys.disabledReason;
  return (
    <div className="space-y-6">
      <PageHeader
        title={product ? "Service tokens" : "Registry tokens"}
        description={
          query.data?.registryOrigin
            ? `For clients of feeds that are not public, on ${new URL(query.data.registryOrigin).host}.`
            : undefined
        }
        primaryAction={
          product ? (
            <Button
              iconStart={<Plus aria-hidden />}
              onClick={() => setMinting(true)}
              disabledReason={mintReason}
            >
              New token…
            </Button>
          ) : undefined
        }
        dangerActions={[
          {
            label: "Revoke all…",
            icon: <Ban aria-hidden />,
            onSelect: () => setRevokingAll(true),
            ...(anyLive ? {} : { disabledReason: "No active token" }),
          },
        ]}
        tabs={<FeedNav scope={scope} current="tokens" />}
        refetching={query.isFetching && !query.isPending}
      />
      {query.isError && !query.data ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          context={{ area: "distribution", thing: "Registry tokens" }}
        />
      ) : (
        <>
          {product ? null : (
            <Callout tone="info">
              Team members install with their personal token. Tokens listed here
              keep working until they expire, and you can revoke them.
            </Callout>
          )}
          <TokensTable
            scope={scope}
            minting={minting}
            onMintingChange={setMinting}
            revokingAll={revokingAll}
            onRevokingAllChange={setRevokingAll}
          />
        </>
      )}
    </div>
  );
}

/** The licence page's Registry tokens panel: this licence's tokens, minted here or in the portal. */
export function LicenseRegistryTokens({
  slug,
  licenseId,
}: {
  slug: string;
  licenseId: string;
}): React.ReactElement {
  const scope = React.useMemo<FeedScope>(
    () => ({ kind: "product", slug }),
    [slug],
  );
  const [minting, setMinting] = React.useState(false);
  const [revokingAll, setRevokingAll] = React.useState(false);
  const query = useRegistryTokens(scope, licenseId);
  const anyLive = (query.data?.tokens ?? []).some((t) => t.status === "active");
  return (
    <SettingsSection id="license-registry-tokens" title="Registry tokens">
      <SettingsRow
        label="Package feeds"
        help="Tokens bound to this license work while it is active."
        footer={
          <div className="mt-4">
            <TokensTable
              scope={scope}
              licenseId={licenseId}
              minting={minting}
              onMintingChange={setMinting}
              revokingAll={revokingAll}
              onRevokingAllChange={setRevokingAll}
            />
          </div>
        }
      >
        <span className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            iconStart={<Plus aria-hidden />}
            onClick={() => setMinting(true)}
            disabledReason={query.data ? undefined : "Loading"}
          >
            New token…
          </Button>
          <Button
            variant="outline"
            size="sm"
            iconStart={<Ban aria-hidden />}
            onClick={() => setRevokingAll(true)}
            disabledReason={anyLive ? undefined : "No active token"}
          >
            Revoke all…
          </Button>
        </span>
      </SettingsRow>
    </SettingsSection>
  );
}
