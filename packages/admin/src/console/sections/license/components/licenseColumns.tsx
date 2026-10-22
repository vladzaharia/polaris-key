/**
 * The Licenses table's columns (split from `LicensesPage.tsx`, which keeps the data and the
 * wiring): the cells, sort keys, CSV text and default visibility of each column.
 */

import * as React from "react";
import { type LicenseSummary } from "../../../../api.js";
import { fromSeconds } from "../../../../lib/format.js";
import { SIGN_IN_LABELS } from "../../../../lib/labels.js";
import { type DataColumn } from "../../../../ui/data-table/index.js";
import {
  DevicesCell,
  DurationCell,
  HolderPill,
  LicenseCell,
  OriginCell,
  SKELETON,
  TierPill,
  originLabel,
} from "./LicenseListParts.js";
import { HOLDER_STATE_LABELS, holderOf, holderState } from "./holders.js";
import {
  LICENSE_STATE_LABELS,
  licenseState,
  seatLimitText,
  type SeatLimit,
} from "./shared.js";

export interface LicenseColumnDeps {
  slug: string;
  /** "Now" in ms; moves with each fetch. */
  now: number;
  tierLabel: (id: string) => string;
  seatsOf: (l: LicenseSummary) => SeatLimit;
  batchLabel: (id: string) => string;
}

export function useLicenseColumns({
  slug,
  now,
  tierLabel,
  seatsOf,
  batchLabel,
}: LicenseColumnDeps): DataColumn<LicenseSummary>[] {
  return React.useMemo<DataColumn<LicenseSummary>[]>(
    () => [
      {
        id: "holder",
        header: "License",
        accessorFn: (l) => l.name || l.email || l.id,
        meta: {
          label: "License",
          priority: 1,
          primary: true,
          skeleton: SKELETON.license,
          csv: (l) =>
            l.name ||
            (holderOf(l).kind === "floating" ? "Floating" : l.email || ""),
        },
        cell: ({ row }) => <LicenseCell license={row.original} />,
      },
      {
        id: "holderState",
        header: "Holder",
        accessorFn: (l) => HOLDER_STATE_LABELS[holderState(l)],
        meta: { priority: 1, skeleton: SKELETON.capsule },
        cell: ({ row }) => <HolderPill license={row.original} />,
      },
      {
        id: "email",
        header: "Email",
        accessorKey: "email",
        meta: { defaultHidden: true },
      },
      {
        id: "id",
        header: "Id",
        accessorKey: "id",
        meta: { defaultHidden: true, mono: true },
      },
      {
        id: "tier",
        header: "Tier",
        accessorFn: (l) => (l.tier ? tierLabel(l.tier) : ""),
        meta: {
          priority: 1,
          skeleton: SKELETON.capsule,
          csv: (l) => (l.tier ? tierLabel(l.tier) : ""),
        },
        cell: ({ row }) => (
          <TierPill
            label={row.original.tier ? tierLabel(row.original.tier) : null}
          />
        ),
      },
      {
        id: "expires",
        header: "Duration",
        // Never-expiring licenses sort after every dated one.
        accessorFn: (l) => l.expiresAt ?? Number.MAX_SAFE_INTEGER,
        meta: {
          priority: 1,
          skeleton: SKELETON.duration,
          csv: (l) =>
            l.expiresAt == null
              ? ""
              : new Date(fromSeconds(l.expiresAt)).toISOString(),
        },
        cell: ({ row }) => <DurationCell license={row.original} now={now} />,
      },
      {
        id: "seats",
        header: "Devices",
        accessorKey: "deviceCount",
        meta: { priority: 1, skeleton: SKELETON.devices },
        cell: ({ row }) => {
          const l = row.original;
          // LX-14a: the limit the Worker enforces and where it comes from.
          const seats = seatsOf(l);
          return (
            <DevicesCell
              count={l.deviceCount}
              limit={seats.limit}
              from={seatLimitText(seats)}
            />
          );
        },
      },
      {
        id: "origin",
        header: "Origin",
        accessorFn: (l) => originLabel(l),
        // The first column to go: hidden below 1440 px, so a row never scrolls sideways.
        meta: { priority: 3, skeleton: SKELETON.duration },
        cell: ({ row }) => (
          <OriginCell
            license={row.original}
            slug={slug}
            batchLabel={batchLabel}
          />
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (l) => licenseState(l, now),
        meta: {
          defaultHidden: true,
          csv: (l) => LICENSE_STATE_LABELS[licenseState(l, now)],
        },
      },
      {
        id: "keys",
        header: "Keys",
        accessorKey: "activeKeyCount",
        meta: { defaultHidden: true, numeric: true },
      },
      {
        id: "batch",
        header: "Batch",
        accessorFn: (l: LicenseSummary) =>
          l.batchId ? batchLabel(l.batchId) : "",
        meta: { defaultHidden: true },
      },
      {
        id: "channel",
        header: "Release tracks",
        accessorFn: (l) => l.channels.join(", "),
        meta: { defaultHidden: true },
        cell: ({ getValue }) => (getValue() as string) || "—",
      },
      {
        id: "signin",
        header: "Sign-in",
        accessorFn: (l) =>
          SIGN_IN_LABELS[l.identityProvider] ?? l.identityProvider,
        meta: { defaultHidden: true },
      },
    ],
    [now, tierLabel, seatsOf, batchLabel, slug],
  );
}
