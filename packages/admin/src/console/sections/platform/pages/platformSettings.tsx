/**
 * Platform → Settings (notes/S-13 §9.1, S-18 §4.9; ST-09). The instance-wide settings page,
 * ordered by use and rendered from the registry: every area the Worker reports lands in a
 * section (`SECTION_OF_AREA`), and an area no section names falls to Advanced instead of
 * dropping silently.
 *
 *   Platform ready · Product defaults · Sign-in · Storefront and hosting · Email and alerts ·
 *   Licensing · Jobs · Advanced (limits, keyring, secrets) · Recently changed
 *
 * Every editable row is the shared settings engine (`EditableRow` → `ui/settings/SettingRow`):
 * its own save scope, the value in force and where it came from, `expectedVersion` on every
 * write. Deploy-time values are read-only rows. The header's History button jumps to the
 * platform trail at the foot, which pages back through it.
 *
 * Split by ST-09: licensing (`platformLicensing`), the deploy rows and code limits
 * (`platformDeploy`), keyring and secrets (`platformKeyring`), the trail (`platformHistory`).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import {
  api,
  type PlatformDeployValue,
  type PlatformSetting,
  type PlatformSettingsView,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Section } from "../../../../ui/Section.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { LiveRegion } from "../../../../ui/LiveRegion.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { useWriteGate } from "../../../access/useCan.js";
import { qk } from "../../../data/queries.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../../templates/Settings.js";
import {
  ConstantRow,
  DELIVERY_VARS,
  DeployRow,
  EMAIL_VARS,
  IDENTITY_VARS,
  LimitsSection,
} from "./platformDeploy.js";
import { FeedPolicySection } from "./platformFeedPolicy.js";
import { HistorySection } from "./platformHistory.js";
import { KeyringSection, SecretsSection } from "./platformKeyring.js";
import { LicensingSection } from "./platformLicensing.js";
import { EditableRow } from "./platformSettingRow.js";

export { fetchPlatformKek } from "./platformKeyring.js";
export { fetchPlatformReservedNames } from "./platformLicensing.js";

export function fetchPlatformSettings(): Promise<PlatformSettingsView> {
  return api.platformSettings();
}

type SectionId =
  | "platform-ready"
  | "platform-defaults"
  | "platform-signin"
  | "platform-hosting"
  | "platform-email"
  | "platform-licensing"
  | "platform-jobs"
  | "platform-advanced"
  | "platform-history";

/** The sections, in the order of use. The rail lists only those this deployment fills. */
const SECTIONS: { id: SectionId; title: string }[] = [
  { id: "platform-ready", title: "Platform ready" },
  { id: "platform-defaults", title: "Product defaults" },
  { id: "platform-signin", title: "Sign-in" },
  { id: "platform-hosting", title: "Storefront and hosting" },
  { id: "platform-email", title: "Email and alerts" },
  { id: "platform-licensing", title: "Licensing" },
  { id: "platform-jobs", title: "Jobs" },
  { id: "platform-advanced", title: "Advanced" },
  { id: "platform-history", title: "Recently changed" },
];

/** Which section a registry area is shown in. An unlisted area is shown under Advanced. */
export const SECTION_OF_AREA: Record<string, SectionId> = {
  "product-defaults": "platform-defaults",
  cloudSync: "platform-defaults",
  identity: "platform-signin",
  storefront: "platform-hosting",
  delivery: "platform-hosting",
  email: "platform-email",
  licensing: "platform-licensing",
  "background-jobs": "platform-jobs",
};

/** A setting that reads better elsewhere than its registry area says. */
const SECTION_OF_KEY: Record<string, SectionId> = {
  KEYENTRY_REFUSALS: "platform-licensing",
};

const WARNING_TITLES: Record<string, string> = {
  console_oidc_shared: "The console shares the customer sign-in client",
  kek_id_set: "PLATFORM_KEK_ID is set",
  kek_keyring_unusable: "The KEK keyring does not load",
  kek_legacy_open_only: "PLATFORM_KEK is kept as a legacy key",
  portal_session_secret_unset: "Customer portal sessions cannot be signed",
};

