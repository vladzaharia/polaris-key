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
 * A token is shown once, in a dialog that also renders the setup. A licensee can create their own
 * read tokens in the portal; those are listed here too. The platform scope has no Create: team
 * members install with their personal token.
 *
 * Revoke is L2 and needs Ship edit; Revoke all is L3 (the owner's slug typed). After a revoke
 * focus moves to the next row's actions, never `<body>`.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban, Plus } from "lucide-react";
import { type RegistryTokensDto } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { DataTable } from "../../../../ui/data-table/index.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { OneTimeSecretDialog } from "../../../../ui/OneTimeSecretPanel.js";
import { toast } from "../../../../ui/toast.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { mutate } from "../../../data/mutations.js";
import { useBreakGlassReason, useWriteGate } from "../../../access/useCan.js";
import { useProduct } from "../../../data/hooks.js";
import { registryTokensQuery } from "../data.js";
import { r } from "../../../routes.js";
import { intentOf } from "../../core/pages/confirmGate.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import { FeedNav } from "./FeedsArea.js";
import { MintDialog, MintedSnippets, TOKEN_ENV } from "./RegistryTokenMint.js";
import {
  columns,
  dateOf,
  serviceRow,
  TokenCard,
  type MintedRow,
  type TokenRow,
} from "./registryTokenRows.js";
import { type FeedScope } from "../model/model.js";

export function useRegistryTokens(scope: FeedScope, licenseId?: string) {
  return useQuery(registryTokensQuery(scope, licenseId));
}

/**
 * Who may do what here. Revoking and creating need Ship edit (the route's area); a service token
 * also needs Keys, like CI tokens, so without Keys only a publish token can be created.
 */
function useTokenGates(
  scope: FeedScope,
  data: RegistryTokensDto | undefined,
  failed: boolean,
): { revokeReason: string | undefined; mintReason: string | undefined } {
  const slug = scope.kind === "product" ? scope.slug : null;
  const ship = useWriteGate(slug === null ? "platform" : "ship", slug);
  const keys = useWriteGate("keys", slug);
  const noMint = useBreakGlassReason();
  const publishable = (data?.limits.publishEcosystems ?? []).length > 0;
  return {
    revokeReason: ship.disabledReason,
    mintReason:
      noMint ??
      (!data
        ? failed
          ? "Couldn't load tokens"
          : "Loading"
        : !ship.allowed
          ? ship.disabledReason
          : keys.allowed || publishable
            ? undefined
            : keys.disabledReason),
  };
}

/** What a token is called in the toast and the shown-once dialog. */
function kindOf(t: TokenRow): string {
  if (t.service) return "Service token";
  if (t.legacy) return "Legacy token";
  if (t.scopes.includes("publish")) return "Publish token";
  return "Registry token";
}

/** "2 service tokens and 1 legacy token": a count per kind, none for zero. */
function breakdown(live: TokenRow[]): { parts: string; licensee: number } {
  const n = (f: (t: TokenRow) => boolean) => live.filter(f).length;
  const licensee = (t: TokenRow) => t.createdBy.startsWith("portal:");
  const counts: [number, string][] = [
    [n((t) => !!t.service), "service"],
    [n((t) => !!t.legacy && !t.service), "legacy"],
    [n((t) => t.scopes.includes("publish") && !t.service), "publish"],
    [
      n(
        (t) =>
          !t.service &&
          !t.legacy &&
          t.binding !== "license" &&
          !t.scopes.includes("publish"),
      ),
      "registry",
    ],
    [
      n(
        (t) =>
          !t.service &&
          t.binding === "license" &&
          !t.scopes.includes("publish") &&
          !licensee(t),
      ),
      "license",
    ],
  ];
  const parts = counts
    .filter(([c]) => c > 0)
    .map(([c, k]) => `${c} ${k} token${c === 1 ? "" : "s"}`);
  const joined =
    parts.length > 1
      ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
      : (parts[0] ?? "");
  return { parts: joined, licensee: n(licensee) };
}

/** The table, the mint dialog, the shown-once dialog and the revoke dialogs, for one scope. */
function TokensTable({
  scope,
  licenseId,
  minting,
  onMintingChange,
  revokingAll,
  onRevokingAllChange,
  returnFocus,
}: {
  scope: FeedScope;
  licenseId?: string;
  minting: boolean;
  onMintingChange: (open: boolean) => void;
  revokingAll: boolean;
  onRevokingAllChange: (open: boolean) => void;
  /** Where focus goes when the shown-once dialog closes: the page's New token… button. */
  returnFocus: React.RefObject<HTMLElement | null>;
}): React.ReactElement {
  const query = useRegistryTokens(scope, licenseId);
  const gates = useTokenGates(scope, query.data, query.isError);
  const [minted, setMinted] = React.useState<MintedRow | null>(null);
  const [revoking, setRevoking] = React.useState<TokenRow | null>(null);
  const [showEnded, setShowEnded] = React.useState(false);
  const box = React.useRef<HTMLDivElement>(null);
  const forLicense = licenseId !== undefined;
  const cols = React.useMemo(() => columns(forLicense), [forLicense]);
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
  const ended = rows.filter((t) => t.status !== "active");
  // Ended tokens fold away while any token is active; an all-ended list shows them.
  const endedNoun = ended.every((t) => t.status === "revoked")
    ? "revoked"
    : "ended";
  const folded = !showEnded && live.length > 0 && ended.length > 0;
  const shown = folded ? live : rows;
  const service = licenseId === undefined && scope.kind === "product";
  const owner = query.data?.owner ?? "";
  const productName =
    useProduct(scope.kind === "product" ? scope.slug : null).data?.name ??
    owner;
  const now = Date.now();

  /** Focus the next row's actions (or the previous one's, or New token…), never `<body>`. */
  const refocus = (before: string[], id: string): void => {
    window.setTimeout(() => {
      const at = before.indexOf(id);
      const order = [
        ...before.slice(at + 1),
        ...before.slice(0, Math.max(at, 0)).reverse(),
      ];
      const rowEls = Array.from(
        box.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
      );
      for (const rowId of order) {
        const el = rowEls
          .find((e) => e.getAttribute("data-row-id") === rowId)
          ?.querySelector<HTMLElement>('button[aria-label^="Actions for"]');
        if (el) return el.focus();
      }
      (returnFocus.current ?? box.current)?.focus();
    }, 150);
  };
  const revokeConfirmed = async (t: TokenRow): Promise<void> => {
    const before = Array.from(
      box.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
    ).map((el) => el.getAttribute("data-row-id") ?? "");
    await mutate("revokeRegistryToken", scope, t.tokenId);
    toast.success(`${kindOf(t)} revoked`);
    await query.refetch();
    refocus(before, t.tokenId);
  };

  const sums = breakdown(live);
  // The empty state's command names the first private feed (a service token is for those).
  const firstPrivate = (query.data?.feeds ?? []).find(
    (f) => f.enabled && f.accessMode !== "public" && f.ecosystem !== "godot",
  );
  return (
    <div ref={box} tabIndex={-1} className="space-y-4 outline-none">
      {scope.kind === "platform" && rows.length > 0 ? (
        <Callout tone="info">
          Team members install with their personal token. The tokens here work
          until they expire, and you can revoke them.
        </Callout>
      ) : null}
      <DataTable<TokenRow>
        id={`registry-tokens-${scope.kind}${licenseId ? "-license" : ""}`}
        caption={service ? "Service tokens" : "Registry tokens"}
        data={shown}
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
                  ...(gates.revokeReason
                    ? { disabledReason: gates.revokeReason }
                    : {}),
                },
              ]
            : []
        }
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        exportCsv={false}
        mobile="cards"
        cardBreakpoint="(max-width: 63.99em)"
        mobileCard={(t, primary) => (
          <TokenCard
            row={t}
            primary={primary}
            now={now}
            forLicense={forLicense}
          />
        )}
        search={
          rows.length > 20
            ? { placeholder: "Search tokens", columns: ["token"] }
            : undefined
        }
        toolbarActions={
          ended.length > 0 && live.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowEnded(!showEnded)}
            >
              {`${showEnded ? "Hide" : "Show"} ${ended.length} ${endedNoun}`}
            </Button>
          ) : undefined
        }
        empty={
          licenseId ? (
            <EmptyState
              kind="first-run"
              variant="inline"
              headingLevel={3}
              title="No registry tokens"
              description="Tokens bound to this license appear here, whether an operator or the licensee created them."
            />
          ) : service ? (
            <EmptyState
              kind="first-run"
              variant="inline"
              headingLevel={3}
              title={`Give CI and servers read access to ${productName}'s private feeds`}
              description={
                firstPrivate ? (
                  <span className="block min-w-0 max-w-[calc(100vw-3rem)] space-y-2">
                    <span className="block">
                      Create a service token, then print each client's setup:
                    </span>
                    <CodeBlock
                      code={`pkey feeds setup --ecosystem ${firstPrivate.ecosystem} --owner ${owner} --token-env ${TOKEN_ENV}`}
                      language="sh"
                      copy
                    />
                  </span>
                ) : (
                  "Create a service token for when a feed turns private. Public feeds need none."
                )
              }
            />
          ) : (
            <EmptyState
              kind="first-run"
              variant="inline"
              headingLevel={3}
              title="No registry tokens"
              description={
                <span>
                  Team members install with their personal token. See{" "}
                  <a className="underline" href={r.personalTokens()}>
                    Personal tokens
                  </a>
                  .
                </span>
              }
            />
          )
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
        title={`${minted ? kindOf(minted.view) : "Registry token"} created`}
        description={
          minted
            ? `${minted.view.label} · expires ${dateOf(minted.view.expiresAt)}`
            : undefined
        }
        label={minted ? kindOf(minted.view) : "Registry token"}
        value={minted?.token ?? ""}
        hint={
          minted?.view.service
            ? `Shown once. Add it to your CI secrets as ${TOKEN_ENV}.`
            : "Shown once. The setup below already holds it."
        }
        details={
          minted && query.data ? (
            <MintedSnippets data={query.data} minted={minted} />
          ) : null
        }
        onDone={() => {
          setMinted(null);
          window.setTimeout(() => returnFocus.current?.focus(), 150);
        }}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        intent={intentOf("registryToken.revoke")}
        title={`Revoke ${revoking?.label ?? "token"}?`}
        consequences={[
          "Clients presenting it are refused within 30 seconds.",
          "A revoked token cannot be restored; create a new one instead.",
        ]}
        confirmLabel="Revoke token"
        describeError={(e) => errorCopy(e)}
        onConfirm={() => revokeConfirmed(revoking!)}
      />
      <ConfirmDialog
        open={revokingAll}
        onOpenChange={onRevokingAllChange}
        intent={intentOf("registryToken.revokeAll")}
        title={
          licenseId
            ? "Revoke every token of this license?"
            : live.length === 1
              ? "Revoke the 1 active token?"
              : `Revoke all ${live.length} active tokens?`
        }
        consequences={[
          ...(sums.parts
            ? [
                `${sums.parts} stop${live.length - sums.licensee === 1 ? "s" : ""} working within 30 seconds.`,
              ]
            : []),
          ...(sums.licensee > 0
            ? [
                `${sums.licensee} token${sums.licensee === 1 ? "" : "s"} a licensee created in Polaris Locker stop${sums.licensee === 1 ? "s" : ""} too.`,
              ]
            : []),
          service
            ? "CI and servers can't install from private feeds until they get a new service token."
            : "Clients of private feeds need a new token.",
        ]}
        typedConfirmation={{
          // The object on screen: the license on its panel, else the product.
          value: licenseId ?? owner,
          label: "Type to confirm:",
        }}
        confirmLabel="Revoke all"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          const res = await mutate("revokeAllRegistryTokens", scope, licenseId);
          toast.success(
            `${res.revoked} token${res.revoked === 1 ? "" : "s"} revoked`,
          );
        }}
      />
    </div>
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
  const newToken = React.useRef<HTMLButtonElement>(null);
  const query = useRegistryTokens(scope);
  const gates = useTokenGates(scope, query.data, query.isError);
  const anyLive = [
    ...(query.data?.tokens ?? []),
    ...(query.data?.serviceTokens ?? []),
  ].some((t) => t.status === "active");
  const product = scope.kind === "product";
  return (
    <div className="space-y-6">
      <PageHeader
        title={product ? "Service tokens" : "Registry tokens"}
        description={
          product
            ? "For CI and servers that install from private feeds."
            : "Tokens for private feeds on the platform's registry."
        }
        primaryAction={
          product ? (
            <Button
              ref={newToken}
              iconStart={<Plus aria-hidden />}
              onClick={() => setMinting(true)}
              disabledReason={gates.mintReason}
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
            ...(gates.revokeReason
              ? { disabledReason: gates.revokeReason }
              : anyLive
                ? {}
                : { disabledReason: "No active token" }),
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
        <TokensTable
          scope={scope}
          minting={minting}
          onMintingChange={setMinting}
          revokingAll={revokingAll}
          onRevokingAllChange={setRevokingAll}
          returnFocus={newToken}
        />
      )}
    </div>
  );
}

/** The licence page's Registry tokens panel: this licence's tokens, created here or in the portal. */
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
  const newToken = React.useRef<HTMLButtonElement>(null);
  const query = useRegistryTokens(scope, licenseId);
  const gates = useTokenGates(scope, query.data, query.isError);
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
              returnFocus={newToken}
            />
          </div>
        }
      >
        <span className="flex flex-wrap justify-end gap-2">
          <Button
            ref={newToken}
            variant="outline"
            size="sm"
            iconStart={<Plus aria-hidden />}
            onClick={() => setMinting(true)}
            disabledReason={gates.mintReason}
          >
            New token…
          </Button>
          <Button
            variant="outline"
            size="sm"
            iconStart={<Ban aria-hidden />}
            onClick={() => setRevokingAll(true)}
            disabledReason={
              gates.revokeReason ?? (anyLive ? undefined : "No active token")
            }
          >
            Revoke all…
          </Button>
        </span>
      </SettingsRow>
    </SettingsSection>
  );
}
