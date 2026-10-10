/**
 * Platform → Settings (notes/S-13 §9.1, chunk 4P-1; T4). The instance-wide settings page:
 *
 * - **Background jobs**: the four background-job settings of the A-13 registry (`LAZY_DELTAS`,
 *   `LAZY_DELTA_MAX_BYTES`, `BLOB_GC_MODE`, `BLOB_GC_GRACE_DAYS`), each its own save scope with its
 *   effective value and where it came from (`SourceBadge`: code default, deploy var, set in
 *   console). A deploy-time `off` on a kill switch is a hard off: the row is locked and says why.
 *   Every write carries `expectedVersion`; a 409 shows a reload-and-retry flow. Confirm levels
 *   come from the registry (`confirm`), per direction of change (ADMIN.md §5.2).
 * - **Identity & access**: the reserved display-name severity (`IDENTITY_RESERVED_DISPLAY_NAMES`,
 *   PX-W13) and the key-entry refusal switch (`KEYENTRY_REFUSALS`, PX-W9) as editable
 *   rows, then the deploy-time identity values.
 * - **Licensing**: the reserved entitlement-name severity (`LICENSING_RESERVED_NAMES`, S-19 §7.4,
 *   LX-05) and, read-only, every registered product whose catalog declares a reserved name and
 *   whether the declaration is compatible (`GET /platform/reserved-names`).
 * - The read-only inventory: identity and access, delivery, email and the code limits, all
 *   deploy-time.
 * - **Keyring**: the KEK keyring's state, read-only (`GET /products/kek`), plus the KEK
 *   configuration's presence. Rotation follows the runbook (`/docs/admin/kek/`).
 * - **Secrets**: presence only. The API never returns a value, a length or a hash.
 * - **History**: the settings writes of the platform trail (A-12 `platform_audit`).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  api,
  ApiError,
  type PlatformActivityItem,
  type PlatformDeployValue,
  type PlatformKekStatus,
  type PlatformReservedNames,
  type PlatformSetting,
  type PlatformSettingsView,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import {
  formatCount,
  formatNumber,
  formatSpan,
  fromSeconds,
} from "../../../../lib/format.js";
import {
  ENVIRONMENT_LABELS,
  label as labelOf,
} from "../../../../lib/labels.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageSkeleton, Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timeline, TimelineItem } from "../../../../ui/Timeline.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import {
  EditableRow,
  fetchSettingsHistory,
  formatPlatformValue,
  type HistoryPage,
} from "./platformSettingRow.js";
import { qk } from "../../../data/queries.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../../templates/Settings.js";

export function fetchPlatformSettings(): Promise<PlatformSettingsView> {
  return api.platformSettings();
}

export function fetchPlatformKek(): Promise<PlatformKekStatus> {
  return api.platformKek();
}

export function fetchPlatformReservedNames(): Promise<PlatformReservedNames> {
  return api.platformReservedNames();
}

const MIB = 1_048_576;

// ── The page ─────────────────────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: "platform-jobs", title: "Background jobs" },
  { id: "platform-licensing", title: "Licensing" },
  { id: "platform-identity", title: "Identity & access" },
  { id: "platform-delivery", title: "Delivery" },
  { id: "platform-email", title: "Email" },
  { id: "platform-limits", title: "Limits" },
  { id: "platform-keyring", title: "Keyring" },
  { id: "platform-secrets", title: "Secrets" },
  { id: "platform-history", title: "History" },
];

const WARNING_TITLES: Record<string, string> = {
  console_oidc_shared: "The console shares the customer sign-in client",
  kek_id_set: "PLATFORM_KEK_ID is set",
  kek_keyring_unusable: "The KEK keyring does not load",
  kek_legacy_open_only: "PLATFORM_KEK is kept as a legacy key",
  portal_session_secret_unset: "Portal sessions share the admin secret",
};

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
  // PX-W13: the editable identity settings (the reserved display-name severity) live here too.
  const identitySettings = view.settings.filter((s) => s.area === "identity");
  const showIdentity =
    identitySettings.length > 0 ||
    IDENTITY_VARS.some((n) => deploy.has(n)) ||
    view.constants.some((c) => c.name === "ADMIN_SESSION_TTL_SECONDS");
  // HA-10: the hosted-asset switch is the Delivery section's one editable row.
  const deliverySettings = view.settings.filter((s) => s.area === "delivery");
  const showDelivery =
    deliverySettings.length > 0 || DELIVERY_VARS.some((n) => deploy.has(n));
  const showEmail = EMAIL_VARS.some((n) => deploy.has(n));
  const showLimits = view.constants.some(
    (c) => c.name !== "ADMIN_SESSION_TTL_SECONDS",
  );
  // The rail lists only the sections this deployment has something to show in.
  const hidden = new Set([
    ...(showIdentity ? [] : ["platform-identity"]),
    ...(showDelivery ? [] : ["platform-delivery"]),
    ...(showEmail ? [] : ["platform-email"]),
    ...(showLimits ? [] : ["platform-limits"]),
  ]);

  return (
    <SettingsTemplate
      header={header}
      sections={SECTIONS.filter((s) => !hidden.has(s.id))}
    >
      {view.warnings.length > 0 ? (
        <div className="space-y-3" aria-label="Warnings" role="region">
          {view.warnings.map((w) => (
            <Callout
              key={w.code}
              tone="warning"
              title={WARNING_TITLES[w.code] ?? w.code}
            >
              {w.message}
            </Callout>
          ))}
        </div>
      ) : null}

      <SettingsSection
        id="platform-jobs"
        title="Background jobs"
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
        {view.settings
          .filter((s) => s.area === "background-jobs")
          .map((s) => (
            <EditableRow
              key={s.key}
              setting={s}
              storeAvailable={view.storeAvailable}
              propagationSeconds={view.propagationSeconds}
            />
          ))}
      </SettingsSection>

      <LicensingSection view={view} />

      {/* A section none of whose values this deployment reports is left out, not drawn empty. */}
      {showIdentity ? (
        <SettingsSection
          id="platform-identity"
          title="Identity & access"
          description="Reserved display names save on their own; everything else is deploy-time, and a console session can never widen its own access."
        >
          {identitySettings.map((s) => (
            <EditableRow
              key={s.key}
              setting={s}
              storeAvailable={view.storeAvailable}
              propagationSeconds={view.propagationSeconds}
            />
          ))}
          {IDENTITY_VARS.map((n) => (
            <DeployRow key={n} item={deploy.get(n)} />
          ))}
          <ConstantRow view={view} name="ADMIN_SESSION_TTL_SECONDS" />
        </SettingsSection>
      ) : null}

      {showDelivery ? (
        <SettingsSection
          id="platform-delivery"
          title="Delivery"
          description={
            deliverySettings.length > 0
              ? "Hosted assets save on their own; the hosts themselves are deploy-time."
              : undefined
          }
        >
          {deliverySettings.map((s) => (
            <EditableRow
              key={s.key}
              setting={s}
              storeAvailable={view.storeAvailable}
              propagationSeconds={view.propagationSeconds}
            />
          ))}
          {DELIVERY_VARS.map((n) => (
            <DeployRow key={n} item={deploy.get(n)} />
          ))}
        </SettingsSection>
      ) : null}

      {showEmail ? (
        <SettingsSection
          id="platform-email"
          title="Email"
          description="The email binding's allowed senders still restrict it."
        >
          {EMAIL_VARS.map((n) => (
            <DeployRow key={n} item={deploy.get(n)} />
          ))}
        </SettingsSection>
      ) : null}

      <LimitsSection view={view} />

      <KeyringSection
        deploy={deploy}
        secrets={secrets}
        warning={kekWarning?.message}
      />

      <SecretsSection view={view} />

      <HistorySection settings={view.settings} />
    </SettingsTemplate>
  );
}

