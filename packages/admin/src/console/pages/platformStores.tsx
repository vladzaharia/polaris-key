/**
 * Platform → Store connections (T2; ADMIN.md §2.3, notes/S-13 §9.1, A-16): the ONE team-level
 * connection the platform holds per store, the apps it can see, and which product each app
 * belongs to.
 *
 * - **Credentials are read-only here.** Each slot shows whether a credential is present and
 *   usable, its source (console or Worker secret), its display metadata (key id, issuer id, client
 *   email, …) and the last check's status line. Never key material: the API never sends any. A
 *   store without one says how to add it (a GitHub environment secret, then the Sync Worker
 *   secrets workflow); keys are not typed into the console.
 * - **The apps list** is the store's own (`GET …/<store>/apps`), cached a minute by the Worker.
 *   Re-check reads the store again (`?refresh=1`), which is also what records the credential's
 *   health. Google Play's track status opens and deletes an edit per app, so it is an explicit
 *   opt-in (`?tracks=1`).
 * - **Assign and release** are L1 (reversible, impactful; ADMIN.md §5.2): a caution confirm with
 *   consequences, then a result panel that lists what the server changed, including the product's
 *   own keys it re-pinned or left alone.
 *
 * The selected store is in the URL (`?store=`), as is the apps table's search and sort.
 */

import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import {
  ApiError,
  api,
  type PlatformStore,
  type PlatformStoreApp,
  type PlatformStoreApps,
  type PlatformStoreAssignResult,
  type PlatformStoreConnection,
  type PlatformStoreCredential,
  type PlatformStoreReleaseResult,
} from "../../api.js";
import { confirmFor } from "../../lib/actions.js";
import { cn } from "../../lib/cn.js";
import { docsUrl } from "../../lib/docsLinks.js";
import { errorCopy } from "../../lib/errorCopy.js";
import { formatCount, fromSeconds } from "../../lib/format.js";
import { Button } from "../../ui/Button.js";
import { Callout } from "../../ui/Callout.js";
import { CodeBlock } from "../../ui/CodeBlock.js";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import { DataTable, type DataColumn } from "../../ui/data-table/index.js";
import {
  DescriptionList,
  type DescriptionItem,
} from "../../ui/DescriptionList.js";
import { EmptyState } from "../../ui/EmptyState.js";
import { ErrorState } from "../../ui/ErrorState.js";
import { FormField } from "../../ui/form.js";
import { Select } from "../../ui/Select.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { Switch } from "../../ui/Switch.js";
import { Timestamp } from "../../ui/Timestamp.js";
import { toast } from "../../ui/toast.js";
import { PageHeader } from "../components/PageHeader.js";
import { useProducts } from "../data/hooks.js";
import { mutate } from "../data/mutations.js";
import { qk } from "../data/queries.js";
import { queryClient } from "../data/queryClient.js";
import { Link, useSearchParam } from "../router.js";
import { codecs, r } from "../routes.js";
import { CollectionTemplate } from "../templates/Collection.js";
import { Panel } from "../templates/Dashboard.js";
import { useTableUrlState } from "../useTableUrlState.js";

// ── data ─────────────────────────────────────────────────────────────────────────────────────

export function fetchPlatformStores(): Promise<PlatformStoreConnection[]> {
  return api.platformStoreConnections().then((r) => r.stores);
}

/**
 * One store's apps. A Re-check marks the next fetch of that store as a refresh (`?refresh=1`),
 * so the store is read again and the result lands in the same cache entry and states.
 */
const refreshNext = new Set<string>();

export function fetchPlatformStoreApps(
  store: PlatformStore,
  tracks: boolean,
): Promise<PlatformStoreApps> {
  const key = `${store}:${tracks ? "tracks" : "plain"}`;
  const refresh = refreshNext.delete(key);
  return api.platformStoreApps(store, { refresh, tracks });
}

const STORES: readonly PlatformStore[] = [
  "app-store",
  "google-play",
  "microsoft-store",
  "steam",
];

const storeCodec = codecs.oneOf(STORES, "app-store");
const tracksCodec = codecs.oneOf(["0", "1"] as const, "0");

/** A store's name before its connection has loaded. */
const STORE_NAMES: Record<PlatformStore, string> = {
  "app-store": "App Store",
  "google-play": "Google Play",
  "microsoft-store": "Microsoft Store",
  steam: "Steam",
};

/** Display metadata, in a fixed order, with its label. Never a key: the API sends none. */
const META_LABELS: [string, string][] = [
  ["issuerId", "Issuer ID (team)"],
  ["keyId", "Key ID"],
  ["clientEmail", "Service account"],
  ["sellerId", "Seller ID"],
  ["tenantId", "Tenant ID"],
  ["clientId", "Client ID"],
];

/** What an assignment pins, in words. */
const PIN_FIELD_LABELS: Record<string, string> = {
  appleId: "Apple ID",
  bundleId: "bundle ID",
  packageName: "package name",
  productId: "Store ID",
  appId: "app ID",
};

