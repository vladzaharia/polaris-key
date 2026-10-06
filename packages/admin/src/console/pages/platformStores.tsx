/**
 * Platform → Store connections (T2; ADMIN.md §2.3, notes/S-13 §9.1, A-16): the ONE team-level
 * connection the platform holds per store, the apps it can see, and which product each app
 * belongs to.
 *
 * - **Credentials.** Each slot shows whether a credential is present and usable, its source
 *   (console or Worker secret), its display metadata (key id, issuer id, client email, …) and the
 *   last check's status line. Never key material: the API never sends any.
 * - **Connect, checked on paste** (UX-69, SETUP.md D42). `ConnectForm` takes a slot's key and,
 *   the moment it is pasted (or the field is left complete), sends the UNSAVED value once to the
 *   Worker's check route, which tries it against the store and answers what it found: "Team
 *   69a6de7f · 3 apps", which permission is missing, another team, expired, or the store being
 *   down. Save is enabled only after a pass, and any edit takes the pass away. A store with no
 *   credential shows the form first and the Worker-secret route (the Sync Worker secrets
 *   workflow) as the alternative; a stored one offers **Replace key**.
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
import { KeyRound, RefreshCw, Upload } from "lucide-react";
import {
  ApiError,
  api,
  type CredentialCheck,
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
import { Input } from "../../ui/Input.js";
import { SecretInput } from "../../ui/SecretInput.js";
import { Spinner } from "../../ui/Spinner.js";
import { Textarea } from "../../ui/Textarea.js";
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
              connection={s}
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
  connection: s,
  credential: c,
  primary,
}: {
  connection: PlatformStoreConnection;
  credential: PlatformStoreCredential;
  primary: boolean;
}): React.ReactElement {
  const [connecting, setConnecting] = React.useState(false);
  // A store with no credential at all shows the primary slot's form under Apps (AddCredential).
  const canConnect = c.configured || s.configured;
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
        <div className="flex items-center gap-2">
          <StatusPill tone={pill.tone} size="sm">
            {pill.label}
          </StatusPill>
          {canConnect && !connecting ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConnecting(true)}
            >
              <KeyRound aria-hidden />
              {c.configured ? "Replace key" : "Connect"}
            </Button>
          ) : null}
        </div>
      </div>
      {health === "failing" && c.console.lastError ? (
        <Callout tone="danger" title="The store refused the last check">
          <span className="font-mono text-xs">{c.console.lastError}</span>
        </Callout>
      ) : null}
      {connecting ? (
        <ConnectForm
          store={s.store}
          credential={c}
          onCancel={() => setConnecting(false)}
          onSaved={() => setConnecting(false)}
        />
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
      {!c.configured && health === "missing" && !connecting ? (
        <p className="text-sm text-fg-muted">
          Not set.{" "}
          {canConnect
            ? "Connect it here, or add it as "
            : "Connect it below, or add it as "}
          <span className="font-mono text-xs text-fg">{c.secret.name}</span>.
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

/**
 * A store with no team credential: the connect form for its primary slot, checked on paste, and
 * the Worker-secret route as the alternative for keys that should never pass through a browser.
 */
function AddCredential({
  connection: s,
}: {
  connection: PlatformStoreConnection;
}): React.ReactElement {
  const primary = primaryOf(s);
  const name = primary?.secret.name ?? "PLATFORM_…";
  return (
    <div className="space-y-6">
      <EmptyState
        kind="first-run"
        headingLevel={3}
        title={`No ${s.label} credential yet`}
        description={`Paste the team ${primary?.label ?? "credential"} below. Polaris Key checks it with ${STORE_VENDORS[s.store]} the moment it is pasted and saves it only once it works.`}
        docs={docsUrl("storeConnections")}
      />
      {primary ? <ConnectForm store={s.store} credential={primary} /> : null}
      <div className="space-y-3 border-t border-border pt-4">
        <h4 className="text-sm font-bold text-fg-strong">
          Or set it as a Worker secret
        </h4>
        <p className="text-sm text-fg-muted">
          Store the key file as a GitHub production environment secret, then run
          the Sync Worker secrets workflow: the key never passes through a
          terminal, a chat or this console.{" "}
          <a className="underline" href={docsUrl("platformSecrets")}>
            Secret names and JSON shapes
          </a>
        </p>
        <CodeBlock
          language="sh"
          filename="From the machine that holds the key file"
          code={`gh secret set ${name} --env production < key.json\ngh workflow run sync-worker-secrets.yml -f target=prod`}
        />
      </div>
    </div>
  );
}

