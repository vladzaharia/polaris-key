/**
 * The registry tokens table's rows and columns (F-33b.4): a registry token, or a read service
 * token (`pkeyci_`, id `cit_…`) in the same shape, so one table and one revoke path serve both.
 */

import * as React from "react";
import {
  BadgeCheck,
  Building2,
  Gamepad2,
  Server,
  Upload,
  type LucideIcon,
} from "lucide-react";
import {
  type RegistryTokenDto,
  type ServiceTokenDto,
} from "../../../../api.js";
import {
  formatDate,
  formatRelative,
  fromSeconds,
} from "../../../../lib/format.js";
import { type DataColumn } from "../../../../ui/data-table/index.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { ECOSYSTEM_LABELS } from "../model/model.js";

export const STATUS_PILL: Record<
  RegistryTokenDto["status"],
  { tone: "success" | "neutral"; label: string }
> = {
  active: { tone: "success", label: "Active" },
  expired: { tone: "neutral", label: "Expired" },
  revoked: { tone: "neutral", label: "Revoked" },
};

/** Who created a token, in words: an operator's address, or the licensee in the Locker. */
function creatorOf(t: RegistryTokenDto): string {
  if (t.createdBy.startsWith("admin:")) return t.createdBy.slice(6);
  if (t.createdBy.startsWith("portal:")) return "Licensee, in Polaris Locker";
  return t.createdBy;
}

/** A row of the table: a registry token, or a read service token (`pkeyci_`, id `cit_…`). */
export type TokenRow = RegistryTokenDto & { service?: boolean };

/** A freshly created token and its one-time value (a registry token or a service token). */
export interface MintedRow {
  ok: true;
  token: string;
  view: TokenRow;
}

/** A service token in the registry token's shape: one table, one revoke path. */
export function serviceRow(t: ServiceTokenDto): TokenRow {
  return {
    ...t,
    hint: t.hint ?? "",
    ecosystems: null,
    binding: "owner",
    licenseId: null,
    presentation: "header",
    revokedBy: t.revokedBy ?? null,
    revokeReason: t.revokeReason ?? null,
    service: true,
  };
}

/** "Revoked by System · link removed": who ended a token, and why, in words. */
export function revokeNote(t: RegistryTokenDto): string {
  const by = t.revokedBy
    ? t.revokedBy.startsWith("admin:")
      ? t.revokedBy.slice(6)
      : t.revokedBy.startsWith("portal:")
        ? "Licensee"
        : t.revokedBy === "system"
          ? "System"
          : t.revokedBy
    : null;
  const why = t.revokeReason ? t.revokeReason.replace(/_/g, " ") : null;
  return [by ? `Revoked by ${by}` : "Revoked", why]
    .filter((x) => x !== null)
    .join(" · ");
}

/** A date in the console's format ("Dec 19, 2026"), from epoch seconds. */
export function dateOf(seconds: number): string {
  return formatDate(fromSeconds(seconds));
}

/** What a token reaches, in words, with the icon that says its kind. */
export function accessOf(
  t: TokenRow,
  forLicense: boolean,
): { Icon: LucideIcon; text: string } {
  const feeds = t.ecosystems
    ? t.ecosystems.map((e) => ECOSYSTEM_LABELS[e] ?? e).join(", ")
    : "every feed";
  if (t.service) return { Icon: Server, text: "Reads every private feed" };
  if (t.scopes.includes("publish"))
    return { Icon: Upload, text: `Publishes to ${feeds}` };
  if (t.presentation === "url")
    return {
      Icon: Gamepad2,
      text: forLicense
        ? "Godot editor URL"
        : `License ${t.licenseId} · Godot URL`,
    };
  if (t.binding === "license")
    return {
      Icon: BadgeCheck,
      text: forLicense ? `Reads ${feeds}` : `License ${t.licenseId} · ${feeds}`,
    };
  return { Icon: Building2, text: `Reads ${feeds}` };
}

function AccessCell({
  row,
  forLicense,
}: {
  row: TokenRow;
  forLicense: boolean;
}): React.ReactElement {
  const { Icon, text } = accessOf(row, forLicense);
  return (
    <span className="inline-flex min-w-[11rem] items-start gap-1.5">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
      <span>{text}</span>
    </span>
  );
}

