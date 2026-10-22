/**
 * The Status tab's other cards (licenses.detail, licenses.detail-holders): the rail's **Duration**
 * (start to end, today marked) and **Origin**, the **Devices** summary, and the holder variants
 * that lead the main column for a license that is waiting (**Invitation**) or floating (**Anyone
 * with the key**, with its **Key batch** as the origin).
 *
 * Drawn only from what the Worker serves (CONSOLE-UX D1): no add-ons, no "keeps the last version"
 * line and no rule that issued the license; those wait for LX-35, LX-41 and LX-38.
 */

import * as React from "react";
import { ArrowRight, Laptop, Monitor } from "lucide-react";
import type {
  DeviceDto,
  LicenseBatch,
  LicenseDetail,
} from "../../../../api.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { Button } from "../../../../ui/Button.js";
import { Meter } from "../../../../ui/charts/Meter.js";
import { Section } from "../../../../ui/Section.js";
import {
  formatDate,
  formatRelative,
  fromSeconds,
} from "../../../../lib/format.js";
import { platformName } from "../../../../lib/vocab/platforms.js";
import { actorName, type SeatLimit } from "./shared.js";

const ORIGIN_TITLES = {
  admin: "By hand",
  oidc: "Sign-in",
  enroll: "Enrollment",
} as const;

/** One fact: a muted label at the start, the value flush at the end, a smaller line under it. */
function Fact({
  label,
  children,
  sub,
}: {
  label: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-3 text-sm">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words text-end text-fg-strong">
        {children}
        {sub ? (
          <span className="mt-0.5 block text-xs text-fg-muted">{sub}</span>
        ) : null}
      </dd>
    </div>
  );
}

// ── Duration ─────────────────────────────────────────────────────────────────────────────────────

/** Where today sits between start and end, 0 to 100. */
export function dayProgress(start: number, end: number, now: number): number {
  if (end <= start) return 100;
  return Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
}

export function DurationCard({
  license,
  onChange,
  now = Date.now(),
}: {
  license: LicenseDetail;
  onChange: () => void;
  now?: number;
}): React.ReactElement {
  const start = fromSeconds(license.activatedAt);
  const end = license.expiresAt == null ? null : fromSeconds(license.expiresAt);
  const pct = end === null ? 0 : dayProgress(start, end, now);
  const expired = end !== null && end <= now;
  return (
    <Section
      id="duration"
      title="Duration"
      variant="settings"
      actions={
        <Button variant="outline" size="sm" onClick={onChange}>
          Change
        </Button>
      }
    >
      <div className="space-y-2 px-5 py-4">
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-sm conbig:grid-cols-1">
          <span className="text-fg-muted">{formatDate(start)}</span>
          <div
            className="relative h-1.5 rounded-full bg-border"
            role="img"
            aria-label={
              end === null
                ? "No end date"
                : `${Math.round(pct)} percent of the duration has passed`
            }
          >
            {end !== null ? (
              <div
                className="h-full rounded-full bg-fg-strong"
                style={{ width: `${pct}%` }}
              />
            ) : null}
          </div>
          <strong className="font-semibold text-fg-strong">
            {end === null ? "Lifetime" : formatDate(end)}
          </strong>
        </div>
        {end !== null ? (
          <p
            className="text-xs text-fg-muted"
            style={{ paddingInlineStart: `min(${pct}%, calc(100% - 9rem))` }}
          >
            {expired ? "Expired" : `Today · ${formatDate(now)}`}
          </p>
        ) : null}
      </div>
    </Section>
  );
}

// ── Origin ───────────────────────────────────────────────────────────────────────────────────────

export function OriginCard({
  slug,
  license,
  batch,
  me,
}: {
  slug: string;
  license: LicenseDetail;
  batch: LicenseBatch | null;
  me: Parameters<typeof actorName>[1];
}): React.ReactElement {
  const created = formatDate(fromSeconds(license.activatedAt));
  if (license.batchId && batch) {
    const by = actorName(batch.createdBy, me);
    return (
      <Section
        id="origin"
        title="Key batch"
        variant="settings"
        actions={
          <Button asChild variant="link" size="sm">
            <Link to={r.licenseBatch(slug, batch.id)}>
              Open batch
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </Button>
        }
      >
        <dl className="divide-y divide-border">
          <Fact label="Batch">{batch.label}</Fact>
          <Fact label="Created" sub={by ?? undefined}>
            {formatDate(fromSeconds(batch.createdAt))}
          </Fact>
          <Fact label="Used">
            <span className="tabular-nums">
              {batch.used} of {batch.count}
            </span>
          </Fact>
        </dl>
      </Section>
    );
  }
  return (
    <Section
      id="origin"
      title="Origin"
      variant="settings"
      actions={
        <Button asChild variant="link" size="sm">
          <Link to={r.activity(slug, { kind: "license", target: license.id })}>
            Open Activity
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </Button>
      }
    >
      <dl className="divide-y divide-border">
        {license.origin ? (
          <Fact label="Method">{ORIGIN_TITLES[license.origin]}</Fact>
        ) : null}
        <Fact label="Created">{created}</Fact>
      </dl>
    </Section>
  );
}