// ── connect, checked on paste (UX-69) ────────────────────────────────────────────────────────

/** Who the check talks to, by store ("Checking with App Store Connect…"). */
const STORE_VENDORS: Record<PlatformStore, string> = {
  "app-store": "App Store Connect",
  "google-play": "Google",
  "microsoft-store": "Microsoft",
  steam: "Steam",
};

interface ConnectField {
  name: string;
  label: string;
  control: "text" | "secret" | "textarea";
  help?: string;
  placeholder?: string;
}

interface ConnectShape {
  fields: ConnectField[];
  /** A key file the form can read instead of a paste (it never leaves the browser except to the
   *  check and the save, like a paste). */
  file?: { accept: string; into: string; label: string };
  /** The value sent: the fields as an object, or one field's text as is (a Google key file). */
  wire: "object" | { text: string };
}

const P8_FIELDS: ConnectField[] = [
  {
    name: "keyId",
    label: "Key ID",
    control: "text",
    placeholder: "ABC123DEFG",
    help: "Filled from the file name when you choose AuthKey_<Key ID>.p8.",
  },
  {
    name: "issuerId",
    label: "Issuer ID",
    control: "text",
    placeholder: "69a6de7f-…",
    help: "Shown above the key list in Users and Access → Integrations.",
  },
  {
    name: "p8",
    label: "Private key (.p8)",
    control: "textarea",
    placeholder: "-----BEGIN PRIVATE KEY-----",
  },
];

/** The fields of each credential kind (the Worker validates the same shape). */
const CONNECT_SHAPES: Record<string, ConnectShape> = {
  "asc-api-key": {
    fields: P8_FIELDS,
    file: { accept: ".p8", into: "p8", label: "Choose .p8 file" },
    wire: "object",
  },
  "app-store-server-key": {
    fields: P8_FIELDS,
    file: { accept: ".p8", into: "p8", label: "Choose .p8 file" },
    wire: "object",
  },
  "google-service-account": {
    fields: [
      {
        name: "json",
        label: "Service account key (JSON)",
        control: "textarea",
        placeholder: '{ "type": "service_account", … }',
        help: "The whole key file, as Google Cloud downloaded it.",
      },
    ],
    file: {
      accept: ".json,application/json",
      into: "json",
      label: "Choose key file",
    },
    wire: { text: "json" },
  },
  "ms-partner-center": {
    fields: [
      { name: "tenantId", label: "Tenant ID", control: "text" },
      { name: "clientId", label: "Client ID", control: "text" },
      {
        name: "clientSecret",
        label: "Client secret",
        control: "secret",
        help: "The secret's Value, not its Secret ID.",
      },
      { name: "sellerId", label: "Seller ID", control: "text" },
    ],
    wire: "object",
  },
  "steam-publisher-key": {
    fields: [
      {
        name: "key",
        label: "Publisher Web API key",
        control: "secret",
        help: "Steamworks → Users & Permissions → Manage Groups → your group.",
      },
    ],
    wire: "object",
  },
};

type CheckState =
  | { phase: "idle" }
  | { phase: "checking"; for: string }
  | { phase: "done"; for: string; check: CredentialCheck }
  | { phase: "error"; for: string; title: string; description: string };

/** Verdicts that let the form save: it works, it works with a caveat, or it cannot be tried. */
const SAVABLE = new Set<CredentialCheck["verdict"]>([
  "valid",
  "warning",
  "unchecked",
]);