// ── Licensing ────────────────────────────────────────────────────────────────────────────────

const RESERVED_TYPE_WORDS: Record<string, string> = {
  string: "string",
  integer: "integer",
  "string-array": "array of strings",
};

/**
 * Platform → Settings → Licensing (S-19 §7.4, LX-05): the reserved-names severity, the reserved
 * keys with the rule the platform applies, and every registered product that declares one.
 */
function LicensingSection({
  view,
}: {
  view: PlatformSettingsView;
}): React.ReactElement {
  const report = useQuery({
    queryKey: qk.platformReservedNames(),
    queryFn: fetchPlatformReservedNames,
  });
  const settings = view.settings.filter((s) => s.area === "licensing");
  const data = report.data;
  return (
    <SettingsSection
      id="platform-licensing"
      title="Licensing"
      description="A product's catalog flag may declare a system key the platform sets itself. A compatible declaration is always valid; this decides what happens to an incompatible one."
    >
      {settings.map((s) => (
        <EditableRow
          key={s.key}
          setting={s}
          storeAvailable={view.storeAvailable}
          propagationSeconds={view.propagationSeconds}
        />
      ))}
      {report.isPending ? (
        <div className="space-y-2 px-5 py-4" aria-busy>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : !data ? (
        <div className="px-5 py-4">
          <ErrorState
            error={report.error}
            onRetry={() => void report.refetch()}
          />
        </div>
      ) : (
        <>
          <SettingsRow
            label="Reserved keys"
            help={
              <>
                A declaration must keep the key&apos;s type and may only narrow
                it. Names under{" "}
                {data.prefixes.map((p, i) => (
                  <React.Fragment key={p}>
                    {i > 0
                      ? i === data.prefixes.length - 1
                        ? " and "
                        : ", "
                      : null}
                    <code className="font-mono">{p}</code>
                  </React.Fragment>
                ))}{" "}
                are reserved for future system keys.
              </>
            }
            align="block"
          >
            <ul className="divide-y divide-border" aria-label="Reserved keys">
              {data.keys.map((k) => (
                <li
                  key={k.key}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
                >
                  <span>
                    <code className="font-mono text-xs text-fg-strong">
                      {k.key}
                    </code>{" "}
                    <span className="text-xs text-fg-muted">
                      {RESERVED_TYPE_WORDS[k.type] ?? k.type}
                    </span>
                  </span>
                  <span className="text-right text-xs text-fg-muted">
                    {k.rule}
                  </span>
                </li>
              ))}
            </ul>
          </SettingsRow>
          {data.products.length === 0 ? (
            <div className="px-5 py-4">
              <EmptyState
                kind="first-run"
                variant="inline"
                title="No product declares a reserved name"
                description="Registered products whose catalog declares one are listed here with whether each declaration is compatible."
              />
            </div>
          ) : (
            data.products.map((p) => (
              <ReservedNamesProductRow key={p.slug} product={p} />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

function ReservedNamesProductRow({
  product,
}: {
  product: PlatformReservedNames["products"][number];
}): React.ReactElement {
  const bad = product.declarations.filter((d) => !d.compatible);
  return (
    <SettingsRow
      label={product.name}
      help={
        <>
          <span className="block font-mono text-xs">
            {product.slug} · catalog v{product.catalogVersion}
          </span>
          <ul
            className="mt-1 space-y-1"
            aria-label={`${product.name} declarations`}
          >
            {product.declarations.map((d) => (
              <li key={d.key}>
                <code className="font-mono text-xs">{d.key}</code>
                {d.compatible
                  ? " · compatible"
                  : ` · ${d.problem ?? "incompatible"}`}
              </li>
            ))}
          </ul>
        </>
      }
    >
      {bad.length > 0 ? (
        <StatusPill tone="warning">
          {bad.length === 1 ? "1 incompatible" : `${bad.length} incompatible`}
        </StatusPill>
      ) : (
        <span className="text-fg-muted">Compatible</span>
      )}
    </SettingsRow>
  );
}

// ── Read-only inventory ──────────────────────────────────────────────────────────────────────

const IDENTITY_VARS = [
  "PLATFORM_ADMIN_GROUP",
  "ADMIN_OIDC_ISSUER",
  "ADMIN_OIDC_CLIENT_ID",
  "PLATFORM_OIDC_ISSUER",
  "PLATFORM_OIDC_CLIENT_ID",
  "OIDC_ISSUER_ALLOWLIST",
];
const DELIVERY_VARS = [
  "PKEY_ENVIRONMENT",
  "CONSOLE_ORIGIN",
  "BLOB_ORIGIN",
  "PKG_ORIGIN",
  "IMG_ORIGIN",
  "BLOBS_BUCKET_NAME",
  "R2_ACCOUNT_ID",
  "GITHUB_APP_ID",
];
const EMAIL_VARS = [
  "EMAIL_SENDER_ADDRESS",
  "PORTAL_EMAIL_FROM",
  "EMAIL_PRODUCT_DAILY_CAP",
  "EMAIL_APPLE_RELAY",
];

const DEPLOY_LABELS: Record<
  string,
  { label: string; help: string; unset: string }
> = {
  PKEY_ENVIRONMENT: {
    label: "Environment",
    help: "",
    unset: "Not set",
  },
  PLATFORM_ADMIN_GROUP: {
    label: "Admin group",
    help: "Membership of this identity-provider group is console access.",
    unset: "Not set: nobody is a platform admin",
  },
  ADMIN_OIDC_ISSUER: {
    label: "Console identity provider issuer",
    help: "The OIDC issuer of the console's own sign-in client.",
    unset: "Not set: the console uses the platform client",
  },
  ADMIN_OIDC_CLIENT_ID: {
    label: "Console identity provider client",
    help: "The console's own OIDC client id. Operators only; customers never sign in through it.",
    unset: "Not set: the console uses the platform client",
  },
  PLATFORM_OIDC_ISSUER: {
    label: "Platform identity provider issuer",
    help: "The OIDC issuer the customer portal and platform-provider products sign in against.",
    unset: "Not set",
  },
  PLATFORM_OIDC_CLIENT_ID: {
    label: "Platform identity provider client",
    help: "The OIDC client id the customer portal and platform-provider products use.",
    unset: "Not set",
  },
  OIDC_ISSUER_ALLOWLIST: {
    label: "Custom issuer allowlist",
    help: "Hosts a product's repo manifest may name as a custom OIDC issuer. Anything else is refused.",
    unset: "Empty: every custom issuer is refused",
  },
  BLOB_ORIGIN: {
    label: "Bytes host",
    help: "The origin that serves release bytes. Requests there reach only byte routes.",
    unset: "Not set",
  },
  CONSOLE_ORIGIN: {
    label: "Console origin",
    help: "Where download pages link storefront feeds.",
    unset: "Not set",
  },
  BLOBS_BUCKET_NAME: {
    label: "Blob bucket",
    help: "The R2 bucket upload tickets are scoped to.",
    unset: "Not set",
  },
  R2_ACCOUNT_ID: {
    label: "Cloudflare account",
    help: "The account upload tickets are issued in.",
    unset: "Not set",
  },
  GITHUB_APP_ID: {
    label: "GitHub App",
    help: "The App that reads product repositories.",
    unset: "Not set: repositories cannot be linked",
  },
  PORTAL_EMAIL_FROM: {
    label: "Legacy sender",
    help: "Older sender setting. Only its address is read, and only while the sender address is not set.",
    unset: "Not set",
  },
  EMAIL_SENDER_ADDRESS: {
    label: "Sender address",
    help: "The one address sign-in and account mail is sent from.",
    unset: "Not set: mail is sent from noreply@plrs.im",
  },
  EMAIL_PRODUCT_DAILY_CAP: {
    label: "Daily cap per product",
    help: "The most passthrough sign-in emails one product sends in a day. A product's own cap wins.",
    unset: "Not set: 500",
  },
  EMAIL_APPLE_RELAY: {
    label: "Apple private relay",
    help: "Registered once the sender is registered with Apple's private email relay; until then relay recipients are refused.",
    unset: "Not registered",
  },
  PKG_ORIGIN: {
    label: "Registry host",
    help: "The origin that serves package feeds. Requests there reach only registry routes.",
    unset: "Not set",
  },
  IMG_ORIGIN: {
    label: "Image host",
    help: "The origin that serves products' public hosted images. Requests there reach only image routes.",
    unset: "Not set",
  },
};

function DeployRow({
  item,
}: {
  item: PlatformDeployValue | undefined;
}): React.ReactElement | null {
  if (!item) return null;
  const meta = DEPLOY_LABELS[item.name] ?? {
    label: item.name,
    help: "",
    unset: "Not set",
  };
  const value = item.value;
  return (
    <SettingsRow
      label={meta.label}
      help={
        <>
          {meta.help}
          <span className={cn("block font-mono text-xs", meta.help && "mt-1")}>
            {item.name}
          </span>
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        {value === null || (Array.isArray(value) && value.length === 0) ? (
          <span className="text-fg-muted">{meta.unset}</span>
        ) : Array.isArray(value) ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={meta.label}>
            {value.map((host) => (
              <li
                key={host}
                className="rounded-md border border-border bg-surface-sunken px-2 py-0.5 font-mono text-xs text-fg"
              >
                {host}
              </li>
            ))}
          </ul>
        ) : item.name === "PKEY_ENVIRONMENT" ? (
          <span>{labelOf(ENVIRONMENT_LABELS, value)}</span>
        ) : (
          <span className="font-mono text-xs text-fg [overflow-wrap:anywhere]">
            {value}
          </span>
        )}
      </div>
    </SettingsRow>
  );
}

const CONSTANT_LABELS: Record<string, { label: string; help: string }> = {
  ADMIN_SESSION_TTL_SECONDS: {
    label: "Console session length",
    help: "A console session ends after this, however active it is.",
  },
  AUDIT_RETENTION_SECONDS: {
    label: "Audit retention",
    help: "Audit and platform trail rows older than this are deleted nightly.",
  },
  BLOB_LOCK_AGE_SECONDS: {
    label: "Blob bucket age lock",
    help: "No object younger than this can be deleted. It must match the bucket's lock rule.",
  },
  MIN_GC_GRACE_SECONDS: {
    label: "Shortest collector grace",
    help: "The collector never deletes an object unreferenced for less than this.",
  },
  LAZY_DELTA_MAX_BYTES_CEILING: {
    label: "Lazy delta size ceiling",
    help: "The measured largest payload the delta consumer can encode.",
  },
};

function formatConstant(value: number, unit: string): string {
  if (unit === "seconds") {
    // Whole days stay in days ("180 days", not "6 months"): retention is promised in days.
    if (value >= 86_400 && value % 86_400 === 0) {
      const days = value / 86_400;
      return `${formatCount(days)} ${days === 1 ? "day" : "days"}`;
    }
    return formatSpan(value * 1000);
  }
  if (unit === "bytes") return `${formatNumber(value / MIB, 2)} MiB`;
  return `${formatCount(value)} ${unit}`;
}

function ConstantRow({
  view,
  name,
}: {
  view: PlatformSettingsView;
  name: string;
}): React.ReactElement | null {
  const c = view.constants.find((x) => x.name === name);
  if (!c) return null;
  const meta = CONSTANT_LABELS[c.name] ?? { label: c.name, help: "" };
  return (
    <SettingsRow
      label={meta.label}
      help={
        <>
          {meta.help}
          <span className="mt-1 block font-mono text-xs">{c.name}</span>
        </>
      }
    >
      {formatConstant(c.value, c.unit)}
    </SettingsRow>
  );
}

function LimitsSection({
  view,
}: {
  view: PlatformSettingsView;
}): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const shown = view.constants.filter(
    (c) => c.name !== "ADMIN_SESSION_TTL_SECONDS",
  );
  if (shown.length === 0) return null;
  return (
    <SettingsSection
      id="platform-limits"
      title="Limits"
      description="Built into this build: they change only through a code change, where review sees them."
      actions={
        <Button
          size="sm"
          variant="outline"
          aria-expanded={open}
          aria-controls="platform-limits-list"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : `Show ${shown.length}`}
        </Button>
      }
    >
      <div id="platform-limits-list" hidden={!open}>
        {open
          ? shown.map((c) => (
              <ConstantRow key={c.name} view={view} name={c.name} />
            ))
          : null}
      </div>
    </SettingsSection>
  );
}

// ── Keyring ──────────────────────────────────────────────────────────────────────────────────

const KEK_GROUPS: Record<string, string> = {
  keys: "Signing keys",
  secrets: "Product secrets",
  outletCredentials: "Outlet credentials",
  managed: "Managed secret values",
  platformCredentials: "Store connection credentials",
};

function KeyringSection({
  deploy,
  secrets,
  warning,
}: {
  deploy: Map<string, PlatformDeployValue>;
  secrets: Map<string, boolean>;
  warning?: string;
}): React.ReactElement {
  const kek = useQuery({
    queryKey: qk.platformKek(),
    queryFn: fetchPlatformKek,
    retry: false,
  });
  const k = kek.data;
  const ring = secrets.get("PLATFORM_KEK_KEYS");
  const single = secrets.get("PLATFORM_KEK");
  const activeVar = deploy.get("PLATFORM_KEK_ACTIVE")?.value;
  const idVar = deploy.get("PLATFORM_KEK_ID")?.value;
  const perKid = new Map<string, number>();
  for (const group of Object.values(k?.counts ?? {}))
    for (const [kid, n] of Object.entries(group))
      perKid.set(kid, (perKid.get(kid) ?? 0) + n);
  const groups = Object.entries(k?.counts ?? {}).filter(
    ([, g]) => Object.keys(g).length > 0,
  );
  return (
    <SettingsSection
      id="platform-keyring"
      title="Keyring"
      description="Read-only here: rotation is a deploy-time change; the runbook walks through it."
      actions={
        <a
          href="/docs/admin/kek/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
        >
          Keyring runbook
          <ExternalLink aria-hidden className="size-3.5" />
          <span className="sr-only">(opens the docs)</span>
        </a>
      }
    >
      {warning ? (
        <div className="px-5 py-4">
          <Callout tone="warning" title="PLATFORM_KEK_ID is set">
            {warning}
          </Callout>
        </div>
      ) : null}
      <SettingsRow label="Key configuration" align="block">
        <ul className="space-y-1.5">
          <PresenceItem name="PLATFORM_KEK_KEYS" set={ring} />
          <PresenceItem name="PLATFORM_KEK" set={single} />
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs">PLATFORM_KEK_ACTIVE</span>
            <PresenceValue value={activeVar} />
          </li>
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs">PLATFORM_KEK_ID</span>
            <PresenceValue value={idVar} />
          </li>
        </ul>
      </SettingsRow>
      {kek.isPending ? (
        <div className="pk-skeleton-group space-y-3 px-5 py-4" aria-hidden>
          <div className="pk-skeleton h-5 w-48 rounded-md" />
          <div className="pk-skeleton h-4 w-full rounded-md" />
          <div className="pk-skeleton h-4 w-2/3 rounded-md" />
        </div>
      ) : !k ? (
        <div className="px-5 py-4">
          {kek.error instanceof ApiError && kek.error.status === 503 ? (
            <Callout tone="danger" title="The platform keyring is unusable">
              {kek.error.message}. Every product&apos;s sealed values fail to
              open until it is fixed: start at Troubleshooting in the keyring
              runbook.
            </Callout>
          ) : (
            <ErrorState
              compact
              error={kek.error}
              onRetry={() => void kek.refetch()}
            />
          )}
        </div>
      ) : (
        <>
          <SettingsRow label="Active key">
            <span className="font-mono text-xs">{k.active}</span>
          </SettingsRow>
          <SettingsRow label="Keys in the ring" align="block">
            <ul className="space-y-1.5" aria-label="Keys in the ring">
              {[...new Set([...k.kids, ...perKid.keys()])].map((kid) => {
                const inRing = k.kids.includes(kid);
                const legacyOnly = k.legacy?.kid === kid && k.legacy.openOnly;
                return (
                  <li
                    key={kid}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <span className="font-mono text-xs">{kid}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-fg-muted">
                        {formatCount(perKid.get(kid) ?? 0)} sealed
                      </span>
                      {kid === k.active ? (
                        <StatusPill tone="success" size="sm">
                          Active
                        </StatusPill>
                      ) : legacyOnly ? (
                        <StatusPill tone="warning" size="sm">
                          Legacy, open only
                        </StatusPill>
                      ) : inRing ? (
                        <StatusPill tone="neutral" size="sm">
                          In ring
                        </StatusPill>
                      ) : (
                        <StatusPill tone="danger" size="sm">
                          Not in ring
                        </StatusPill>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </SettingsRow>
          <SettingsRow label="Re-seal progress">
            {k.unopenable > 0 ? (
              <Callout tone="danger" title="Values cannot be opened">
                {formatCount(k.unopenable)} sealed{" "}
                {k.unopenable === 1 ? "value is" : "values are"} under a key no
                longer in the ring. Put that key back in PLATFORM_KEK_KEYS.
              </Callout>
            ) : k.remaining > 0 ? (
              <StatusPill tone="warning">
                {formatCount(k.remaining)} still on an older key
              </StatusPill>
            ) : (
              <StatusPill tone="success">
                Every value is under the active key
              </StatusPill>
            )}
          </SettingsRow>
          {k.legacy ? <LegacyKeyRow legacy={k.legacy} /> : null}
          {groups.length > 0 ? (
            <SettingsRow label="Sealed values" align="block">
              <ul className="space-y-1.5">
                {groups.map(([group, counts]) => (
                  <li
                    key={group}
                    className="flex flex-wrap items-baseline justify-between gap-2"
                  >
                    <span>{KEK_GROUPS[group] ?? group}</span>
                    <span className="font-mono text-xs text-fg-muted">
                      {Object.entries(counts)
                        .map(([kid, n]) => `${kid}: ${formatCount(n)}`)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            </SettingsRow>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

/**
 * The legacy `PLATFORM_KEK` beside `PLATFORM_KEK_KEYS`: what is still sealed under it, and
 * whether `PLATFORM_KEK` can be deleted yet. The sweep moves the stored values; sealed Worker
 * secrets are re-sealed by hand, so they are named.
 */
function LegacyKeyRow({
  legacy,
}: {
  legacy: NonNullable<PlatformKekStatus["legacy"]>;
}): React.ReactElement {
  return (
    <SettingsRow label="Legacy key" align="block">
      <div className="space-y-2">
        <p className="text-sm text-fg-muted">
          {legacy.openOnly ? (
            <>
              PLATFORM_KEK is kept in the ring as{" "}
              <span className="font-mono text-xs text-fg">{legacy.kid}</span>,
              open only: nothing new is sealed under it.
            </>
          ) : (
            <>
              PLATFORM_KEK is a copy of the ring&apos;s{" "}
              <span className="font-mono text-xs text-fg">{legacy.kid}</span>{" "}
              key.
            </>
          )}
        </p>
        {legacy.safeToDelete ? (
          <StatusPill tone="success">Safe to delete PLATFORM_KEK</StatusPill>
        ) : legacy.remaining > 0 ? (
          <StatusPill tone="warning">
            {formatCount(legacy.remaining)} still under {legacy.kid}
          </StatusPill>
        ) : (
          <StatusPill tone="warning">
            Worker secrets still under {legacy.kid}
          </StatusPill>
        )}
        {legacy.workerSecrets.length > 0 ? (
          <p className="text-sm text-fg-muted">
            Re-seal and set again before deleting it:{" "}
            {legacy.workerSecrets.map((name, i) => (
              <React.Fragment key={name}>
                {i > 0 ? ", " : null}
                <span className="font-mono text-xs text-fg">{name}</span>
              </React.Fragment>
            ))}
            .
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}

/** A deploy var's value in the keyring list: the value, or the same "Not set" pill as a secret. */
function PresenceValue({ value }: { value: unknown }): React.ReactElement {
  return typeof value === "string" ? (
    <span className="font-mono text-xs text-fg">{value}</span>
  ) : (
    <StatusPill tone="neutral" size="sm">
      Not set
    </StatusPill>
  );
}

function PresenceItem({
  name,
  set,
}: {
  name: string;
  set: boolean | undefined;
}): React.ReactElement {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-mono text-xs">{name}</span>
      <StatusPill tone={set ? "success" : "neutral"} size="sm">
        {set ? "Set" : "Not set"}
      </StatusPill>
    </li>
  );
}

// ── Secrets ──────────────────────────────────────────────────────────────────────────────────

const SECRET_NOTES: Record<string, { what: string; unset?: string }> = {
  PLATFORM_KEK: {
    what: "Single platform KEK (legacy form of the ring; open only beside PLATFORM_KEK_KEYS)",
  },
  PLATFORM_KEK_KEYS: { what: "Platform KEK ring" },
  KEY_HASH_PEPPER: { what: "Pepper for license key and token hashes" },
  ADMIN_SESSION_SECRET: { what: "Console session signing" },
  PORTAL_SESSION_SECRET: {
    what: "Customer portal session signing",
    unset: "Falls back to ADMIN_SESSION_SECRET",
  },
  PLATFORM_OIDC_CLIENT_SECRET: {
    what: "Platform identity provider client secret",
  },
  ADMIN_OIDC_CLIENT_SECRET: {
    what: "Console identity provider client secret",
    unset: "Not needed while the console uses the platform client",
  },
  GITHUB_APP_PRIVATE_KEY: { what: "GitHub App private key" },
  GITHUB_WEBHOOK_SECRET: { what: "GitHub webhook signature secret" },
  R2_PARENT_ACCESS_KEY_ID: {
    what: "R2 parent access key id",
    unset: "Trusted publishing is off",
  },
  R2_PARENT_SECRET_ACCESS_KEY: {
    what: "R2 parent secret access key",
    unset: "Trusted publishing is off",
  },
  DOWNLOAD_TICKET_KEY: {
    what: "Portal download ticket signing",
    unset:
      "Licensed builds served from the bytes host cannot be downloaded from the portal",
  },
  DOWNLOAD_TICKET_KEY_PREVIOUS: {
    what: "Previous download ticket key, during a rotation",
    unset: "No rotation in progress",
  },
};

function SecretsSection({
  view,
}: {
  view: PlatformSettingsView;
}): React.ReactElement {
  return (
    <SettingsSection
      id="platform-secrets"
      title="Secrets"
      description="Values are never shown: not a length, not a hash. Set them with wrangler secret put."
    >
      <div className="px-5 py-4">
        <ul className="divide-y divide-border" aria-label="Worker secrets">
          {view.secrets.map((s) => {
            const note = SECRET_NOTES[s.name];
            return (
              <li
                key={s.name}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs text-fg-strong">{s.name}</p>
                  {note ? (
                    <p className="text-xs text-fg-muted">
                      {note.what}
                      {!s.set && note.unset ? `. ${note.unset}.` : null}
                    </p>
                  ) : null}
                </div>
                <StatusPill tone={s.set ? "success" : "neutral"} size="sm">
                  {s.set ? "Set" : "Not set"}
                </StatusPill>
              </li>
            );
          })}
        </ul>
      </div>
    </SettingsSection>
  );
}

// ── History ──────────────────────────────────────────────────────────────────────────────────

function fetchFirstHistoryPage(): Promise<HistoryPage> {
  return fetchSettingsHistory(null);
}

function snapshotValue(raw: unknown): unknown {
  return raw && typeof raw === "object" && "effective" in raw
    ? (raw as { effective: unknown }).effective
    : undefined;
}

function HistorySection({
  settings,
}: {
  settings: PlatformSetting[];
}): React.ReactElement {
  const history = useQuery({
    queryKey: qk.platformSettingsHistory(),
    queryFn: fetchFirstHistoryPage,
  });
  const [extra, setExtra] = React.useState<HistoryPage | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const first = history.data;
  React.useEffect(() => {
    setExtra(null);
    setError(null);
  }, [first]);
  const cursor = extra ? extra.nextCursor : (first?.nextCursor ?? null);
  const items = [...(first?.items ?? []), ...(extra?.items ?? [])];
  const loadMore = () => {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    fetchSettingsHistory(cursor)
      .then((page) =>
        setExtra((prev) => ({
          items: [...(prev?.items ?? []), ...page.items],
          nextCursor: page.nextCursor,
        })),
      )
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  };
  const byKey = new Map(settings.map((s) => [s.key, s]));
  const describe = (a: PlatformActivityItem): string | undefined => {
    const s = a.target ? byKey.get(a.target.id) : undefined;
    const before = snapshotValue(a.before);
    const after = snapshotValue(a.after);
    if (!s || before === undefined || after === undefined)
      return a.summary || undefined;
    return `${formatPlatformValue(s, before)} → ${formatPlatformValue(s, after)}`;
  };
  return (
    <SettingsSection id="platform-history" title="History">
      <div className="px-5 py-4">
        {history.isPending ? (
          <div aria-hidden className="pk-skeleton-group space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-4">
                <div className="pk-skeleton h-4 w-24 rounded-md" />
                <div className="pk-skeleton h-4 flex-1 rounded-md" />
              </div>
            ))}
          </div>
        ) : history.isError && !first ? (
          <ErrorState
            compact
            error={history.error}
            onRetry={() => void history.refetch()}
          />
        ) : items.length === 0 && !cursor ? (
          <EmptyState
            variant="inline"
            kind="first-run"
            title="No setting changes yet"
            description="Each change made here is recorded with who made it and the value before and after."
            docs="/docs/admin/activity/"
          />
        ) : (
          <>
            {items.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No setting changes in the most recent platform activity.
              </p>
            ) : null}
            <Timeline<PlatformActivityItem>
              label="Setting changes"
              items={items}
              getKey={(a) => a.id}
              getTime={(a) => fromSeconds(a.at)}
              loadMore={{
                onLoadMore: loadMore,
                hasMore: cursor !== null,
                loading,
              }}
              renderItem={(a) => {
                const s = a.target ? byKey.get(a.target.id) : undefined;
                const change = describe(a);
                return (
                  <TimelineItem
                    actor={
                      a.actor.name || a.actor.email
                        ? { name: a.actor.name || a.actor.email }
                        : "system"
                    }
                    verb={
                      a.action === "platform.setting.revert"
                        ? "reverted"
                        : "changed"
                    }
                    target={
                      <span className="font-medium text-fg-strong">
                        {s?.label ?? a.target?.id ?? "a setting"}
                        {change ? (
                          <span className="ml-1 font-normal text-fg-muted">
                            ({change})
                          </span>
                        ) : null}
                      </span>
                    }
                    at={fromSeconds(a.at)}
                    summary={a.summary || undefined}
                  />
                );
              }}
            />
            {error ? (
              <ErrorState compact error={error} onRetry={loadMore} />
            ) : null}
          </>
        )}
      </div>
    </SettingsSection>
  );
}