// ── Holder variants ──────────────────────────────────────────────────────────────────────────────

/** Waiting: the invitation went to an email that has not signed in yet. */
export function InvitationCard({
  email,
  onChangeEmail,
}: {
  email: string;
  onChangeEmail: () => void;
}): React.ReactElement {
  return (
    <Section
      id="invitation"
      title="Invitation"
      variant="settings"
      actions={
        <Button variant="outline" size="sm" onClick={onChangeEmail}>
          Change email…
        </Button>
      }
    >
      <dl className="divide-y divide-border">
        <Fact label="Sent to" sub="Waiting for sign-in">
          {email}
        </Fact>
      </dl>
    </Section>
  );
}

function deviceLine(d: DeviceDto): string {
  return [d.platform ? platformName(d.platform) : "", d.appVersion]
    .filter(Boolean)
    .join(" · ");
}

/** Floating: no holder, so the key itself activates devices. */
export function AnyoneWithKeyCard({
  devices,
}: {
  devices: DeviceDto[];
}): React.ReactElement {
  const first = [...devices].sort((a, b) => a.firstSeen - b.firstSeen)[0];
  return (
    <Section id="anyone" title="Anyone with the key" variant="settings">
      <dl className="divide-y divide-border">
        <Fact label="Key">Can't be shown again</Fact>
        <Fact label="First used">
          {first ? formatDate(fromSeconds(first.firstSeen)) : "Not used yet"}
        </Fact>
        {first ? (
          <Fact label="Device" sub={deviceLine(first) || undefined}>
            {first.label || first.deviceId}
          </Fact>
        ) : null}
      </dl>
    </Section>
  );
}

// ── Devices ──────────────────────────────────────────────────────────────────────────────────────

export function DevicesCard({
  slug,
  license,
  seats,
}: {
  slug: string;
  license: LicenseDetail;
  seats: SeatLimit;
}): React.ReactElement {
  const shown = [...license.devices]
    .filter((d) => d.status !== "deauthorized")
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 5);
  return (
    <Section
      id="devices-summary"
      title="Devices"
      variant="settings"
      actions={
        seats.limit === null ? (
          <span className="text-sm text-fg-muted">
            {license.deviceCount} · no limit
          </span>
        ) : (
          <div className="w-40">
            <Meter
              label="Devices"
              hideLabel
              value={license.deviceCount}
              max={seats.limit}
              tone={license.deviceCount > seats.limit ? "warning" : "accent"}
            />
          </div>
        )
      }
    >
      {shown.length === 0 ? (
        <p className="px-5 py-4 text-sm text-fg-muted">
          A device appears here once it activates with one of this license's
          keys.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((d) => (
            <li
              key={d.deviceId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm"
            >
              <span
                aria-hidden
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-fg-muted"
              >
                {d.platform === "macos" || d.platform === "windows" ? (
                  <Laptop className="size-4" />
                ) : (
                  <Monitor className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-[1_1_6rem]">
                <span
                  className="block truncate font-medium text-fg-strong"
                  title={d.label || d.deviceId}
                >
                  {d.label || d.deviceId}
                </span>
                {deviceLine(d) ? (
                  <span
                    className="block truncate text-xs text-fg-muted"
                    title={deviceLine(d)}
                  >
                    {deviceLine(d)}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-end text-xs text-fg-muted">
                {formatRelative(fromSeconds(d.lastSeen))}
                <span
                  className="block"
                  title={formatDate(fromSeconds(d.firstSeen))}
                >
                  {formatDate(fromSeconds(d.firstSeen))}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {license.devices.length > shown.length ? (
        <div className="px-5 py-3 text-sm">
          <Button asChild variant="link" size="sm">
            <Link to={r.license(slug, license.id, "devices")}>
              All devices
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </Button>
        </div>
      ) : null}
    </Section>
  );
}
