/**
 * Registry tokens (F-21, plans/F-20.md §6.5): the `pkeyr_` credentials package-feed clients
 * present on the registry host, in three places with one component set:
 *
 * - **Distribution → Package feeds → Tokens** (`#/p/:slug/distribution/feeds/tokens`): the
 *   product's tokens, owner-bound or bound to one of its licences;
 * - **Platform → Package feeds → Tokens** (`#/platform/feeds/tokens`): the system product's;
 * - **the licence page's Registry tokens panel**: one licence's tokens (`LicenseRegistryTokens`).
 *
 * A token is shown once, in a dialog that also renders every client's setup with the real value
 * (`setupSnippets` with a `token` credential). Revoking is L2; Revoke all needs confirmation.
 * A licensee can mint their own read tokens in the portal; those are listed here too.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Ban,
  BadgeCheck,
  Building2,
  Gamepad2,
  KeyRound,
  Plus,
} from "lucide-react";
import {
  api,
  type FeedEcosystem,
  type MintedRegistryToken,
  type RegistryTokenDto,
  type RegistryTokensDto,
} from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { fromSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { CodeBlock } from "../../../ui/CodeBlock.js";
import { Combobox } from "../../../ui/Combobox.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { FormField } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { NumberInput } from "../../../ui/NumberInput.js";
import { OneTimeSecretDialog } from "../../../ui/OneTimeSecretPanel.js";
import { RadioCards } from "../../../ui/RadioCards.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Switch } from "../../../ui/Switch.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { PageHeader } from "../../components/PageHeader.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { intentOf } from "../../pages/core/confirmGate.js";
import { SettingsRow, SettingsSection } from "../../templates/Settings.js";
import { useLicenses } from "../../pages/license/shared.js";
import { FeedNav } from "./FeedsArea.js";
import {
  ECOSYSTEMS,
  ECOSYSTEM_ICONS,
  ECOSYSTEM_LABELS,
  setupSnippets,
  type FeedScope,
} from "./model.js";

export function fetchRegistryTokens(
  scope: FeedScope,
  licenseId?: string,
): Promise<RegistryTokensDto> {
  return api.registryTokens(scope, licenseId);
}

export function useRegistryTokens(scope: FeedScope, licenseId?: string) {
  return useQuery(
    {
      queryKey: qk.pkgFeedTokens(scope, licenseId ?? ""),
      queryFn: () => fetchRegistryTokens(scope, licenseId),
    },
    queryClient,
  );
}

const STATUS_PILL: Record<
  RegistryTokenDto["status"],
  { tone: "success" | "neutral"; label: string }
> = {
  active: { tone: "success", label: "Active" },
  expired: { tone: "neutral", label: "Expired" },
  revoked: { tone: "neutral", label: "Revoked" },
};

/** Who minted a token, in words: an operator's address, or "Portal" for a licensee. */
function creatorOf(t: RegistryTokenDto): string {
  if (t.createdBy.startsWith("admin:")) return t.createdBy.slice(6);
  if (t.createdBy.startsWith("portal:")) return "Licensee, in the portal";
  return t.createdBy;
}

function FeedList({
  ecosystems,
}: {
  ecosystems: RegistryTokenDto["ecosystems"];
}): React.ReactElement {
  if (ecosystems === null)
    return (
      <StatusPill tone="neutral" icon={null} size="sm">
        Every feed
      </StatusPill>
    );
  return (
    <span className="flex flex-wrap gap-1">
      {ecosystems.map((e) => {
        const Icon = ECOSYSTEM_ICONS[e] ?? KeyRound;
        return (
          <StatusPill key={e} tone="neutral" size="sm" icon={Icon}>
            {ECOSYSTEM_LABELS[e] ?? e}
          </StatusPill>
        );
      })}
    </span>
  );
}