/** The status pill, with who ended a revoked token beneath it. */
function StatusCell({ t }: { t: TokenRow }): React.ReactElement {
  if (t.legacy && t.status === "active")
    return (
      <StatusPill tone="warning">
        Legacy · works until {dateOf(t.expiresAt)}
      </StatusPill>
    );
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <StatusPill tone={STATUS_PILL[t.status].tone}>
        {STATUS_PILL[t.status].label}
      </StatusPill>
      {t.status === "revoked" && (t.revokedBy || t.revokeReason) ? (
        <span className="text-xs text-fg-muted">{revokeNote(t)}</span>
      ) : null}
    </span>
  );
}

/** The token's name and the line that matches it to the secret in CI. */
function TokenCell({ t }: { t: TokenRow }): React.ReactElement {
  const lead = t.service
    ? t.hint
      ? `pkeyci_…${t.hint}`
      : t.tokenId
    : t.tokenId;
  const rest = [
    t.service ? null : `…${t.hint}`,
    t.scopes.includes("publish") ? "read and publish" : null,
  ].filter((x): x is string => x !== null);
  return (
    <span className="inline-flex min-w-[min(16rem,100%)] flex-col">
      <span dir="auto" className="break-words">
        {t.label}
      </span>
      <span
        className="flex flex-wrap gap-x-1 font-mono text-xs text-fg-muted"
        title={t.tokenId}
      >
        <span className="whitespace-nowrap">{lead}</span>
        {rest.map((r) => (
          <span key={r} className="whitespace-nowrap">
            · {r}
          </span>
        ))}
      </span>
    </span>
  );
}

export function columns(forLicense: boolean): DataColumn<TokenRow>[] {
  return [
    {
      id: "token",
      header: "Token",
      accessorFn: (t) => t.label,
      meta: { priority: 1, primary: true, label: "Token" },
      cell: ({ row }) => <TokenCell t={row.original} />,
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (t) => t.status,
      meta: { priority: 1, label: "Status" },
      cell: ({ row }) => <StatusCell t={row.original} />,
    },
    {
      id: "access",
      header: "Access",
      accessorFn: (t) => accessOf(t, forLicense).text,
      meta: { priority: 2, label: "Access" },
      cell: ({ row }) => (
        <AccessCell row={row.original} forLicense={forLicense} />
      ),
    },
    {
      id: "createdBy",
      header: "Created by",
      accessorFn: (t) => creatorOf(t),
      meta: { priority: 3, label: "Created by" },
      cell: ({ row }) => (
        <span
          className="block max-w-[12rem] truncate"
          title={creatorOf(row.original)}
        >
          {creatorOf(row.original)}
        </span>
      ),
    },
    {
      id: "expiresAt",
      header: "Expires",
      accessorKey: "expiresAt",
      meta: { numeric: true, priority: 1, label: "Expires" },
      cell: ({ row }) => <Timestamp at={fromSeconds(row.original.expiresAt)} />,
    },
    {
      id: "lastUsedAt",
      header: "Last used",
      accessorFn: (t) => t.lastUsedAt ?? 0,
      meta: { numeric: true, priority: 1, label: "Last used" },
      cell: ({ row }) =>
        row.original.lastUsedAt ? (
          <Timestamp at={fromSeconds(row.original.lastUsedAt)} />
        ) : (
          <span className="text-fg-muted">Never</span>
        ),
    },
  ];
}

/** A phone card: the name, one meta line, and what a token reaches when that is not the default. */
export function TokenCard({
  row: t,
  primary,
  now,
  forLicense,
}: {
  row: TokenRow;
  primary: React.ReactNode;
  now: number;
  forLicense: boolean;
}): React.ReactElement {
  const meta =
    t.legacy && t.status === "active"
      ? `Legacy · works until ${dateOf(t.expiresAt)}`
      : t.status === "revoked"
        ? revokeNote(t)
        : t.status === "expired"
          ? `Expired ${dateOf(t.expiresAt)}`
          : `Active · expires ${dateOf(t.expiresAt)}`;
  const used = t.lastUsedAt
    ? `used ${formatRelative(fromSeconds(t.lastUsedAt), now)}`
    : "never used";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {primary}
      <p className="text-xs text-fg-muted">
        {meta} · {used}
      </p>
      {t.service ? null : (
        <p className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
          {(() => {
            const { Icon, text } = accessOf(t, forLicense);
            return (
              <>
                <Icon aria-hidden className="size-3.5 shrink-0" />
                {text}
              </>
            );
          })()}
        </p>
      )}
    </div>
  );
}
