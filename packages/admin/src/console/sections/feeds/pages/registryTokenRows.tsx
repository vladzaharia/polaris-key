/**
 * The registry tokens table's rows and columns (F-33b.4): a registry token, or a read service
 * token (`pkeyci_`, id `cit_…`) in the same shape, so one table and one revoke path serve both.
 */

import * as React from "react";
import {
  BadgeCheck,
  Building2,
  Gamepad2,
  KeyRound,
  Server,
} from "lucide-react";
import {
  type RegistryTokenDto,
  type ServiceTokenDto,
} from "../../../../api.js";
import { fromSeconds } from "../../../../lib/format.js";
import { type DataColumn } from "../../../../ui/data-table/index.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { ECOSYSTEM_ICONS, ECOSYSTEM_LABELS } from "../model/model.js";

export const STATUS_PILL: Record<
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
  if (t.createdBy.startsWith("portal:")) return "Licensee, in Polaris Locker";
  return t.createdBy;
}

/** A row of the table: a registry token, or a read service token (`pkeyci_`, id `cit_…`). */
export type TokenRow = RegistryTokenDto & { service?: boolean };

/** A service token in the registry token's shape: one table, one revoke path. */
export function serviceRow(t: ServiceTokenDto): TokenRow {
  return {
    ...t,
    hint: "",
    ecosystems: null,
    binding: "owner",
    licenseId: null,
    presentation: "header",
    revokedBy: null,
    revokeReason: null,
    service: true,
  };
}

/** "System · link removed", "ada@x.io · manual": who ended a token, and why, in words. */
function revokeNote(t: RegistryTokenDto): string {
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

export function dateOf(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString();
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

export function columns(withBinding: boolean): DataColumn<TokenRow>[] {
  const cols: DataColumn<TokenRow>[] = [
    {
      id: "token",
      header: "Token",
      accessorFn: (t) => t.label,
      meta: { priority: 1, primary: true, label: "Token" },
      cell: ({ row }) => {
        const t = row.original;
        const Icon = t.service
          ? Server
          : t.presentation === "url"
            ? Gamepad2
            : KeyRound;
        return (
          <span className="inline-flex min-w-0 items-center gap-2">
            <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
            <span className="inline-flex min-w-0 flex-col">
              <span className="[overflow-wrap:anywhere]">{t.label}</span>
              <span className="break-all font-mono text-xs text-fg-muted">
                {t.service
                  ? `${t.tokenId} · read`
                  : `${t.tokenId} · …${t.hint}`}
                {t.scopes.includes("publish") ? " · read and publish" : ""}
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
      cell: ({ row }) => {
        const t = row.original;
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
      },
    },
    {
      id: "feeds",
      header: "Feeds",
      accessorFn: (t) => (t.ecosystems ?? ["*"]).join(","),
      meta: { priority: 2, label: "Feeds" },
      enableSorting: false,
      cell: ({ row }) =>
        row.original.service ? (
          <StatusPill tone="neutral" icon={null} size="sm">
            Every private feed
          </StatusPill>
        ) : (
          <FeedList ecosystems={row.original.ecosystems} />
        ),
    },
  ];
  if (withBinding)
    cols.push({
      id: "binding",
      header: "Bound to",
      accessorFn: (t) => (t.service ? "service" : (t.licenseId ?? "owner")),
      meta: { priority: 2, label: "Bound to" },
      cell: ({ row }) =>
        row.original.service ? (
          <span className="inline-flex items-center gap-1.5">
            <Server aria-hidden className="size-4 text-fg-muted" />
            Service
          </span>
        ) : row.original.binding === "license" ? (
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
  );
  return cols;
}
