import * as React from "react";
import { formatDay } from "../../model/library.js";
import { t } from "../../../lib/copy.js";

/**
 * The License card's term (PX-28a; portal.license's `.license-term`): the end of the license as a
 * line of text, then, when the Worker gave a start and an end, the term on a timeline from the
 * day it was activated to its end with today on it. A lifetime license is the word and no chart
 * (nothing to plot); an ended one reads "Ended <date>" with the track full.
 *
 * Neutral ink only (D9a: coral is identity, never state): the track is `border-strong` on the
 * sunken box and the elapsed part and the marker are strong text, so the chart reads in both
 * themes and with forced colors. The words say the state; the chart's text alternative is one
 * sentence (`role="img"`), its labels are drawn aria-hidden. `children` is the action under it
 * (Renew), so the term and what to do about it are one block.
 */
export function LicenseTerm({
  activatedAt,
  expiresAt,
  now,
  children,
}: {
  activatedAt: number | null;
  expiresAt: number | null;
  now: number;
  children?: React.ReactNode;
}): React.ReactElement {
  const ended = expiresAt !== null && expiresAt <= now;
  const headline =
    expiresAt === null
      ? t("signin.term.lifetime")
      : ended
        ? t("license.term.ended", { date: formatDay(expiresAt) })
        : t("signin.term.until", { date: formatDay(expiresAt) });
  const plot =
    expiresAt !== null && activatedAt !== null && activatedAt < expiresAt
      ? { start: activatedAt, end: expiresAt }
      : null;
  return (
    <div
      data-license-term=""
      className="space-y-3 rounded-lg border border-border bg-surface-sunken p-4"
    >
      <p className="font-semibold text-fg-strong">{headline}</p>
      {plot ? <Timeline {...plot} now={now} /> : null}
      {children}
    </div>
  );
}

/** The chart: a track, the elapsed part, today's marker and its label, the two end dates. */
function Timeline({
  start,
  end,
  now,
}: {
  start: number;
  end: number;
  now: number;
}): React.ReactElement {
  const at = Math.min(1, Math.max(0, (now - start) / (end - start))) * 100;
  const today = t("license.timeline.today", { date: formatDay(now, false) });
  return (
    <div
      role="img"
      aria-label={t("license.timeline.alt", {
        min: formatDay(start),
        max: formatDay(end),
        date: formatDay(now),
      })}
      className="space-y-1.5 text-xs text-fg-muted"
    >
      {/* The label sits over the marker and slides with it (translate by its own share of the
          width), so it never leaves the box at either end. */}
      <div aria-hidden className="relative h-4">
        <span
          className="absolute whitespace-nowrap font-medium text-fg-strong"
          style={{ left: `${at}%`, transform: `translateX(-${at}%)` }}
        >
          {today}
        </span>
      </div>
      <div
        aria-hidden
        className="relative h-2 rounded-full bg-border-strong forced-color-adjust-none forced-colors:bg-[GrayText]"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-fg-strong forced-colors:bg-[CanvasText]"
          style={{ width: `${at}%` }}
        />
        <span
          className="absolute top-1/2 size-3.5 rounded-full border-2 border-surface-sunken bg-fg-strong forced-colors:bg-[CanvasText]"
          style={{ left: `${at}%`, transform: `translate(-${at}%, -50%)` }}
        />
      </div>
      <div aria-hidden className="flex flex-wrap justify-between gap-x-3">
        <span>{formatDay(start)}</span>
        <span>{formatDay(end)}</span>
      </div>
    </div>
  );
}