function columns(withBinding: boolean): DataColumn<RegistryTokenDto>[] {
  const cols: DataColumn<RegistryTokenDto>[] = [
    {
      id: "token",
      header: "Token",
      accessorFn: (t) => t.label,
      meta: { priority: 1, primary: true, label: "Token" },
      cell: ({ row }) => {
        const t = row.original;
        const Icon = t.presentation === "url" ? Gamepad2 : KeyRound;
        return (
          <span className="inline-flex min-w-0 items-center gap-2">
            <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
            <span className="inline-flex min-w-0 flex-col">
              <span className="truncate">{t.label}</span>
              <span className="font-mono text-xs text-fg-muted">
                {t.tokenId} · …{t.hint}
              </span>
            </span>
          </span>
        );
      },
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
      id: "feeds",
      header: "Feeds",
      accessorFn: (t) => (t.ecosystems ?? ["*"]).join(","),
      meta: { priority: 2, label: "Feeds" },
      enableSorting: false,
      cell: ({ row }) => <FeedList ecosystems={row.original.ecosystems} />,
    },
  ];
  if (withBinding)
    cols.push({
      id: "binding",
      header: "Bound to",
      accessorFn: (t) => t.licenseId ?? "owner",
      meta: { priority: 2, label: "Bound to" },
      cell: ({ row }) =>
        row.original.binding === "license" ? (
          <span className="inline-flex items-center gap-1.5">
            <BadgeCheck aria-hidden className="size-4 text-fg-muted" />
            <span className="font-mono text-xs">{row.original.licenseId}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <Building2 aria-hidden className="size-4 text-fg-muted" />
            Owner
          </span>
        ),
    });
  cols.push(
    {
      id: "createdBy",
      header: "Created by",
      accessorFn: (t) => creatorOf(t),
      meta: { priority: 3, label: "Created by" },
    },
    {
      id: "expiresAt",
      header: "Expires",
      accessorKey: "expiresAt",
      meta: { priority: 2, label: "Expires" },
      cell: ({ row }) => <Timestamp at={fromSeconds(row.original.expiresAt)} />,
    },
    {
      id: "lastUsedAt",
      header: "Last used",
      accessorFn: (t) => t.lastUsedAt ?? 0,
      meta: { priority: 3, label: "Last used" },
      cell: ({ row }) =>
        row.original.lastUsedAt ? (
          <Timestamp at={fromSeconds(row.original.lastUsedAt)} />
        ) : (
          <span className="text-fg-muted">Never</span>
        ),
    },
  );
  return cols;
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
  const [revoking, setRevoking] = React.useState<RegistryTokenDto | null>(null);
  const cols = React.useMemo(
    () => columns(licenseId === undefined),
    [licenseId],
  );
  const live = (query.data?.tokens ?? []).filter((t) => t.status === "active");
  return (
    <>
      <DataTable<RegistryTokenDto>
        id={`registry-tokens-${scope.kind}${licenseId ? "-license" : ""}`}
        caption="Registry tokens"
        data={query.data?.tokens ?? []}
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
            title="No registry tokens"
            description={
              licenseId
                ? "Tokens bound to this licence appear here, whether an operator or the licensee minted them."
                : "A client of a feed that is not public presents one. Public feeds need none."
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
        title="Registry token created"
        description={
          minted
            ? `Token ${minted.view.tokenId}, expiring ${new Date(minted.view.expiresAt * 1000).toLocaleDateString()}.`
            : undefined
        }
        label="Registry token"
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
          toast.success("Registry token revoked");
        }}
      />
      <ConfirmDialog
        open={revokingAll}
        onOpenChange={onRevokingAllChange}
        intent={intentOf("registryToken.revokeAll")}
        title={
          licenseId
            ? "Revoke every token of this licence?"
            : "Revoke every registry token?"
        }
        consequences={[
          `${live.length} active token${live.length === 1 ? "" : "s"} stop${live.length === 1 ? "s" : ""} working within 30 seconds, including those licensees minted in the portal.`,
          "Clients of feeds that are not public need a new token.",
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

/** Every client's setup for the feeds the new token reaches, with the real value. */
function MintedSnippets({
  data,
  minted,
}: {
  data: RegistryTokensDto;
  minted: MintedRegistryToken;
}): React.ReactElement {
  const reach = minted.view.ecosystems;
  const feeds = data.feeds.filter(
    (f) =>
      f.enabled &&
      f.baseUrl !== null &&
      (reach === null || reach.includes(f.ecosystem)),
  );
  if (feeds.length === 0)
    return (
      <Callout tone="info" title="No enabled feed to set up yet">
        The token works once a feed it reaches is enabled.
      </Callout>
    );
  return (
    <div className="space-y-4">
      {feeds.map((f) => {
        const Icon = ECOSYSTEM_ICONS[f.ecosystem];
        const snippets = setupSnippets(
          f.ecosystem,
          { baseUrl: f.baseUrl!, owner: data.owner, namespace: {} },
          minted.view.presentation === "url"
            ? { kind: "godot-url", value: minted.token }
            : { kind: "token", value: minted.token },
        );
        return (
          <section key={f.ecosystem} className="space-y-2">
            <h3 className="inline-flex items-center gap-2 text-sm font-bold text-fg-strong">
              <Icon aria-hidden className="size-4 text-fg-muted" />
              {f.label}
            </h3>
            {snippets.map((s) => (
              <div key={s.title} className="space-y-1">
                <p className="text-xs text-fg-muted">{s.title}</p>
                <CodeBlock
                  code={s.code}
                  language={s.language}
                  filename={s.filename}
                  copy
                />
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** The licences of a product, to bind a token to one (rendered only when binding a licence). */
function LicensePicker({
  slug,
  value,
  onChange,
}: {
  slug: string;
  value: string | null;
  onChange: (v: string | null) => void;
}): React.ReactElement {
  const licenses = useLicenses(slug);
  return (
    <FormField
      name="licenseId"
      label="Licence"
      required
      value={value}
      onChange={(v: string | null) => onChange(v)}
    >
      {(f) => (
        <Combobox
          {...f}
          options={(licenses.data?.licenses ?? []).map((l) => ({
            value: l.id,
            label: l.name || l.email || l.id,
            secondary: l.id,
          }))}
          placeholder={
            licenses.isPending ? "Loading licences…" : "Choose a licence"
          }
          searchPlaceholder="Search licences"
          emptyText="No licence matches."
        />
      )}
    </FormField>
  );
}

function MintDialog({
  scope,
  data,
  licenseId,
  open,
  onOpenChange,
  onMinted,
}: {
  scope: FeedScope;
  data: RegistryTokensDto;
  /** Fixed binding: the licence page mints for its licence only. */
  licenseId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMinted: (m: MintedRegistryToken) => void;
}): React.ReactElement {
  const [label, setLabel] = React.useState("");
  const [everyFeed, setEveryFeed] = React.useState(true);
  const [picked, setPicked] = React.useState<FeedEcosystem[]>([]);
  const [godotUrl, setGodotUrl] = React.useState(false);
  const [days, setDays] = React.useState<number | null>(
    data.limits.defaultDays,
  );
  const [binding, setBinding] = React.useState<"owner" | "license">(
    licenseId ? "license" : "owner",
  );
  const [license, setLicense] = React.useState<string | null>(
    licenseId ?? null,
  );
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  React.useEffect(() => {
    if (!open) return;
    setLabel("");
    setEveryFeed(true);
    setPicked([]);
    setGodotUrl(false);
    setDays(data.limits.defaultDays);
    setBinding(licenseId ? "license" : "owner");
    setLicense(licenseId ?? null);
    setFailure(null);
  }, [open, data.limits.defaultDays, licenseId]);
  React.useEffect(() => {
    setDays(godotUrl ? data.limits.urlDefaultDays : data.limits.defaultDays);
  }, [godotUrl, data.limits.urlDefaultDays, data.limits.defaultDays]);

  const { minDays, maxDays } = data.limits;
  const daysError =
    days === null || !Number.isInteger(days) || days < minDays || days > maxDays
      ? `Use a whole number of days from ${minDays} to ${maxDays}.`
      : undefined;
  const labelError =
    label.trim() === "" || label.trim().length > 64
      ? "Give the token a label of up to 64 characters."
      : undefined;
  const feedsError =
    !godotUrl && !everyFeed && picked.length === 0
      ? "Choose at least one feed."
      : undefined;
  const licenseError =
    binding === "license" && !license ? "Choose a licence." : undefined;
  const invalid = !!(daysError || labelError || feedsError || licenseError);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving || invalid) return;
    setSaving(true);
    setFailure(null);
    try {
      const res = await mutate("mintRegistryToken", scope, {
        label: label.trim(),
        binding,
        ...(binding === "license" ? { licenseId: license! } : {}),
        expiresInDays: days!,
        ...(godotUrl
          ? { presentation: "url" as const }
          : { ecosystems: everyFeed ? null : picked }),
      });
      onMinted(res);
    } catch (err) {
      setFailure(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!saving) onOpenChange(o);
      }}
      dismissible={!saving}
      title="New registry token"
      description="Read access to this owner's feeds. Shown once; Polaris Key stores only its hash."
    >
      <form onSubmit={submit} noValidate>
        <DialogBody className="space-y-4">
          <FormField
            name="label"
            label="Label"
            required
            value={label}
            onChange={(v: string) => setLabel(v)}
            error={label === "" ? undefined : labelError}
          >
            {(f) => <Input {...f} maxLength={64} />}
          </FormField>
          {licenseId === undefined && scope.kind === "product" ? (
            <FormField
              name="binding"
              label="Bound to"
              group
              value={binding}
              onChange={(v: string) => setBinding(v as "owner" | "license")}
            >
              {(f) => (
                <RadioCards<string>
                  {...f}
                  columns={2}
                  options={[
                    {
                      value: "owner",
                      label: "This product",
                      description:
                        "Passes every access mode, entitled included.",
                      icon: <Building2 aria-hidden className="size-4" />,
                    },
                    {
                      value: "license",
                      label: "One licence",
                      description:
                        "Works while the licence is active; entitled needs its flag.",
                      icon: <BadgeCheck aria-hidden className="size-4" />,
                    },
                  ]}
                />
              )}
            </FormField>
          ) : null}
          {binding === "license" &&
          licenseId === undefined &&
          scope.kind === "product" ? (
            <LicensePicker
              slug={scope.slug}
              value={license}
              onChange={setLicense}
            />
          ) : null}
          <Switch
            label="Godot editor URL"
            description="The editor sends no credentials, so this token goes in its URL: Godot feeds only, read only."
            checked={godotUrl}
            onCheckedChange={setGodotUrl}
          />
          {!godotUrl ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-bold text-fg-strong">
                Feeds
              </legend>
              <Checkbox
                label="Every feed"
                description="Today's and any this owner enables later."
                checked={everyFeed}
                onCheckedChange={setEveryFeed}
              />
              {!everyFeed ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {ECOSYSTEMS.map((e) => {
                    const Icon = ECOSYSTEM_ICONS[e];
                    return (
                      <Checkbox
                        key={e}
                        label={
                          <span className="inline-flex items-center gap-1.5">
                            <Icon aria-hidden className="size-4" />
                            {ECOSYSTEM_LABELS[e]}
                          </span>
                        }
                        checked={picked.includes(e)}
                        onCheckedChange={(on) =>
                          setPicked(
                            on ? [...picked, e] : picked.filter((x) => x !== e),
                          )
                        }
                      />
                    );
                  })}
                </div>
              ) : null}
              {feedsError ? (
                <p className="text-xs text-danger">{feedsError}</p>
              ) : null}
            </fieldset>
          ) : null}
          <FormField
            name="expiresInDays"
            label="Expires after"
            className="w-44"
            required
            value={days}
            onChange={(v: number | null) => setDays(v)}
            error={daysError}
          >
            {(f) => (
              <NumberInput
                {...f}
                integer
                nullable
                min={minDays}
                max={maxDays}
                unit="days"
              />
            )}
          </FormField>
          {failure ? (
            <Callout tone="danger" title={errorCopy(failure).title}>
              {errorCopy(failure).description}
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={invalid}>
            Create token
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
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
  const anyLive = (query.data?.tokens ?? []).some((t) => t.status === "active");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<FeedNav scope={scope} current="tokens" />}
        title="Registry tokens"
        description={
          query.data?.registryOrigin
            ? `For clients of feeds that are not public, on ${new URL(query.data.registryOrigin).host}.`
            : undefined
        }
        primaryAction={
          <Button
            iconStart={<Plus aria-hidden />}
            onClick={() => setMinting(true)}
            disabledReason={query.data ? undefined : "Loading"}
          >
            New token…
          </Button>
        }
        dangerActions={[
          {
            label: "Revoke all…",
            icon: <Ban aria-hidden />,
            onSelect: () => setRevokingAll(true),
            ...(anyLive ? {} : { disabledReason: "No active token" }),
          },
        ]}
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
        />
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
        help="Tokens bound to this licence work while it is active."
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