/**
 * One credential slot's connect form (UX-69; reused inline by a storefront's Connect step for
 * platform admins, SETUP.md §2.12). The value is checked the moment it is pasted, or when a
 * field is left with every field filled; Save is enabled only after a pass for exactly the value
 * on screen. Nothing is sent anywhere but the Worker's check and save routes.
 */
export function ConnectForm({
  store,
  credential: c,
  onCancel,
  onSaved,
}: {
  store: PlatformStore;
  credential: PlatformStoreCredential;
  onCancel?: () => void;
  onSaved?: () => void;
}): React.ReactElement | null {
  const shape = CONNECT_SHAPES[c.kind];
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [state, setState] = React.useState<CheckState>({ phase: "idle" });
  const [saving, setSaving] = React.useState(false);
  const latest = React.useRef(values);
  latest.current = values;
  const run = React.useRef(0);
  if (!shape) return null;
  const slot = c.slot;
  const vendor = STORE_VENDORS[store];

  const complete = (v: Record<string, string>) =>
    shape.fields.every((f) => (v[f.name] ?? "").trim() !== "");
  const wireOf = (v: Record<string, string>): unknown =>
    shape.wire === "object"
      ? Object.fromEntries(shape.fields.map((f) => [f.name, v[f.name] ?? ""]))
      : (v[shape.wire.text] ?? "");
  const keyOf = (v: Record<string, string>) => JSON.stringify(wireOf(v));
  const current = keyOf(values);

  const check = async (v: Record<string, string>, force = false) => {
    if (!complete(v)) return;
    const key = keyOf(v);
    if (!force && state.phase !== "idle" && "for" in state && state.for === key)
      return;
    const mine = ++run.current;
    setState({ phase: "checking", for: key });
    try {
      const r = await api.checkPlatformStoreCredential(store, slot, wireOf(v));
      if (mine === run.current)
        setState({ phase: "done", for: key, check: r.check });
    } catch (e) {
      if (mine !== run.current) return;
      const copy =
        e instanceof ApiError && e.status === 429
          ? {
              title: "Too many checks",
              description: "Wait a few minutes, then check again.",
            }
          : errorCopy(e);
      setState({
        phase: "error",
        for: key,
        title: copy.title,
        description: copy.description,
      });
    }
  };

  const set = (name: string, value: string) =>
    setValues((v) => ({ ...v, [name]: value }));
  /** After a paste lands in state, check what is now on screen. */
  const afterPaste = () =>
    window.setTimeout(() => void check(latest.current), 0);

  const readFile = async (file: File) => {
    const text = await readText(file);
    const next = { ...latest.current, [shape.file!.into]: text };
    // App Store Connect names the file AuthKey_<Key ID>.p8: a free, exact default.
    const fromName = /^AuthKey_([A-Za-z0-9]+)\.p8$/.exec(file.name)?.[1];
    if (fromName && shape.fields.some((f) => f.name === "keyId") && !next.keyId)
      next.keyId = fromName;
    setValues(next);
    void check(next);
  };

  const passed =
    state.phase === "done" &&
    state.for === current &&
    SAVABLE.has(state.check.verdict);
  const result =
    state.phase === "done" && state.for === current ? state.check : null;
  const fieldError = (name: string) =>
    result && result.verdict === "invalid" && result.field === `value.${name}`
      ? result.title
      : undefined;

  const save = async () => {
    if (!passed) return;
    setSaving(true);
    try {
      await api.putPlatformStoreCredential(store, slot, wireOf(values));
      toast.success(`${c.label} saved`, {
        description: "Stored in the console, sealed. It is never shown again.",
      });
      setValues({});
      setState({ phase: "idle" });
      void queryClient.invalidateQueries({ queryKey: qk.platformStores() });
      onSaved?.();
    } catch (e) {
      const copy = errorCopy(e);
      toast.error(copy.title, { description: copy.description });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-label={`Connect ${c.label}`}
      className="space-y-4 rounded-lg border border-border bg-surface-raised p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void (passed ? save() : check(values, true));
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-bold text-fg-strong">
          {c.configured ? `Replace the ${c.label}` : `Connect the ${c.label}`}
        </h4>
        {shape.file ? (
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-accent hover:underline focus-within:ring-2 focus-within:ring-focus">
            <Upload aria-hidden className="size-4" />
            {shape.file.label}
            <input
              type="file"
              accept={shape.file.accept}
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
                e.target.value = "";
              }}
            />
          </label>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {shape.fields.map((f) => (
          <FormField
            key={f.name}
            name={f.name}
            label={f.label}
            help={f.help}
            required
            value={values[f.name] ?? ""}
            onChange={(v: string) => set(f.name, v)}
            error={fieldError(f.name)}
            className={f.control === "textarea" ? "sm:col-span-2" : undefined}
          >
            {(field) =>
              f.control === "textarea" ? (
                <Textarea
                  {...field}
                  mono
                  rows={5}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={f.placeholder}
                  onPaste={afterPaste}
                  onBlur={() => void check(latest.current)}
                />
              ) : f.control === "secret" ? (
                <SecretInput
                  id={field.id}
                  name={field.name}
                  value={values[f.name] ?? ""}
                  onChange={(v) => set(f.name, v)}
                  aria-describedby={field["aria-describedby"]}
                  aria-invalid={field["aria-invalid"]}
                  aria-required
                  onPaste={afterPaste}
                  onBlur={() => void check(latest.current)}
                />
              ) : (
                <Input
                  {...field}
                  mono
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={f.placeholder}
                  onPaste={afterPaste}
                  onBlur={() => void check(latest.current)}
                />
              )
            }
          </FormField>
        ))}
      </div>

      <CheckOutcome state={state} current={current} vendor={vendor} />

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={saving} disabled={!passed}>
          Save key
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!complete(values) || state.phase === "checking"}
          onClick={() => void check(values, true)}
        >
          {result ? "Check again" : "Check"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        {!passed ? (
          <span className="text-xs text-fg-muted">
            Saved only after {vendor} accepts it.
          </span>
        ) : null}
      </div>
    </form>
  );
}

/** A chosen key file's text (FileReader: every browser, and the test DOM). */
function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(r.error ?? new Error("unreadable file"));
    r.readAsText(file);
  });
}

