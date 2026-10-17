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
import { Callout } from "../../../../ui/Callout.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
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

const WARNING_TITLES: Record<string, string> = {
  console_oidc_shared: "The console shares the customer sign-in client",
  kek_id_set: "PLATFORM_KEK_ID is set",
  kek_keyring_unusable: "The KEK keyring does not load",
  kek_legacy_open_only: "PLATFORM_KEK is kept as a legacy key",
  portal_session_secret_unset: "Portal sessions share the admin secret",
};

function jump(id: string): void {
  const el = document.getElementById(id);
  el?.scrollIntoView({ block: "start" });
  el?.focus({ preventScroll: true });
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
        <PageSkeleton template="form" label="platform settings" />
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
    SECTION_OF_AREA[s.area] ?? "platform-advanced";
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
    has(IDENTITY_VARS) ||
    view.constants.some((c) => c.name === "ADMIN_SESSION_TTL_SECONDS");
  const showHosting =
    rowsIn("platform-hosting").length > 0 || has(DELIVERY_VARS);
  const showEmail = rowsIn("platform-email").length > 0 || has(EMAIL_VARS);
  const showDefaults = rowsIn("platform-defaults").length > 0;
  const showLicensing = true;
  const hidden = new Set<SectionId>([
    ...(showDefaults ? [] : (["platform-defaults"] as const)),
    ...(showSignin ? [] : (["platform-signin"] as const)),
    ...(showHosting ? [] : (["platform-hosting"] as const)),
    ...(showEmail ? [] : (["platform-email"] as const)),
  ]);

  return (
    <SettingsTemplate
      header={header}
      sections={SECTIONS.filter((s) => !hidden.has(s.id))}
    >
      <ReadySection view={view} deploy={deploy} />

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
          description="Reserved display names save on their own; everything else is deploy-time, and a console session can never widen its own access."
        >
          {rows("platform-signin")}
          {IDENTITY_VARS.map((n) => (
            <DeployRow key={n} item={deploy.get(n)} />
          ))}
          <ConstantRow view={view} name="ADMIN_SESSION_TTL_SECONDS" />
        </SettingsSection>
      ) : null}

      {showHosting ? (
        <SettingsSection
          id="platform-hosting"
          title="Storefront and hosting"
          description={
            rowsIn("platform-hosting").length > 0
              ? "The storefront and hosted assets save on their own; the hosts themselves are deploy-time."
              : undefined
          }
        >
          {rows("platform-hosting")}
          {DELIVERY_VARS.map((n) => (
            <DeployRow key={n} item={deploy.get(n)} />
          ))}
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

      <div id="platform-advanced" tabIndex={-1} className="space-y-6">
        <h2 className="text-lg font-semibold text-fg-strong">Advanced</h2>
        {rows("platform-advanced")}
        <LimitsSection view={view} />
        <KeyringSection
          deploy={deploy}
          secrets={secrets}
          warning={kekWarning?.message}
        />
        <SecretsSection view={view} />
      </div>

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
  to?: SectionId;
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
      to: "platform-advanced",
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
      to: "platform-signin",
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
  return items;
}

function ReadySection({
  view,
  deploy,
}: {
  view: PlatformSettingsView;
  deploy: Map<string, PlatformDeployValue>;
}): React.ReactElement {
  const items = readyItems(view, deploy);
  return (
    <SettingsSection
      id="platform-ready"
      title="Platform ready"
      actions={
        items.length === 0 ? (
          <StatusPill tone="success">Ready</StatusPill>
        ) : (
          <StatusPill tone="warning">{`${items.length} to fix`}</StatusPill>
        )
      }
    >
      {items.length === 0 ? (
        <SettingsRow label="Nothing needs attention">
          <span className="text-fg-muted">Sign-in, storage and keys load.</span>
        </SettingsRow>
      ) : (
        <div className="space-y-3 px-5 py-4" aria-label="To fix" role="region">
          {items.map((i) => (
            <Callout key={i.id} tone={i.tone} title={i.title}>
              {i.detail}
              {i.to ? (
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
                    Go to {SECTIONS.find((s) => s.id === i.to)?.title}
                  </a>
                </>
              ) : null}
            </Callout>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
