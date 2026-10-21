import * as React from "react";
import {
  AlertCircle,
  CalendarClock,
  Info,
  KeyRound,
  MonitorSmartphone,
  Sparkles,
  Store,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import type { PlatformKey } from "./Glyphs.js";
import { PlatformGlyphs } from "./Glyphs.js";
import type { TileFact, TileFacts as Facts } from "../model/tileFacts.js";

const FACT_ICON: Record<TileFact["kind"], LucideIcon> = {
  term: CalendarClock,
  store: Store,
  free: Sparkles,
  about: Info,
  note: AlertCircle,
};

/** The kit's small pill: a glyph and a word, never colour alone. */
function Pill({
  icon: Icon,
  tone = "neutral",
  className,
  children,
}: {
  icon: LucideIcon;
  tone?: "neutral" | "warning";
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium bigtext:max-w-full bigtext:whitespace-normal",
        tone === "warning"
          ? "border-warning-border bg-warning-subtle text-warning"
          : "border-border bg-surface-sunken text-fg-muted",
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

/**
 * A tile's facts as the kit draws them (portal.library, portal.discover): the tier and the device
 * count as pills (the count turns warning, with the alert glyph, at the limit), the platform
 * glyphs at the end of the first line, then one fact per line (`icon-lines`).
 */
export function TileFacts({
  facts,
  platforms,
  compact = false,
  className,
}: {
  facts: Facts;
  platforms: readonly PlatformKey[];
  /**
   * The 8+ grid (portal.library-12): the tier pill only, with the device count only at the limit
   * and no platform glyphs or lines: the art's pill already says Expired or Expires in …
   */
  compact?: boolean;
  className?: string;
}): React.ReactElement | null {
  const { tier } = facts;
  const devices = compact && !facts.devices?.atLimit ? null : facts.devices;
  // One line of meta (PX-35): the first fact; the 8+ grid keeps only "Free to use".
  const lines = compact
    ? facts.lines.filter((l) => l.kind === "free")
    : facts.lines.slice(0, 1);
  if (compact) platforms = [];
  if (!tier && !devices && platforms.length === 0 && lines.length === 0)
    return null;
  return (
    <div className={cn("space-y-1.5", className)}>
      {tier || devices || platforms.length ? (
        <div className="flex items-start justify-between gap-x-3 gap-y-1.5 @max-[13rem]/tile:flex-col">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {tier ? (
              <Pill icon={KeyRound} className="text-fg-strong">
                {tier}
              </Pill>
            ) : null}
            {devices ? (
              <Pill
                icon={devices.atLimit ? AlertCircle : MonitorSmartphone}
                tone={devices.atLimit ? "warning" : "neutral"}
              >
                {devices.text}
              </Pill>
            ) : null}
          </div>
          <PlatformGlyphs
            platforms={platforms}
            className="ms-auto h-5 shrink-0 @max-[13rem]/tile:ms-0"
          />
        </div>
      ) : null}
      {lines.length ? (
        <ul className="space-y-1 text-sm text-fg-muted">
          {lines.map((l) => (
            <li key={l.text} className="flex items-center gap-2">
              {React.createElement(FACT_ICON[l.kind], {
                "aria-hidden": true,
                className: "size-4 shrink-0",
              })}
              <span className="min-w-0">{l.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
