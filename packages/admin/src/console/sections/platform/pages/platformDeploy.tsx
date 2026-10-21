/**
 * The read-only deploy-time rows and the code limits (split from platformSettings.tsx by ST-09).
 */

import * as React from "react";
import {
  type PlatformDeployValue,
  type PlatformSettingsView,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import {
  formatCount,
  formatNumber,
  formatSpan,
} from "../../../../lib/format.js";
import {
  ENVIRONMENT_LABELS,
  label as labelOf,
} from "../../../../lib/labels.js";
import { Button } from "../../../../ui/Button.js";
import { Section } from "../../../../ui/Section.js";
import { SettingsRow } from "../../../templates/Settings.js";

const MIB = 1_048_576;
const GIB = 1_073_741_824;

export const IDENTITY_VARS = [
  "PLATFORM_ADMIN_GROUP",
  "ADMIN_OIDC_ISSUER",
  "ADMIN_OIDC_CLIENT_ID",
  "PLATFORM_OIDC_ISSUER",
  "PLATFORM_OIDC_CLIENT_ID",
  "OIDC_ISSUER_ALLOWLIST",
];
export const DELIVERY_VARS = [
  "PKEY_ENVIRONMENT",
  "CONSOLE_ORIGIN",
  "BLOB_ORIGIN",
  "PKG_ORIGIN",
  "IMG_ORIGIN",
  "BLOBS_BUCKET_NAME",
  "R2_ACCOUNT_ID",
  "GITHUB_APP_ID",
];
export const EMAIL_VARS = [
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
    help: "The OIDC issuer Polaris Locker and platform-provider products sign in against.",
    unset: "Not set",
  },
  PLATFORM_OIDC_CLIENT_ID: {
    label: "Platform identity provider client",
    help: "The OIDC client id Polaris Locker and platform-provider products use.",
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
    help: "Where download pages link install sources.",
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

export function DeployRow({
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
      id={`platform-setting-${item.name}`}
      compact
      label={meta.label}
      chip={item.name}
      help={meta.help || undefined}
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

function formatConstant(value: number, unit: string): string {
  if (unit === "seconds" || unit === "ms") {
    const ms = unit === "ms" ? value : value * 1000;
    // Whole days stay in days ("180 days", not "6 months"): retention is promised in days.
    if (ms >= 86_400_000 && ms % 86_400_000 === 0) {
      const days = ms / 86_400_000;
      return `${formatCount(days)} ${days === 1 ? "day" : "days"}`;
    }
    return formatSpan(ms);
  }
  if (unit === "bytes") {
    if (value >= GIB) return `${formatNumber(value / GIB, 2)} GiB`;
    if (value >= MIB) return `${formatNumber(value / MIB, 2)} MiB`;
    return `${formatNumber(value / 1024, 2)} KiB`;
  }
  if (unit === "days")
    return `${formatCount(value)} ${value === 1 ? "day" : "days"}`;
  return `${formatCount(value)} ${unit}`;
}

export function ConstantRow({
  view,
  name,
}: {
  view: PlatformSettingsView;
  name: string;
}): React.ReactElement | null {
  const c = view.constants.find((x) => x.name === name);
  return c ? <LimitRow limit={c} /> : null;
}

type Limit = PlatformSettingsView["constants"][number];

function LimitRow({ limit: c }: { limit: Limit }): React.ReactElement {
  return (
    <SettingsRow compact label={c.label} chip={c.name} help={c.help}>
      {formatConstant(c.value, c.unit)}
    </SettingsRow>
  );
}

export function LimitsSection({
  view,
}: {
  view: PlatformSettingsView;
}): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const shown = view.constants.filter(
    (c) => c.name !== "ADMIN_SESSION_TTL_SECONDS",
  );
  const groups = React.useMemo(() => {
    const by = new Map<string, Limit[]>();
    for (const c of shown) by.set(c.area, [...(by.get(c.area) ?? []), c]);
    return [...by];
  }, [shown]);
  if (shown.length === 0) return null;
  return (
    <Section
      variant="settings"
      id="platform-limits"
      headingLevel={3}
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
          ? groups.map(([area, rows]) => (
              <div
                key={area}
                role="group"
                aria-labelledby={`platform-limits-${slugOf(area)}`}
              >
                <h4
                  id={`platform-limits-${slugOf(area)}`}
                  className="px-5 pt-4 text-sm font-semibold text-fg-strong"
                >
                  {area}
                </h4>
                {rows.map((c) => (
                  <LimitRow key={c.name} limit={c} />
                ))}
              </div>
            ))
          : null}
      </div>
    </Section>
  );
}

const slugOf = (s: string): string => s.toLowerCase().replace(/\W+/g, "-");