/** Where each Worker warning is fixed. */
const WARNING_TARGETS: Record<string, string> = {
  console_oidc_shared: "platform-identity",
  kek_id_set: "platform-keyring",
  kek_keyring_unusable: "platform-keyring",
  kek_legacy_open_only: "platform-keyring",
  portal_session_secret_unset: "platform-secrets",
};

const OPEN_ADVANCED = "platform-open-advanced";

function jump(id: string): void {
  const el = document.getElementById(id);
  if (!el && id.startsWith("platform-")) {
    // Inside the folded Advanced card: open it, then go.
    window.dispatchEvent(new Event(OPEN_ADVANCED));
    requestAnimationFrame(() => jump(id));
    return;
  }
  el?.scrollIntoView({ block: "start" });
  el?.focus({ preventScroll: true });
}

/** The loading shape: the template's rail column and cards, with no header of its own. */
function SettingsSkeleton(): React.ReactElement {
  return (
    <div
      data-skeleton="form"
      className="pk-skeleton-group mx-auto grid w-full max-w-[72rem] grid-cols-1 gap-6 xl:grid-cols-[12rem_minmax(0,1fr)]"
    >
      <LiveRegion message="Loading platform settings…" />
      <div aria-hidden className="hidden space-y-2 xl:block">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-4 w-28" />
        ))}
      </div>
      <div aria-hidden className="space-y-6">
        {[3, 2, 4].map((rows, i) => (
          <div
            key={i}
            className="space-y-4 rounded-lg border border-border bg-surface-raised p-5"
          >
            <Skeleton className="h-4 w-36" />
            {Array.from({ length: rows }, (_, r) => (
              <div key={r} className="flex items-center justify-between gap-6">
                <Skeleton className="h-3 w-48" />
                <Skeleton className="h-6 w-24" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Advanced: read-only deploy values, limits, keyring and secrets. Folded until asked for. */
function AdvancedSection({
  forceOpen,
  children,
}: {
  forceOpen: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = React.useState(forceOpen);
  React.useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_ADVANCED, on);
    return () => window.removeEventListener(OPEN_ADVANCED, on);
  }, []);
  return (
    <section
      id="platform-advanced"
      aria-labelledby="platform-advanced-title"
      tabIndex={-1}
      className="space-y-6 outline-none"
    >
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-raised px-5 py-4">
        <div className="min-w-0">
          <h2
            id="platform-advanced-title"
            className="text-lg font-semibold text-fg-strong"
          >
            Advanced
          </h2>
          <p className="text-sm text-fg-muted">
            Identity provider, limits, keyring and secrets. Read-only.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={open}
          aria-controls="platform-advanced-body"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      <div id="platform-advanced-body" hidden={!open} className="space-y-6">
        {open ? children : null}
      </div>
    </section>
  );
}

/** One notice for the whole page: a member with view and no edit. Each row shows only a lock. */
function ViewOnlyNotice(): React.ReactElement | null {
  const write = useWriteGate("platform");
  if (write.allowed || !write.canView) return null;
  return (
    <Callout tone="info" title="You can view these settings">
      {write.disabledReason}
    </Callout>
  );
}

export function PlatformSettingsPage(): React.ReactElement {
  const query = useQuery({
    queryKey: qk.platformSettings(),
    queryFn: fetchPlatformSettings,
  });
  const view = query.data;
  const header = (
    <PageHeader
      title="Settings"
      freshness={
        query.dataUpdatedAt
          ? {
              updatedAt: query.dataUpdatedAt,
              onRefresh: () => void query.refetch(),
              refreshing: query.isFetching,
            }
          : undefined
      }
      secondaryActions={[
        {
          label: "History",
          icon: <History aria-hidden className="size-4" />,
          onSelect: () => jump("platform-history"),
        },
      ]}
    />
  );

  if (query.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <SettingsSkeleton />
      </div>
    );
  }
  if (!view) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  const deploy = new Map(view.deployTime.map((d) => [d.name, d]));
  const secrets = new Map(view.secrets.map((s) => [s.name, s.set]));
  const kekWarning = view.warnings.find((w) => w.code === "kek_id_set");
  const sectionOf = (s: PlatformSetting): SectionId =>
    SECTION_OF_KEY[s.key] ?? SECTION_OF_AREA[s.area] ?? "platform-advanced";
  const rowsIn = (id: SectionId): PlatformSetting[] =>
    view.settings.filter((s) => sectionOf(s) === id);
  const rows = (id: SectionId) =>
    rowsIn(id).map((s) => (
      <EditableRow
        key={s.key}
        setting={s}
        storeAvailable={view.storeAvailable}
        propagationSeconds={view.propagationSeconds}
      />
    ));
  const has = (names: readonly string[]) => names.some((n) => deploy.has(n));
  const showSignin =
    rowsIn("platform-signin").length > 0 ||
    view.constants.some((c) => c.name === "ADMIN_SESSION_TTL_SECONDS");
  const showHosting =
    rowsIn("platform-hosting").length > 0 || has(DELIVERY_VARS);
  const showEmail = rowsIn("platform-email").length > 0 || has(EMAIL_VARS);
  const showDefaults = rowsIn("platform-defaults").length > 0;
  const showLicensing = true;
  const ready = readyItems(view, deploy);
  const hidden = new Set<SectionId>([
    ...(ready.length > 0 ? [] : (["platform-ready"] as const)),
    ...(showDefaults ? [] : (["platform-defaults"] as const)),
    ...(showSignin ? [] : (["platform-signin"] as const)),
    ...(showHosting ? [] : (["platform-hosting"] as const)),
    ...(showEmail ? [] : (["platform-email"] as const)),
  ]);

  return (
    <SettingsTemplate
      jump
      header={header}
      sections={SECTIONS.filter((s) => !hidden.has(s.id))}
    >
      <ViewOnlyNotice />
      <ReadySection items={ready} />

      {showDefaults ? (
        <SettingsSection
          id="platform-defaults"
          title="Product defaults"
          description="What a product starts from when it sets none of its own. A change reaches every product that inherits it."
        >
          {rows("platform-defaults")}
        </SettingsSection>
      ) : null}

      {showSignin ? (
        <SettingsSection
          id="platform-signin"
          title="Sign-in"
          description="Reserved display names save on their own. The identity provider is under Advanced; a console session can never widen its own access."
        >
          {rows("platform-signin")}
          <ConstantRow view={view} name="ADMIN_SESSION_TTL_SECONDS" />
        </SettingsSection>
      ) : null}

      {showHosting ? (
        <SettingsSection
          id="platform-hosting"
          title="Storefront and hosting"
          description={
            rowsIn("platform-hosting").length > 0
              ? "Hosted assets and package feeds save on their own; the hosts themselves are deploy-time."
              : undefined
          }
        >
          {rows("platform-hosting")}
          {DELIVERY_VARS.map((n) => (
            <DeployRow key={n} item={deploy.get(n)} />
          ))}
          <FeedPolicySection />
        </SettingsSection>
      ) : null}

      {showEmail ? (
        <SettingsSection
          id="platform-email"
          title="Email and alerts"
          description="The email binding's allowed senders still restrict it."
        >
          {rows("platform-email")}
          {EMAIL_VARS.map((n) => (
            <DeployRow key={n} item={deploy.get(n)} />
          ))}
        </SettingsSection>
      ) : null}

      {showLicensing ? (
        <LicensingSection rows={rows("platform-licensing")} />
      ) : null}

      <SettingsSection
        id="platform-jobs"
        title="Jobs"
        description={`Each setting saves on its own and reaches every Worker isolate within ${view.propagationSeconds} seconds. A deploy var of off on a switch is a hard off the console cannot override.`}
      >
        {!view.storeAvailable ? (
          <div className="px-5 py-4">
            <Callout tone="danger" title="The settings store cannot be read">
              The switches are off until it can be read again, and changes
              cannot be saved. Check the D1 binding and migrations on
              Deployment.
            </Callout>
          </div>
        ) : null}
        {rows("platform-jobs")}
      </SettingsSection>

      <AdvancedSection forceOpen={rowsIn("platform-advanced").length > 0}>
        {rows("platform-advanced")}
        {has(IDENTITY_VARS) ? (
          <Section
            variant="settings"
            id="platform-identity"
            headingLevel={3}
            title="Identity provider"
            description="Deploy-time, read-only: the console's own client above the platform client the portal and products use."
          >
            {IDENTITY_VARS.map((n) => (
              <DeployRow key={n} item={deploy.get(n)} />
            ))}
          </Section>
        ) : null}
        <LimitsSection view={view} />
        <KeyringSection
          deploy={deploy}
          secrets={secrets}
          warning={kekWarning?.message}
        />
        <SecretsSection view={view} />
      </AdvancedSection>

      <HistorySection settings={view.settings} />
    </SettingsTemplate>
  );
}

// ── Platform ready ───────────────────────────────────────────────────────────────────────────

interface ReadyItem {
  id: string;
  tone: "danger" | "warning";
  title: string;
  detail: string;
  to?: string;
}

/** What still needs doing before the platform is ready, from what the Worker already reports. */
export function readyItems(
  view: PlatformSettingsView,
  deploy: Map<string, PlatformDeployValue>,
): ReadyItem[] {
  const items: ReadyItem[] = [];
  if (!view.storeAvailable)
    items.push({
      id: "store",
      tone: "danger",
      title: "The settings store cannot be read",
      detail:
        "Switches are off until it can be read again. Check the D1 binding and migrations on Deployment.",
      to: "platform-jobs",
    });
  for (const w of view.warnings)
    items.push({
      id: w.code,
      tone: w.code === "kek_keyring_unusable" ? "danger" : "warning",
      title: WARNING_TITLES[w.code] ?? w.code,
      detail: w.message,
      to: WARNING_TARGETS[w.code] ?? "platform-advanced",
    });
  if (
    deploy.has("PLATFORM_ADMIN_GROUP") &&
    deploy.get("PLATFORM_ADMIN_GROUP")!.value === null
  )
    items.push({
      id: "admin-group",
      tone: "warning",
      title: "No admin group",
      detail: "Nobody is a platform admin until PLATFORM_ADMIN_GROUP is set.",
      to: "platform-identity",
    });
  if (
    deploy.has("GITHUB_APP_ID") &&
    deploy.get("GITHUB_APP_ID")!.value === null
  )
    items.push({
      id: "github-app",
      tone: "warning",
      title: "No GitHub App",
      detail:
        "Product repositories cannot be linked until GITHUB_APP_ID is set.",
      to: "platform-hosting",
    });
  // The most severe first: the banner shows only that one until it is expanded.
  return items
    .map((item, i) => ({ item, i }))
    .sort(
      (a, b) =>
        Number(b.item.tone === "danger") - Number(a.item.tone === "danger") ||
        a.i - b.i,
    )
    .map((x) => x.item);
}

function ReadySection({
  items,
}: {
  items: ReadyItem[];
}): React.ReactElement | null {
  const [all, setAll] = React.useState(false);
  if (items.length === 0) return null;
  const worst = items[0]!;
  const tone = items.some((i) => i.tone === "danger") ? "danger" : "warning";
  const goTo = (i: ReadyItem) =>
    i.to ? (
      <>
        {" "}
        <a
          href={`#${i.to}`}
          className="underline underline-offset-4"
          onClick={(e) => {
            e.preventDefault();
            jump(i.to!);
          }}
        >
          Go to{" "}
          {SECTIONS.find((s) => s.id === i.to)?.title ?? sectionName(i.to)}
        </a>
      </>
    ) : null;
  return (
    <section
      id="platform-ready"
      aria-label="Platform ready"
      tabIndex={-1}
      className="space-y-3 outline-none"
    >
      <Callout
        tone={tone}
        title={`${items.length} to fix: ${worst.title}`}
        action={
          items.length > 1 ? (
            <Button
              size="sm"
              variant="outline"
              aria-expanded={all}
              aria-controls="platform-ready-all"
              onClick={() => setAll((v) => !v)}
            >
              {all ? "Hide" : `Show all ${items.length}`}
            </Button>
          ) : undefined
        }
      >
        {worst.detail}
        {goTo(worst)}
      </Callout>
      {all ? (
        <ul id="platform-ready-all" className="space-y-2">
          {items.slice(1).map((i) => (
            <li key={i.id}>
              <Callout tone={i.tone} title={i.title}>
                {i.detail}
                {goTo(i)}
              </Callout>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function sectionName(id: string): string {
  return id === "platform-keyring"
    ? "Keyring"
    : id === "platform-identity"
      ? "Identity provider"
      : id === "platform-secrets"
        ? "Secrets"
        : "Advanced";
}
