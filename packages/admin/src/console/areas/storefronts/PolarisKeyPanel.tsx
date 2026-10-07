/**
 * Distribution → Storefronts → Polaris Key (PS-06; notes/S-21 §6.6, SETUP.md §2.10's Discover
 * tab): the built-in storefront's own page, T4 (label and help left, the control right-aligned).
 *
 *   Readiness           PS-01's checklist, from the first-party `status` op
 *   Listing             Automatic / Listed / Not listed, and the audience
 *   Ways to add         one switch per way the product's policy configures (absent otherwise)
 *   Group labels        one row per mapped group: the label Discover shows
 *   Who can see this?   the offered ways in plain words, and a persona simulator
 *   Last 28 days        impressions, adds and first activations, per way to add
 *
 * Every write goes through Identity's portal-settings route (`updatePortalSettings`, PS-02), with
 * the level `lib/actions.ts` assigns: the listing and the ways to add confirm (L1); widening the
 * audience to everyone is typed (S-21 D5); narrowing it and the group labels save at once (L0).
 *
 * The simulator previews a PERSONA, never a person (S-21 D11): groups, a switch for the Polaris
 * Key sign-in and "already has it". There is no field for an email address or an account.
 */

import * as React from "react";
import { AlertTriangle, Check, Eye, X } from "lucide-react";
import type {
  ObtainPathKind,
  PolarisKeyAnalyticsResponse,
  PolarisKeyListed,
  PolarisKeyPersona,
  PolarisKeyPreviewResponse,
  PolarisKeyReadinessCheck,
  PolarisKeyStatusResponse,
  PolarisKeyTile,
  UpdatePortalSettingsBody,
} from "../../../api.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Form, useAdminForm } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { ProductLogo } from "../../../ui/ProductLogo.js";
import { RadioCards } from "../../../ui/RadioCards.js";
import { SaveBar } from "../../../ui/SaveBar.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { StatTile } from "../../../ui/charts/StatTile.js";
import { Switch } from "../../../ui/Switch.js";
import { toast } from "../../../ui/toast.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { confirmFor } from "../../../lib/actions.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { PageHeader } from "../../components/PageHeader.js";
import { mutate } from "../../data/mutations.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../templates/Settings.js";
import { usePolarisKey, usePolarisKeyAnalytics } from "./data.js";
import {
  AUDIENCE_CHOICES,
  IDENTITY_KINDS,
  LISTED_CHOICES,
  PATH_COPY,
  hiddenCopy,
  kindLabel,
  nobodyCopy,
  reasonLine,
  termsLine,
  tileAction,
  whoLines,
} from "./polarisKeyCopy.js";

/** The store id this page serves (the adapter's, PS-01). */
export const POLARIS_KEY = "polaris-key";

const ALL_KINDS: readonly ObtainPathKind[] = [
  "group",
  "auto_issue",
  "open",
  "store_owned",
  "product_idp",
  "email_domain",
];

