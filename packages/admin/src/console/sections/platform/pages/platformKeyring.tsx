/**
 * Platform → Settings → Keyring and Secrets (split from platformSettings.tsx by ST-09).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  api,
  ApiError,
  type PlatformDeployValue,
  type PlatformKekStatus,
  type PlatformSettingsView,
} from "../../../../api.js";
import { formatCount } from "../../../../lib/format.js";
import { Callout } from "../../../../ui/Callout.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { LegacyKeyRow, ResealProgressRow } from "./platformKeyringRows.js";
import { qk } from "../../../data/queries.js";
import { Section } from "../../../../ui/Section.js";
import { SettingsRow } from "../../../templates/Settings.js";

export function fetchPlatformKek(): Promise<PlatformKekStatus> {
  return api.platformKek();
}

const KEK_GROUPS: Record<string, string> = {
  keys: "Signing keys",
  secrets: "Product secrets",
  outletCredentials: "Channel credentials",
  managed: "Managed secret values",
  platformCredentials: "Store connection credentials",
};

export function KeyringSection({
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
    <Section
      variant="settings"
      id="platform-keyring"
      headingLevel={3}
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
          <ResealProgressRow status={k} />
          {k.legacy ? (
            <LegacyKeyRow legacy={k.legacy} complete={k.countsComplete} />
          ) : null}
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
    </Section>
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
    what: "Polaris Locker session signing",
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
    what: "Polaris Locker download ticket signing",
    unset:
      "Licensed builds served from the bytes host cannot be downloaded from Polaris Locker",
  },
  DOWNLOAD_TICKET_KEY_PREVIOUS: {
    what: "Previous download ticket key, during a rotation",
    unset: "No rotation in progress",
  },
};

export function SecretsSection({
  view,
}: {
  view: PlatformSettingsView;
}): React.ReactElement {
  return (
    <Section
      variant="settings"
      id="platform-secrets"
      headingLevel={3}
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
    </Section>
  );
}