const IDENTIFIER_LABELS: Record<string, string> = {
  bundleId: "Bundle ID",
  sku: "SKU",
  packageName: "Package",
  packageFamilyName: "Package family",
  packageIdentityName: "Identity",
  appType: "Type",
};

// ── status ───────────────────────────────────────────────────────────────────────────────────

export type CredentialHealth =
  | "working"
  | "unchecked"
  | "failing"
  | "invalid"
  | "inactive"
  | "missing";

/**
 * One credential's state, from presence and the console row's health. A Worker secret records no
 * health (it has no row), so a valid one reads "unchecked" until a listing proves it.
 */
export function credentialHealth(c: PlatformStoreCredential): CredentialHealth {
  if (c.source === "console") {
    if (c.console.lastError) return "failing";
    return c.console.lastOkAt ? "working" : "unchecked";
  }
  if (c.source === "secret") return "unchecked";
  if (c.console.present && c.console.status !== "active") return "inactive";
  if (c.secret.present && !c.secret.valid) return "invalid";
  return "missing";
}

const HEALTH: Record<
  CredentialHealth,
  { tone: "success" | "warning" | "danger" | "neutral"; label: string }
> = {
  working: { tone: "success", label: "Working" },
  unchecked: { tone: "neutral", label: "Not checked" },
  failing: { tone: "danger", label: "Last check failed" },
  invalid: { tone: "danger", label: "Secret invalid" },
  inactive: { tone: "warning", label: "Inactive" },
  missing: { tone: "neutral", label: "Not set" },
};

/** The store's state as its tile shows it: the primary credential, unless a listing just failed. */
function storeHealth(s: PlatformStoreConnection): {
  tone: "success" | "warning" | "danger" | "neutral";
  label: string;
} {
  const primary =
    s.credentials.find((c) => c.id === s.primary) ?? s.credentials[0];
  if (!primary) return HEALTH.missing;
  const h = credentialHealth(primary);
  if (h === "missing") return { tone: "neutral", label: "Not connected" };
  return HEALTH[h];
}

/** App Store Connect's platform values, as Apple writes them. */
const APPLE_PLATFORMS: Record<string, string> = {
  IOS: "iOS",
  MAC_OS: "macOS",
  TV_OS: "tvOS",
  VISION_OS: "visionOS",
};