const VERDICT_TONE: Record<
  CredentialCheck["verdict"],
  "success" | "warning" | "danger" | "info"
> = {
  valid: "success",
  warning: "warning",
  invalid: "danger",
  unavailable: "warning",
  unchecked: "info",
};

/** The check's state under the form: checking, what was found, or why not. Announced politely. */
function CheckOutcome({
  state,
  current,
  vendor,
}: {
  state: CheckState;
  current: string;
  vendor: string;
}): React.ReactElement | null {
  if (state.phase === "idle" || state.for !== current) {
    return state.phase === "idle" ? null : (
      <p className="text-xs text-fg-muted">
        Changed since the last check. It is checked again when you paste or
        leave the field.
      </p>
    );
  }
  if (state.phase === "checking")
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-sm text-fg-muted"
      >
        <Spinner label="" />
        Checking with {vendor}…
      </div>
    );
  if (state.phase === "error")
    return (
      <Callout tone="danger" title={state.title} live>
        {state.description}
      </Callout>
    );
  return <CheckResult check={state.check} />;
}

/** One check's answer: what the store found, the fix, and the facts it reported. */
export function CheckResult({
  check,
}: {
  check: CredentialCheck;
}): React.ReactElement {
  return (
    <Callout
      tone={VERDICT_TONE[check.verdict]}
      title={check.title}
      live
      className="[&_dl]:mt-2"
    >
      {check.detail ? <p>{check.detail}</p> : null}
      {check.facts.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {check.facts.map((f) => (
            <React.Fragment key={f.label}>
              <dt className="text-fg-muted">{f.label}</dt>
              <dd className="min-w-0 break-all font-mono text-fg">{f.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
    </Callout>
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