export function PolarisKeyPanel({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const q = usePolarisKey(slug);
  const header = (
    <PageHeader
      eyebrow={
        <Breadcrumbs
          items={[
            { label: "Storefronts", to: r.storefronts(slug) },
            { label: "Polaris Key" },
          ]}
        />
      }
      title="Polaris Key"
      titleAside={
        q.data && !q.data.enabled ? (
          <StatusPill tone="warning" size="sm">
            Off for this deployment
          </StatusPill>
        ) : null
      }
      primaryAction={
        <Button variant="outline" asChild>
          <Link to={r.listing(slug, { tab: "fit", store: POLARIS_KEY })}>
            Edit the listing
          </Link>
        </Button>
      }
    />
  );
  if (q.isPending)
    return (
      <div className="space-y-6" data-template="settings">
        {header}
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  if (q.isError)
    return (
      <div className="space-y-6" data-template="settings">
        {header}
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          context={{ area: "distribution", thing: "Polaris Key" }}
        />
      </div>
    );
  return <PanelBody slug={slug} header={header} status={q.data} />;
}

// ── The writes and their confirmations ───────────────────────────────────────────────────────

type Pending =
  | { kind: "listed"; value: PolarisKeyListed }
  | { kind: "everyone" }
  | { kind: "path"; path: ObtainPathKind; on: boolean };

function describe(e: unknown) {
  return errorCopy(e, {
    area: "distribution",
    thing: "The Polaris Key listing",
  });
}

async function save(
  slug: string,
  body: UpdatePortalSettingsBody,
): Promise<void> {
  await mutate("updatePortalSettings", slug, body);
}

/** The ways to add, as the stored list: `null` again once every kind is on. */
function nextOfferPaths(
  current: readonly ObtainPathKind[] | null,
  path: ObtainPathKind,
  on: boolean,
): ObtainPathKind[] | null {
  const set = new Set(current ?? ALL_KINDS);
  if (on) set.add(path);
  else set.delete(path);
  const next = ALL_KINDS.filter((k) => set.has(k));
  return next.length === ALL_KINDS.length ? null : next;
}

function PendingDialog({
  slug,
  status,
  pending,
  onClose,
}: {
  slug: string;
  status: PolarisKeyStatusResponse;
  pending: Pending | null;
  onClose: () => void;
}): React.ReactElement {
  // The last request stays on screen while the dialog closes.
  const last = React.useRef<Pending | null>(pending);
  if (pending) last.current = pending;
  const p = pending ?? last.current;

  let title = "";
  let consequences: string[] = [];
  let confirmLabel = "";
  let onConfirm: () => Promise<void> = async () => {};
  let policy = confirmFor("storefront.listing");
  if (p?.kind === "listed") {
    const choice = LISTED_CHOICES.find((c) => c.value === p.value)!;
    title = `Set the Polaris Key listing to ${choice.label.toLowerCase()}?`;
    consequences = [
      choice.description,
      "Every signed-in person's Discover follows the change at once.",
    ];
    confirmLabel = `Set to ${choice.label.toLowerCase()}`;
    onConfirm = async () => {
      await save(slug, { storeListed: p.value });
      toast.success(`Polaris Key listing set to ${choice.label.toLowerCase()}`);
    };
  } else if (p?.kind === "everyone") {
    policy = confirmFor("storefront.audienceEveryone");
    title = "Show this product to everyone signed in?";
    consequences = [
      "Every signed-in person sees the product on Discover, including people who cannot add it.",
      "Someone who cannot add it gets a link to its store pages or website, never Add.",
      ...(status.listing.listed === "listed"
        ? []
        : ["It applies while the product is Listed."]),
    ];
    confirmLabel = "Show to everyone";
    onConfirm = async () => {
      // The Worker's level-2 check (PS-02): the setting's key travels with the change.
      await save(slug, {
        storeAudience: "everyone",
        confirm: "storefront.polarisKey.audience",
      });
      toast.success("Shown to everyone signed in");
    };
  } else if (p?.kind === "path") {
    policy = confirmFor("storefront.waysToAdd");
    const label = PATH_COPY[p.path].label;
    title = `${p.on ? "Turn on" : "Turn off"} “${label}”?`;
    consequences = p.on
      ? [
          `People who can add the product this way see it on Discover and can add it.`,
          ...(IDENTITY_KINDS.includes(p.path) ||
          status.listing.listed === "listed"
            ? []
            : ["It counts while the product is Listed."]),
        ]
      : [
          "People whose only way to add it is this one no longer see it, and cannot add it from Discover.",
          "Licences already added keep working.",
        ];
    confirmLabel = p.on ? "Turn on" : "Turn off";
    onConfirm = async () => {
      await save(slug, {
        storeOfferPaths: nextOfferPaths(
          status.listing.offerPaths,
          p.path,
          p.on,
        ),
      });
      toast.success(`“${label}” turned ${p.on ? "on" : "off"}`);
    };
  }
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      intent={policy.intent === "none" ? "neutral" : policy.intent}
      title={title}
      consequences={consequences}
      confirmLabel={confirmLabel}
      typedConfirmation={
        policy.typedConfirmation
          ? { value: slug, label: "Type the product slug" }
          : undefined
      }
      describeError={describe}
      onConfirm={onConfirm}
    />
  );
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────

function PanelBody({
  slug,
  header,
  status,
}: {
  slug: string;
  header: React.ReactNode;
  status: PolarisKeyStatusResponse;
}): React.ReactElement {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const showGroups =
    status.groups.length > 0 ||
    Object.keys(status.listing.groupLabels).length > 0;
  const sections = [
    { id: "pk-readiness", title: "Readiness" },
    { id: "pk-listing", title: "Listing" },
    { id: "pk-ways", title: "Ways to add" },
    ...(showGroups ? [{ id: "pk-groups", title: "Group labels" }] : []),
    { id: "pk-who", title: "Who can see this?" },
    { id: "pk-analytics", title: "Last 28 days" },
  ];
  const listingId = `pk-${slug}-listed`;
  const audienceId = `pk-${slug}-audience`;

  return (
    <SettingsTemplate header={header} sections={sections}>
      {!status.enabled ? (
        <Callout tone="warning" title="Off for this deployment">
          A platform admin turned the Polaris Key storefront off, so no product
          is shown on Discover. Licences, sign-in and auto-issue keep working.
        </Callout>
      ) : null}

      <SettingsSection id="pk-readiness" title="Readiness">
        <ReadinessList slug={slug} checks={status.readiness} />
      </SettingsSection>

      <SettingsSection id="pk-listing" title="Listing">
        <SettingsRow
          label="Listing"
          align="block"
          help={<span id={`${listingId}-help`}>Who Discover shows it to.</span>}
        >
          <RadioCards
            id={listingId}
            aria-label="Listing"
            aria-describedby={`${listingId}-help`}
            columns={3}
            value={status.listing.listed}
            options={LISTED_CHOICES.map((c) => ({
              value: c.value,
              label: c.label,
              description: c.description,
            }))}
            onChange={(v) => {
              if (v !== status.listing.listed)
                setPending({ kind: "listed", value: v });
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Audience"
          align="block"
          help={
            <span id={`${audienceId}-help`}>
              {status.listing.listed === "listed"
                ? "Who sees it besides the people who can add it."
                : "Applies while the product is Listed."}
            </span>
          }
        >
          <RadioCards
            id={audienceId}
            aria-label="Audience"
            aria-describedby={`${audienceId}-help`}
            columns={2}
            value={status.listing.audience}
            options={AUDIENCE_CHOICES.map((c) => ({
              value: c.value,
              label: c.label,
              description: c.description,
            }))}
            onChange={(v) => {
              if (v === status.listing.audience) return;
              if (v === "everyone") {
                setPending({ kind: "everyone" });
                return;
              }
              // Narrowing is L0: it only hides the product from more people.
              void save(slug, { storeAudience: "eligible" }).then(
                () => toast.success("Shown only to people who can add it"),
                (e: unknown) => toast.error(e),
              );
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="pk-ways" title="Ways to add">
        <WaysToAdd
          slug={slug}
          status={status}
          onToggle={(path, on) => setPending({ kind: "path", path, on })}
        />
      </SettingsSection>

      {showGroups ? <GroupLabels slug={slug} status={status} /> : null}

      <SettingsSection id="pk-who" title="Who can see this?">
        <WhoCanSee status={status} />
        <PersonaPreview slug={slug} status={status} />
      </SettingsSection>

      <SettingsSection id="pk-analytics" title="Last 28 days">
        <Analytics slug={slug} />
      </SettingsSection>

      <PendingDialog
        slug={slug}
        status={status}
        pending={pending}
        onClose={() => setPending(null)}
      />
    </SettingsTemplate>
  );
}

// ── Readiness ────────────────────────────────────────────────────────────────────────────────

const CHECK_TITLES: Record<PolarisKeyReadinessCheck["id"], string> = {
  portal: "Customer portal",
  listing: "Listing",
  "obtain-path": "A way to add it",
  "get-it": "Get it",
  "licence-tier": "Licence tiers",
};

const STATE_WORDS: Record<PolarisKeyReadinessCheck["state"], string> = {
  pass: "Ready",
  warn: "Ready, with a note",
  fail: "Needs a fix",
};

function ReadinessList({
  slug,
  checks,
}: {
  slug: string;
  checks: PolarisKeyReadinessCheck[];
}): React.ReactElement {
  const fix = (c: PolarisKeyReadinessCheck): React.ReactNode => {
    if (c.state === "pass") return null;
    if (c.id === "portal")
      return (
        <Button size="sm" variant="outline" asChild>
          <Link to={r.portal(slug)}>Open Portal</Link>
        </Button>
      );
    if (c.id === "listing")
      return (
        <Button size="sm" variant="outline" asChild>
          <Link to={r.listing(slug)}>Open Listing</Link>
        </Button>
      );
    return null;
  };
  return (
    <ul aria-label="Readiness" className="divide-y divide-border">
      {checks.map((c) => (
        <li
          key={c.id}
          data-check={c.id}
          data-state={c.state}
          className="flex min-h-14 items-center justify-between gap-3 px-5 py-3"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 shrink-0">
              {c.state === "pass" ? (
                <Check aria-hidden className="size-4 text-success" />
              ) : c.state === "warn" ? (
                <AlertTriangle aria-hidden className="size-4 text-warning" />
              ) : (
                <X aria-hidden className="size-4 text-danger" />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-fg-strong">
                {CHECK_TITLES[c.id]}
                <span className="sr-only">: {STATE_WORDS[c.state]}</span>
              </p>
              <p className="text-sm text-fg-muted">{c.reason}</p>
            </div>
          </div>
          <div className="ml-auto shrink-0">{fix(c)}</div>
        </li>
      ))}
    </ul>
  );
}

// ── Ways to add ──────────────────────────────────────────────────────────────────────────────

function WaysToAdd({
  slug,
  status,
  onToggle,
}: {
  slug: string;
  status: PolarisKeyStatusResponse;
  onToggle: (path: ObtainPathKind, on: boolean) => void;
}): React.ReactElement {
  if (status.available.length === 0)
    return (
      <EmptyState
        kind="first-run"
        variant="inline"
        title="No way to add this product is configured"
        description="Map an IdP group or turn on auto-issue for signed-in people in the product's sign-in, or make it free to use: License off and every download public or for signed-in people."
        docs={docsUrl("polarisKeyStorefront")}
        className="px-5 py-4"
      />
    );
  const offered = new Set(status.listing.offerPaths ?? ALL_KINDS);
  return (
    <>
      {status.available.map((kind) => {
        const id = `pk-${slug}-way-${kind}`;
        const help =
          !IDENTITY_KINDS.includes(kind) && status.listing.listed !== "listed"
            ? `${PATH_COPY[kind].help} Counts while the product is Listed.`
            : PATH_COPY[kind].help;
        return (
          <SettingsRow
            key={kind}
            label={PATH_COPY[kind].label}
            htmlFor={id}
            help={<span id={`${id}-help`}>{help}</span>}
          >
            <Switch
              id={id}
              aria-describedby={`${id}-help`}
              checked={offered.has(kind)}
              onCheckedChange={(on) => onToggle(kind, on)}
            />
          </SettingsRow>
        );
      })}
    </>
  );
}

// ── Group labels ─────────────────────────────────────────────────────────────────────────────

interface LabelRow {
  group: string;
  mapped: boolean;
}

function GroupLabels({
  slug,
  status,
}: {
  slug: string;
  status: PolarisKeyStatusResponse;
}): React.ReactElement {
  // Mapped groups first, then labels whose group is no longer mapped (S-21 §10.1: a renamed
  // group loses its label, so the stale one is shown to clear).
  const rows: LabelRow[] = [
    ...status.groups.map((g) => ({ group: g.group, mapped: true })),
    ...Object.keys(status.listing.groupLabels)
      .filter((g) => !status.groups.some((m) => m.group === g))
      .map((group) => ({ group, mapped: false })),
  ];
  const values = {
    labels: rows.map((row) => status.listing.groupLabels[row.group] ?? ""),
  };
  const form = useAdminForm<{ labels: string[] }>({
    values,
    onSubmit: async (draft) => {
      const next: Record<string, string> = {};
      rows.forEach((row, i) => {
        const v = (draft.labels[i] ?? "").trim();
        if (v) next[row.group] = v;
      });
      try {
        await mutate("updatePortalSettings", slug, { storeGroupLabels: next });
      } catch (e) {
        toast.error(e);
        throw e;
      }
      toast.success("Group labels saved");
    },
    mapServerErrors: () => null,
  });
  const labels = form.rhf.watch("labels");
  return (
    <SettingsSection
      id="pk-groups"
      title="Group labels"
      footer={
        <SaveBar
          form={form}
          saveLabel="Save group labels"
          section="Group labels"
        />
      }
    >
      <Form form={form} aria-label="Group labels">
        {rows.map((row, i) => {
          const id = `pk-${slug}-label-${i}`;
          const value = labels[i] ?? "";
          return (
            <SettingsRow
              key={row.group}
              label={<span className="font-mono">{row.group}</span>}
              htmlFor={id}
              help={
                <span id={`${id}-help`}>
                  {row.mapped
                    ? value.trim()
                      ? `Discover shows “Included with ${value.trim()}”.`
                      : `Discover shows “For members of ${row.group}”.`
                    : "This group is no longer mapped. Clear the label to remove it."}
                </span>
              }
            >
              <Input
                id={id}
                aria-describedby={`${id}-help`}
                className="w-full sm:w-72"
                maxLength={40}
                value={value}
                placeholder="Aperture Seven"
                onValueChange={(v) =>
                  form.rhf.setValue(`labels.${i}`, v, { shouldDirty: true })
                }
              />
            </SettingsRow>
          );
        })}
      </Form>
    </SettingsSection>
  );
}

// ── Who can see this? ────────────────────────────────────────────────────────────────────────

function WhoCanSee({
  status,
}: {
  status: PolarisKeyStatusResponse;
}): React.ReactElement {
  const lines = whoLines(status);
  return (
    <div className="px-5 py-4">
      {lines.length ? (
        <ul aria-label="Who can see this" className="space-y-1.5 text-sm">
          {lines.map((l) => (
            <li key={l} className="flex items-start gap-2 text-fg">
              <Eye
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-fg-muted"
              />
              {l}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg">{nobodyCopy(status)}</p>
      )}
      <p className="mt-2 text-sm text-fg-muted">
        People who already have it see it in their Library instead.
      </p>
    </div>
  );
}

const EMPTY_PERSONA: PolarisKeyPersona = {
  platformAccount: true,
  groups: [],
  emailDomain: null,
  stores: [],
  holds: false,
};

function PersonaPreview({
  slug,
  status,
}: {
  slug: string;
  status: PolarisKeyStatusResponse;
}): React.ReactElement {
  const [persona, setPersona] =
    React.useState<PolarisKeyPersona>(EMPTY_PERSONA);
  const [result, setResult] = React.useState<PolarisKeyPreviewResponse | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const set = (patch: Partial<PolarisKeyPersona>) => {
    setPersona((p) => ({ ...p, ...patch }));
    setResult(null);
  };
  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setResult(await mutate("polarisKeyPreview", slug, persona));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const err = error ? describe(error) : null;
  return (
    <div className="border-t border-border px-5 py-4" data-persona>
      <h3 className="text-sm font-bold text-fg-strong">Preview a person</h3>
      <p className="mt-1 text-sm text-fg-muted">
        Describe someone and see Discover as they would. It is a made-up person:
        no account is looked up.
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <fieldset className="space-y-3">
          <legend className="sr-only">The person</legend>
          <Switch
            label="Signed in with the Polaris Key sign-in"
            description="Off: an account that only ever used an email link."
            checked={persona.platformAccount}
            onCheckedChange={(on) => set({ platformAccount: on })}
          />
          {status.groups.length ? (
            <div className="space-y-2" role="group" aria-label="Groups">
              <p className="text-sm text-fg">In these groups</p>
              {status.groups.map((g) => (
                <Checkbox
                  key={g.group}
                  label={g.group}
                  checked={persona.groups.includes(g.group)}
                  onCheckedChange={(on) =>
                    set({
                      groups: on
                        ? [...persona.groups, g.group]
                        : persona.groups.filter((x) => x !== g.group),
                    })
                  }
                />
              ))}
            </div>
          ) : null}
          {/* The inputs a later way to add reads appear with that way (PS-07, PS-09): a
              domain, never an address, and a store, never an account. */}
          {status.available.includes("email_domain") ? (
            <div className="space-y-1.5">
              <label
                htmlFor={`pk-${slug}-persona-domain`}
                className="block text-sm text-fg"
              >
                A verified email at this domain
              </label>
              <Input
                id={`pk-${slug}-persona-domain`}
                className="w-full sm:w-72"
                maxLength={253}
                placeholder="example.edu"
                value={persona.emailDomain ?? ""}
                onValueChange={(v) =>
                  set({ emailDomain: v.trim() === "" ? null : v.trim() })
                }
              />
            </div>
          ) : null}
          {status.available.includes("store_owned") ? (
            <Checkbox
              label="Linked Steam and owns it there"
              checked={persona.stores.includes("steam")}
              onCheckedChange={(on) => set({ stores: on ? ["steam"] : [] })}
            />
          ) : null}
          <Checkbox
            label="Already has it"
            checked={persona.holds}
            onCheckedChange={(on) => set({ holds: on })}
          />
          <Button
            size="sm"
            variant="outline"
            loading={busy}
            onClick={() => void run()}
          >
            Preview
          </Button>
        </fieldset>
        <div aria-live="polite" className="min-w-0" data-preview-result>
          {err ? (
            <p role="alert" className="text-sm text-danger">
              {err.title}
            </p>
          ) : result === null ? null : result.tile ? (
            <TilePreview tile={result.tile} />
          ) : (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-fg">
              {result.hidden
                ? hiddenCopy(result.hidden)
                : "This person does not see the product."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The tile as the person would see it on Discover: the same fields, the same words. */
function TilePreview({ tile }: { tile: PolarisKeyTile }): React.ReactElement {
  const first = tile.paths[0];
  const more = tile.paths.length - 1;
  return (
    <article
      aria-label={`${tile.name} on Discover`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <div className="flex items-start gap-3">
        <ProductLogo
          name={tile.name}
          size={40}
          presentation={
            tile.iconUrl
              ? { icon: { url: tile.iconUrl, w64: null, w128: null } }
              : null
          }
        />
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-fg-strong">
            {tile.name}
          </p>
          {tile.developerName ? (
            <p className="truncate text-sm text-fg-muted">
              {tile.developerName}
            </p>
          ) : null}
        </div>
      </div>
      {tile.shortDescription ? (
        <p className="text-sm text-fg">{tile.shortDescription}</p>
      ) : null}
      {first ? (
        <p className="text-sm font-bold text-fg-strong">{reasonLine(first)}</p>
      ) : null}
      {tile.offer ? (
        <p className="text-sm text-fg-muted">{termsLine(tile.offer)}</p>
      ) : null}
      {more > 0 ? (
        <p className="text-sm text-fg-muted">
          +{more} more {more === 1 ? "way" : "ways"} to add it
        </p>
      ) : null}
      <span className="inline-flex h-8 w-fit items-center rounded-md border border-border-strong px-3 text-sm font-bold text-fg">
        {tileAction(tile)}
      </span>
    </article>
  );
}

// ── Analytics ────────────────────────────────────────────────────────────────────────────────

const count = new Intl.NumberFormat("en-US");

function rate(a: { adds: number; activations: number }): string {
  if (a.adds === 0) return "–";
  return `${Math.round((a.activations / a.adds) * 100)}%`;
}

function Analytics({ slug }: { slug: string }): React.ReactElement {
  const q = usePolarisKeyAnalytics(slug);
  if (q.isError)
    return (
      <div className="px-5 py-4">
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          context={{ area: "distribution", thing: "Polaris Key analytics" }}
        />
      </div>
    );
  const data: PolarisKeyAnalyticsResponse | undefined = q.data;
  const loading = q.isPending;
  const series = (k: "impressions" | "adds" | "activations") =>
    data?.daily.map((d) => d[k]);
  return (
    <div className="space-y-4 px-5 py-4" data-analytics>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Impressions"
          loading={loading}
          value={data ? count.format(data.totals.impressions) : undefined}
          sparkline={series("impressions")}
        />
        <StatTile
          label="Adds"
          loading={loading}
          value={data ? count.format(data.totals.adds) : undefined}
          sparkline={series("adds")}
        />
        <StatTile
          label="First activations"
          loading={loading}
          value={data ? count.format(data.totals.activations) : undefined}
          sparkline={series("activations")}
        />
        <StatTile
          label="Activation rate"
          loading={loading}
          value={data ? rate(data.totals) : undefined}
        />
      </div>
      {data && !data.impressionsCounted ? (
        <p className="text-sm text-fg-muted">
          Impressions are not counted on this deployment: it has no
          KEY_HASH_PEPPER to deduplicate them with.
        </p>
      ) : null}
      {data && data.byKind.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">
              The last 28 days, by way to add
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-fg-muted">
                <th scope="col" className="py-2 pr-3 font-normal">
                  Way to add
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-normal">
                  Impressions
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-normal">
                  Adds
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-normal">
                  First activations
                </th>
                <th scope="col" className="py-2 text-right font-normal">
                  Rate
                </th>
              </tr>
            </thead>
            <tbody>
              {data.byKind.map((k) => (
                <tr key={k.kind} className="border-b border-border">
                  <th
                    scope="row"
                    className="py-2 pr-3 text-left font-normal text-fg"
                  >
                    {kindLabel(k.kind)}
                  </th>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {count.format(k.impressions)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {count.format(k.adds)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {count.format(k.activations)}
                  </td>
                  <td className="py-2 text-right tabular-nums">{rate(k)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : data ? (
        <p className="text-sm text-fg-muted">
          No one was shown it on Polaris Key in the last 28 days.
        </p>
      ) : null}
      <p className="text-sm text-fg-muted">
        Daily totals, never per person. A first activation is a device's first
        sign-in within 7 days of an add, counted on the add's day.
      </p>
    </div>
  );
}