/** `WAITING_FOR_REVIEW` → "Waiting for review"; `inProgress` → "In progress". */
export function humanize(state: string): string {
  const s = state
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

interface Track {
  track: string | null;
  releases: {
    name: string | null;
    status: string | null;
    userFraction: number | null;
    versionCodes: string[];
  }[];
}

/** The store's distribution status as one or two short lines, in the store's own terms. */
export function appStatusLines(
  store: PlatformStore,
  app: PlatformStoreApp,
  tracksShown: boolean,
): string[] {
  const s = app.status;
  if (store === "app-store") {
    const appStore = s.appStore as
      | {
          versions?: {
            platform?: string | null;
            versionString?: string | null;
            state?: string | null;
          }[];
          phasedRelease?: { state?: string | null } | null;
        }
      | undefined;
    const v = appStore?.versions?.[0];
    const lines: string[] = [];
    if (v) {
      const what = [
        v.platform
          ? (APPLE_PLATFORMS[v.platform] ?? humanize(v.platform))
          : null,
        v.versionString,
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(
        `${what || "Newest version"}: ${v.state ? humanize(v.state) : "state not reported"}`,
      );
    } else lines.push("No App Store version yet");
    const phased = appStore?.phasedRelease?.state;
    if (phased) lines.push(`Phased release: ${humanize(phased)}`);
    const tf = (s.testflight as { versions?: unknown[] } | undefined)?.versions;
    if (tf && tf.length > 0)
      lines.push(`TestFlight: ${formatCount(tf.length)} version(s)`);
    return lines;
  }
  if (store === "google-play") {
    const err = str(s.tracksError);
    if (err) return [`Track status unavailable: ${err}`];
    const tracks = s.tracks as Track[] | null | undefined;
    if (!tracks)
      return [
        tracksShown
          ? "Track status not read (only the first apps are read)"
          : "Track status not loaded",
      ];
    if (tracks.length === 0) return ["No tracks"];
    return tracks.map((t) => {
      const rel = t.releases[0];
      if (!rel) return `${t.track ?? "Track"}: no release`;
      const parts = [rel.status ? humanize(rel.status) : "status not reported"];
      if (rel.userFraction !== null)
        parts.push(`${Math.round(rel.userFraction * 100)}%`);
      if (rel.versionCodes.length > 0)
        parts.push(`version code ${rel.versionCodes.join(", ")}`);
      return `${t.track ?? "Track"}: ${parts.join(", ")}`;
    });
  }
  if (store === "microsoft-store") {
    const lines: string[] = [];
    const statusError = str(s.statusError);
    const pending = str(s.pendingStatus);
    if (pending) lines.push(`Pending submission: ${humanize(pending)}`);
    else if (s.pendingSubmission) lines.push("Pending submission");
    lines.push(s.lastPublishedSubmission ? "Published" : "Not published yet");
    if (statusError)
      lines.push(`Submission status unavailable: ${statusError}`);
    return lines;
  }
  // steam
  if (s.source === "operator")
    return ["Entered by an operator (not listed by Steam)"];
  const type = str(app.identifiers.appType);
  return [type ? `Listed by Steam (${type})` : "Listed by Steam"];
}

// ── page ─────────────────────────────────────────────────────────────────────────────────────

export function StoreConnections(): React.ReactElement {
  const stores = useQuery(
    { queryKey: qk.platformStores(), queryFn: fetchPlatformStores },
    queryClient,
  );
  const [selected, setSelected] = useSearchParam("store", storeCodec);
  const list = stores.data ?? [];
  const current = list.find((s) => s.store === selected) ?? null;

  const header = (
    <PageHeader
      title="Store connections"
      freshness={
        stores.dataUpdatedAt
          ? {
              updatedAt: stores.dataUpdatedAt,
              onRefresh: () => void stores.refetch(),
              refreshing: stores.isFetching,
            }
          : undefined
      }
    />
  );

  if (stores.isError && !stores.data) {
    return (
      <CollectionTemplate header={header}>
        <ErrorState
          error={stores.error}
          onRetry={() => void stores.refetch()}
        />
      </CollectionTemplate>
    );
  }

  return (
    <CollectionTemplate
      header={header}
      summary={
        <StoreTiles
          stores={list}
          loading={stores.isPending}
          selected={selected}
          onSelect={setSelected}
        />
      }
    >
      {stores.isPending ? (
        <div
          aria-hidden
          className="h-64 animate-pulse rounded-lg bg-surface-sunken motion-reduce:animate-none"
        />
      ) : current ? (
        <StoreDetail key={current.store} connection={current} />
      ) : (
        <EmptyState
          kind="not-found"
          title={`${STORE_NAMES[selected]} is not a store this instance connects to`}
          description="The Worker did not list this store. Choose another store above."
        />
      )}
    </CollectionTemplate>
  );
}

function StoreTiles({
  stores,
  loading,
  selected,
  onSelect,
}: {
  stores: PlatformStoreConnection[];
  loading: boolean;
  selected: PlatformStore;
  onSelect: (s: PlatformStore) => void;
}): React.ReactElement {
  const byStore = new Map(stores.map((s) => [s.store, s]));
  return (
    <>
      {STORES.map((store) => {
        const s = byStore.get(store);
        const active = store === selected;
        const health = s ? storeHealth(s) : null;
        return (
          <button
            key={store}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(store)}
            className={cn(
              "flex min-h-24 flex-col items-start gap-2 rounded-lg border bg-surface-raised p-4 text-left",
              "transition-colors duration-(--pk-duration-fast) ease-standard",
              "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
              active
                ? "border-accent ring-1 ring-accent"
                : "border-border hover:border-border-strong hover:bg-hover",
            )}
          >
            <span className="text-sm font-bold text-fg-strong">
              {s?.label ?? STORE_NAMES[store]}
            </span>
            {loading ? (
              <span
                aria-hidden
                className="h-5 w-24 animate-pulse rounded-md bg-surface-sunken motion-reduce:animate-none"
              />
            ) : health ? (
              <StatusPill tone={health.tone} size="sm">
                {health.label}
              </StatusPill>
            ) : (
              // The Worker does not list this store: say so rather than leave a blank tile.
              <StatusPill tone="neutral" size="sm">
                Not set up
              </StatusPill>
            )}
            {s ? (
              <span className="text-xs text-fg-muted">
                {s.assignments.length === 1
                  ? "1 app assigned"
                  : `${formatCount(s.assignments.length)} apps assigned`}
              </span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}

// ── one store ────────────────────────────────────────────────────────────────────────────────

type Outcome =
  | { kind: "assign"; app: PlatformStoreApp; result: PlatformStoreAssignResult }
  | {
      kind: "release";
      app: PlatformStoreApp;
      result: PlatformStoreReleaseResult;
    };

function StoreDetail({
  connection: s,
}: {
  connection: PlatformStoreConnection;
}): React.ReactElement {
  const [tracksRaw, setTracksRaw] = useSearchParam("tracks", tracksCodec);
  const tracks = s.store === "google-play" && tracksRaw === "1";
  const configured = s.configured;
  const apps = useQuery(
    {
      queryKey: qk.platformStoreApps(s.store, tracks),
      queryFn: () => fetchPlatformStoreApps(s.store, tracks),
      enabled: configured && s.appsListing,
      retry: false,
    },
    queryClient,
  );
  const [checking, setChecking] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);

  const recheck = async () => {
    setChecking(true);
    refreshNext.add(`${s.store}:${tracks ? "tracks" : "plain"}`);
    try {
      const res = await apps.refetch();
      if (res.isSuccess)
        toast.success(`${s.label} checked`, {
          description: `The store listed ${formatCount(res.data.apps.length)} app(s) for the team credential.`,
        });
    } finally {
      // The listing records the credential's health (last OK, last error): read it again.
      void queryClient.invalidateQueries({
        queryKey: qk.platformStores(),
        exact: true,
      });
      setChecking(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Credentials, then the Account card (only when the store has shared settings): each its
          own row, as the two grow independently and a pair would stretch the shorter one. */}
      <CredentialsPanel
        connection={s}
        action={
          configured && s.appsListing ? (
            <Button
              variant="outline"
              size="sm"
              loading={checking}
              onClick={() => void recheck()}
            >
              <RefreshCw aria-hidden />
              Re-check
            </Button>
          ) : undefined
        }
      />
      {s.settings.length > 0 ? <SettingsPanel connection={s} /> : null}

      {outcome ? (
        <OutcomePanel
          outcome={outcome}
          connection={s}
          onDismiss={() => setOutcome(null)}
        />
      ) : null}

      <Panel
        title="Apps"
        description={
          configured
            ? undefined
            : "The apps appear once the store has a team credential."
        }
      >
        {!configured ? (
          <AddCredential connection={s} />
        ) : !s.appsListing ? (
          <EmptyState
            kind="first-run"
            title={`${s.label} has no apps listing`}
            description="Assignments made through the API still apply; they are listed under Credentials."
            docs={docsUrl("storeConnections")}
          />
        ) : (
          <AppsTable
            connection={s}
            query={apps}
            tracks={tracks}
            onTracks={(on) => setTracksRaw(on ? "1" : "0")}
            onOutcome={setOutcome}
          />
        )}
      </Panel>
    </div>
  );
}

function primaryOf(
  s: PlatformStoreConnection,
): PlatformStoreCredential | undefined {
  return s.credentials.find((c) => c.id === s.primary) ?? s.credentials[0];
}

function CredentialsPanel({
  connection: s,
  action,
}: {
  connection: PlatformStoreConnection;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <Panel
      title="Credentials"
      description="Keys are never shown."
      action={action}
    >
      <ul className="divide-y divide-border">
        {s.credentials.map((c) => (
          <li key={c.id} className="space-y-3 py-4 first:pt-0 last:pb-0">
            <CredentialRow
              credential={c}
              primary={s.credentials.length > 1 && c.id === s.primary}
            />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function CredentialRow({
  credential: c,
  primary,
}: {
  credential: PlatformStoreCredential;
  primary: boolean;
}): React.ReactElement {
  const health = credentialHealth(c);
  const pill = HEALTH[health];
  const meta = c.meta ?? c.console.meta ?? {};
  const items: DescriptionItem[] = [];
  if (c.source) {
    items.push({
      term: "Source",
      detail:
        c.source === "console" ? (
          "Stored in the console"
        ) : (
          <>
            Worker secret{" "}
            <span className="font-mono text-xs">{c.secret.name}</span>
          </>
        ),
      help:
        c.source === "console" && c.secret.present
          ? `${c.secret.name} is also set; the console credential wins.`
          : undefined,
    });
  }
  for (const [field, label] of META_LABELS) {
    const v = meta[field];
    if (v)
      items.push({
        term: label,
        detail: <span className="break-all font-mono text-xs">{v}</span>,
      });
  }
  if (c.source === "console") {
    items.push({
      term: "Last OK",
      detail: c.console.lastOkAt ? (
        <Timestamp at={fromSeconds(c.console.lastOkAt)} />
      ) : (
        "Not yet"
      ),
    });
    items.push({
      term: "Last used",
      detail: c.console.lastUsedAt ? (
        <Timestamp at={fromSeconds(c.console.lastUsedAt)} />
      ) : (
        "Not yet"
      ),
    });
  }
  if (c.configured) {
    items.push({
      term: "Products assigned",
      detail: formatCount(c.pins),
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-fg-strong">
          {c.label}
          {primary ? (
            <span className="ml-2 font-normal text-fg-muted">
              lists the apps
            </span>
          ) : null}
        </h3>
        <StatusPill tone={pill.tone} size="sm">
          {pill.label}
        </StatusPill>
      </div>
      {health === "failing" && c.console.lastError ? (
        <Callout tone="danger" title="The store refused the last check">
          <span className="font-mono text-xs">{c.console.lastError}</span>
        </Callout>
      ) : null}
      {health === "invalid" ? (
        <Callout tone="danger" title={`${c.secret.name} is set but unusable`}>
          The JSON did not pass the {c.kind} validator: a wrong field name, or a
          PEM that lost its line breaks. Set it again from the key file and
          re-run the Sync Worker secrets workflow.
        </Callout>
      ) : null}
      {health === "inactive" ? (
        <Callout tone="warning" title="The console credential is inactive">
          It is not used. {c.secret.name} applies when set.
        </Callout>
      ) : null}
      {health === "unchecked" && c.source === "secret" ? (
        <p className="text-xs text-fg-muted">
          A Worker secret keeps no check history. Re-check lists the apps live
          and shows any error the store returns.
        </p>
      ) : null}
      {items.length > 0 ? <DescriptionList columns={2} items={items} /> : null}
      {!c.configured && health === "missing" ? (
        <p className="text-sm text-fg-muted">
          Not set. Add it as{" "}
          <span className="font-mono text-xs text-fg">{c.secret.name}</span>:
          see Add a credential below.
        </p>
      ) : null}
    </>
  );
}

function SettingsPanel({
  connection: s,
}: {
  connection: PlatformStoreConnection;
}): React.ReactElement {
  return (
    <Panel title="Account" description="Every product falls back to these.">
      {s.settings.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {s.label} has no shared settings.
        </p>
      ) : (
        <DescriptionList
          items={s.settings.map((x) => ({
            term: x.label,
            detail: x.value ? (
              <span className="break-all font-mono text-xs">{x.value}</span>
            ) : (
              "Not set"
            ),
            help: [
              x.usedBy,
              x.source === "env" && x.envName
                ? `From ${x.envName}.`
                : x.source === "console"
                  ? "Set in the console."
                  : null,
            ]
              .filter(Boolean)
              .join(" "),
          }))}
        />
      )}
    </Panel>
  );
}

/** A store with no team credential: how to add one, without the key passing through here. */
function AddCredential({
  connection: s,
}: {
  connection: PlatformStoreConnection;
}): React.ReactElement {
  const primary = primaryOf(s);
  const name = primary?.secret.name ?? "PLATFORM_…";
  return (
    <div className="space-y-4">
      <EmptyState
        kind="first-run"
        headingLevel={3}
        title={`No ${s.label} credential yet`}
        description={`Add the team ${primary?.label ?? "credential"} as a Worker secret. Store the key file as a GitHub production environment secret, then run the Sync Worker secrets workflow: the key never passes through a terminal, a chat or this console.`}
        docs={docsUrl("storeConnections")}
        secondaryAction={
          <Button variant="link" size="sm" asChild>
            <a href={docsUrl("platformSecrets")}>
              Secret names and JSON shapes
            </a>
          </Button>
        }
      />
      <CodeBlock
        language="sh"
        filename="From the machine that holds the key file"
        code={`gh secret set ${name} --env production < key.json\ngh workflow run sync-worker-secrets.yml -f target=prod`}
      />
    </div>
  );
}

// ── apps ─────────────────────────────────────────────────────────────────────────────────────

function AppsTable({
  connection: s,
  query,
  tracks,
  onTracks,
  onOutcome,
}: {
  connection: PlatformStoreConnection;
  query: UseQueryResult<PlatformStoreApps>;
  tracks: boolean;
  onTracks: (on: boolean) => void;
  onOutcome: (o: Outcome) => void;
}): React.ReactElement {
  const [state, setState] = useTableUrlState("store-apps", {
    facets: ["assignment"],
  });
  const products = useProducts();
  const names = React.useMemo(
    () => new Map((products.data ?? []).map((p) => [p.slug, p.name])),
    [products.data],
  );
  const [assigning, setAssigning] = React.useState<PlatformStoreApp | null>(
    null,
  );
  const [releasing, setReleasing] = React.useState<PlatformStoreApp | null>(
    null,
  );
  const listing = query.data;
  const primary = primaryOf(s);
  const pinWord = PIN_FIELD_LABELS[primary?.pinField ?? ""] ?? "app ID";

  const columns = React.useMemo<DataColumn<PlatformStoreApp>[]>(
    () => [
      {
        id: "name",
        header: "App",
        accessorFn: (a) => a.name ?? a.appId,
        meta: { priority: 1, primary: true },
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="font-bold text-fg-strong">
              {row.original.name ?? "Unnamed app"}
            </div>
            <div className="break-all font-mono text-xs text-fg-muted">
              {row.original.appId}
            </div>
          </div>
        ),
      },
      {
        id: "identifiers",
        header: "Identifiers",
        enableSorting: false,
        accessorFn: (a) =>
          Object.entries(a.identifiers)
            .filter(([, v]) => v)
            .map(([k, v]) => `${IDENTIFIER_LABELS[k] ?? k}: ${v}`)
            .join("; "),
        meta: { priority: 2 },
        cell: ({ row }) => {
          const ids = Object.entries(row.original.identifiers).filter(
            ([, v]) => v,
          );
          return ids.length === 0 ? (
            "—"
          ) : (
            <ul className="space-y-0.5 text-xs">
              {ids.map(([k, v]) => (
                <li key={k}>
                  <span className="text-fg-muted">
                    {IDENTIFIER_LABELS[k] ?? k}
                  </span>{" "}
                  <span className="break-all font-mono">{v}</span>
                </li>
              ))}
            </ul>
          );
        },
      },
      {
        id: "status",
        header: "Store status",
        enableSorting: false,
        accessorFn: (a) => appStatusLines(s.store, a, tracks).join("; "),
        meta: { priority: 1 },
        cell: ({ row }) => (
          <ul className="space-y-0.5 text-xs">
            {appStatusLines(s.store, row.original, tracks).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ),
      },
      {
        id: "product",
        header: "Product",
        accessorFn: (a) => a.assignedProduct ?? "",
        meta: { priority: 1 },
        cell: ({ row }) => {
          const a = row.original;
          if (!a.assignedProduct)
            return <span className="text-fg-muted">Unassigned</span>;
          return (
            <div className="space-y-0.5">
              <Link
                to={r.overview(a.assignedProduct)}
                className="text-accent-fg underline-offset-4 hover:underline"
              >
                {names.get(a.assignedProduct) ?? a.assignedProduct}
              </Link>
              {a.assignedVia === "own-credential" ? (
                <div className="text-xs text-fg-muted">
                  through the product's own key
                </div>
              ) : null}
            </div>
          );
        },
      },
    ],
    [s.store, tracks, names],
  );

  const facets = React.useMemo(
    () => [
      {
        id: "assignment",
        label: "Assignment",
        options: [
          { value: "assigned", label: "Assigned" },
          { value: "own-key", label: "Held by a product's own key" },
          { value: "unassigned", label: "Unassigned" },
        ],
        accessor: (a: PlatformStoreApp) =>
          a.assignedVia === "platform"
            ? "assigned"
            : a.assignedVia === "own-credential"
              ? "own-key"
              : "unassigned",
      },
    ],
    [],
  );

  const storeError =
    query.error instanceof ApiError && query.error.code === "store_unavailable"
      ? query.error
      : null;

  return (
    <div className="space-y-4">
      {s.store === "google-play" ? (
        <Switch
          checked={tracks}
          onCheckedChange={onTracks}
          label="Show track status"
          description="Reads each app's tracks (the first ten apps). Google Play needs a short edit opened and deleted per app to answer, so it is off unless you turn it on."
        />
      ) : null}
      {listing?.listed === false ? (
        <Callout tone="warning" title="Steam did not list the group's apps">
          The publisher key has no permission to list apps, so only the app IDs
          entered by an operator are shown. They can still be assigned.
        </Callout>
      ) : null}
      {listing?.truncated ? (
        <Callout tone="info" title="Not everything was read">
          The store had more apps or more detail than one bounded read fetches.
          Every listed app can be assigned.
        </Callout>
      ) : null}
      {storeError ? (
        <Callout tone="danger" title={`${s.label} refused the apps listing`}>
          <span className="font-mono text-xs">{storeError.message}</span>
          <span className="block pt-1">
            Check the team credential at the store (revoked, expired, or missing
            a role), then Re-check.
          </span>
        </Callout>
      ) : null}
      {listing ? (
        <p className="text-xs text-fg-muted">
          Read from the store <Timestamp at={fromSeconds(listing.fetchedAt)} />
          {listing.cached ? " (cached for up to a minute)" : ""}.
        </p>
      ) : null}
      <DataTable<PlatformStoreApp>
        id="store-apps"
        caption={`${s.label} apps`}
        data={listing?.apps ?? []}
        columns={columns}
        getRowId={(a) => a.appId}
        rowLabel={(a) => a.name ?? a.appId}
        state={state}
        onStateChange={setState}
        facets={facets}
        search={{
          placeholder: `Search by name or ${pinWord}`,
          columns: ["name", "identifiers"],
        }}
        loading={query.isPending}
        error={storeError ? undefined : query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        pagination={{ mode: "client" }}
        rowActions={(a) =>
          a.assignedVia === "platform"
            ? [
                {
                  label: `Release from ${names.get(a.assignedProduct!) ?? a.assignedProduct}`,
                  onSelect: () => setReleasing(a),
                },
              ]
            : [
                {
                  label: "Assign to product…",
                  onSelect: () => setAssigning(a),
                },
              ]
        }
        empty={
          <EmptyState
            kind="first-run"
            title="The team credential sees no apps"
            description={`Create the app in ${s.label} first, or give the team credential access to it, then Re-check.`}
            docs={docsUrl("storeConnections")}
          />
        }
        mobile="cards"
      />
      <AssignDialog
        connection={s}
        app={assigning}
        names={names}
        products={products.data ?? []}
        onClose={() => setAssigning(null)}
        onDone={(app, result) => onOutcome({ kind: "assign", app, result })}
      />
      <ReleaseDialog
        connection={s}
        app={releasing}
        names={names}
        onClose={() => setReleasing(null)}
        onDone={(app, result) => onOutcome({ kind: "release", app, result })}
      />
    </div>
  );
}

// ── assign / release ─────────────────────────────────────────────────────────────────────────

/** The other product named in a refusal's message ("… pinned to product acme; …"). */
function productInMessage(message: string): string | null {
  return /\bproduct ([a-z0-9-]+)/.exec(message)?.[1] ?? null;
}

/**
 * The assignment refusals, in plain words (ADMIN.md §5.9: no view shows a bare code). Anything
 * else reads through `errorCopy`.
 */
export function describeAssignError(
  e: unknown,
  storeLabel: string,
  names: Map<string, string>,
): { title: string; description?: string } {
  if (e instanceof ApiError) {
    const other = productInMessage(e.message);
    const otherName = other ? (names.get(other) ?? other) : null;
    if (e.code === "app_assigned_elsewhere")
      return {
        title: "Another product already holds this app",
        description: `${otherName ? `${otherName} holds it` : "Another product holds it"}, through the team credential or through a key of its own. An app belongs to one product at a time, so nothing was changed. Release it there first (or re-pin that product's own key), then assign it here.`,
      };
    if (e.code === "own_credential_other_account")
      return {
        title: "The product's own key belongs to another account",
        description: `This product holds a ${storeLabel} key of its own from a different ${storeLabel} account than the team credential. Assigning would point the two keys at different accounts, so nothing was changed. Re-pin or delete that key under the product's outlet credentials, then assign again.`,
      };
    if (e.code === "app_not_found")
      return {
        title: "The team credential can no longer see this app",
        description:
          "It was removed or the credential lost access since the list was read. Re-check, then try again.",
      };
    if (e.code === "not_configured")
      return {
        title: `${storeLabel} has no usable team credential`,
        description: "Add the credential, then assign the app.",
      };
    if (e.code === "store_unavailable")
      return {
        title: `${storeLabel} did not answer`,
        description: `${e.message}. Nothing was changed; try again shortly.`,
      };
    if (e.status === 422) return { title: "Choose an existing product." };
  }
  const copy = errorCopy(e);
  return { title: copy.title, description: copy.description };
}

function AssignDialog({
  connection: s,
  app,
  names,
  products,
  onClose,
  onDone,
}: {
  connection: PlatformStoreConnection;
  app: PlatformStoreApp | null;
  names: Map<string, string>;
  products: { slug: string; name: string }[];
  onClose: () => void;
  onDone: (app: PlatformStoreApp, result: PlatformStoreAssignResult) => void;
}): React.ReactElement {
  const policy = confirmFor("storeApp.assign");
  const [product, setProduct] = React.useState<string | null>(null);
  // Held through a product's own key: that product is the only one the Worker accepts.
  React.useEffect(() => {
    setProduct(
      app?.assignedVia === "own-credential" ? app.assignedProduct : null,
    );
  }, [app]);
  const primary = primaryOf(s);
  const pinWord = PIN_FIELD_LABELS[primary?.pinField ?? ""] ?? "app ID";
  const appName = app?.name ?? app?.appId ?? "";
  const productName = product ? (names.get(product) ?? product) : "The product";
  const extraPins = app
    ? Object.entries(app.pins).map(([credential, pin]) => {
        const c = s.credentials.find((x) => x.id === credential);
        return `The team ${c?.label ?? credential} is pinned to ${PIN_FIELD_LABELS[c?.pinField ?? ""] ?? "app"} ${pin} for it too.`;
      })
    : [];
  return (
    <ConfirmDialog
      open={app !== null}
      onOpenChange={(o) => !o && onClose()}
      intent={policy.intent === "none" ? "caution" : policy.intent}
      title={`Assign ${appName} to a product?`}
      description={`Check that this app really is the product's: the team credential reaches every app of the ${s.label} account, and the assignment decides which one a product's connectors act on.`}
      consequences={[
        `${productName} may use the team ${primary?.label ?? "credential"} for ${pinWord} ${app?.appId ?? ""} only, whenever it has no key of its own.`,
        ...extraPins,
        "Keys the product holds of its own are re-pinned to this app when they belong to the same store account; others are left alone and listed afterwards.",
        "Release undoes it.",
      ]}
      confirmLabel="Assign app"
      confirmDisabled={!product}
      describeError={(e) => describeAssignError(e, s.label, names)}
      onConfirm={async () => {
        if (!app || !product) return;
        const result = await mutate(
          "assignPlatformStoreApp",
          s.store,
          app.appId,
          product,
        );
        onDone(app, result);
        toast.success(`Assigned to ${names.get(product) ?? product}`, {
          description: `${appName} is now that product's ${s.label} app.`,
        });
      }}
    >
      <FormField
        name="product"
        label="Product"
        required
        value={product ?? ""}
        onChange={(v: string | null) => setProduct(v || null)}
        help={
          app?.assignedVia === "own-credential"
            ? "Held through this product's own key: it is the only product the app can be assigned to."
            : undefined
        }
      >
        {(field) => (
          <Select
            id={field.id}
            aria-describedby={field["aria-describedby"]}
            aria-required
            value={product}
            onChange={(v) => setProduct(v)}
            disabled={app?.assignedVia === "own-credential"}
            placeholder="Choose a product…"
            options={products.map((p) => ({ value: p.slug, label: p.name }))}
          />
        )}
      </FormField>
    </ConfirmDialog>
  );
}

function ReleaseDialog({
  connection: s,
  app,
  names,
  onClose,
  onDone,
}: {
  connection: PlatformStoreConnection;
  app: PlatformStoreApp | null;
  names: Map<string, string>;
  onClose: () => void;
  onDone: (app: PlatformStoreApp, result: PlatformStoreReleaseResult) => void;
}): React.ReactElement {
  const policy = confirmFor("storeApp.release");
  const holder = app?.assignedProduct ?? "";
  const holderName = names.get(holder) ?? holder;
  const appName = app?.name ?? app?.appId ?? "";
  return (
    <ConfirmDialog
      open={app !== null}
      onOpenChange={(o) => !o && onClose()}
      intent={policy.intent === "none" ? "caution" : policy.intent}
      title={`Release ${appName} from ${holderName}?`}
      consequences={[
        `${holderName} can no longer use the team ${s.label} credential: connectors relying on it stop with pin_missing until an app is assigned again.`,
        "Keys the product holds of its own keep their pin.",
        "The app can then be assigned to another product.",
      ]}
      confirmLabel="Release app"
      describeError={(e) => describeAssignError(e, s.label, names)}
      onConfirm={async () => {
        if (!app || !holder) return;
        const result = await mutate(
          "releasePlatformStoreApp",
          s.store,
          app.appId,
          holder,
        );
        onDone(app, result);
        toast.success(`Released from ${holderName}`, {
          description: `${appName} is unassigned.`,
        });
      }}
    />
  );
}

/** What the server changed (ADMIN.md §5.3: a result panel, not just a toast). */
function OutcomePanel({
  outcome,
  connection: s,
  onDismiss,
}: {
  outcome: Outcome;
  connection: PlatformStoreConnection;
  onDismiss: () => void;
}): React.ReactElement {
  const labelOf = (id: string) =>
    s.credentials.find((c) => c.id === id)?.label ?? id;
  const appName = outcome.app.name ?? outcome.app.appId;
  const dismiss = (
    <Button variant="ghost" size="xs" onClick={onDismiss}>
      Dismiss
    </Button>
  );
  if (outcome.kind === "release") {
    const res = outcome.result;
    return (
      <Callout
        tone="success"
        title={`Released ${appName} from ${res.product}`}
        action={dismiss}
        live
      >
        <ul className="list-disc space-y-0.5 pl-5">
          {res.cleared.map((c) => (
            <li key={c.credential}>
              Cleared the {labelOf(c.credential)} pin{" "}
              <span className="font-mono text-xs">{c.pin}</span>
            </li>
          ))}
          <li>The product's own keys keep their pins.</li>
        </ul>
      </Callout>
    );
  }
  const res = outcome.result;
  const changed = res.pins.filter((p) => p.changed);
  return (
    <Callout
      tone={res.ownCredentialsSkipped.length > 0 ? "warning" : "success"}
      title={`Assigned ${appName} to ${res.product}`}
      action={dismiss}
      live
    >
      <ul className="list-disc space-y-0.5 pl-5">
        {changed.length === 0 ? (
          <li>It was already assigned: nothing changed.</li>
        ) : null}
        {changed.map((p) => (
          <li key={p.credential}>
            Pinned the {labelOf(p.credential)} to{" "}
            <span className="font-mono text-xs">{p.pin}</span>
          </li>
        ))}
        {res.released.map((p) => (
          <li key={p.credential}>
            Released the {labelOf(p.credential)} pin{" "}
            <span className="font-mono text-xs">{p.pin}</span> (this app names
            none)
          </li>
        ))}
        {res.ownCredentialsRepinned.length > 0 ? (
          <li>
            Re-pinned the product's own key(s) to the same app:{" "}
            <span className="font-mono text-xs">
              {res.ownCredentialsRepinned.join(", ")}
            </span>
          </li>
        ) : null}
        {res.ownCredentialsSkipped.length > 0 ? (
          <li>
            Left alone, because their store account cannot be told from the
            key's metadata:{" "}
            <span className="font-mono text-xs">
              {res.ownCredentialsSkipped.map((k) => k.id).join(", ")}
            </span>
            . Check them and re-pin them on the product's{" "}
            <Link
              to={r.keys(res.product)}
              className="text-accent-fg underline-offset-4 hover:underline"
            >
              keys and secrets
            </Link>
            .
          </li>
        ) : null}
      </ul>
    </Callout>
  );
}
