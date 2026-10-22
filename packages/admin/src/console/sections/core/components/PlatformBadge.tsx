/**
 * A platform's badge on an Integration step (products.overview): a 28 px tile with the platform's
 * glyph and its state as a corner mark. Verified is a green tile with a tick, Waiting a clock,
 * After the console step an open ring, Not seen yet a dashed outline with no mark. A tile, never a
 * pill: a healthy state does not take pill shape. The full state is its name and title.
 */

import * as React from "react";
import { Check, Clock, Monitor, Server } from "lucide-react";
import { cn } from "../../../../lib/cn.js";
import {
  PLATFORM_ORDER,
  PlatformGlyph,
  type PlatformKey,
} from "../../../../ui/Glyphs.js";

export type PlatformBadgeState = "verified" | "waiting" | "after" | "unseen";

const isKey = (p: string): p is PlatformKey =>
  (PLATFORM_ORDER as readonly string[]).includes(p);

function Glyph({ platform }: { platform: string }): React.ReactElement {
  if (isKey(platform)) return <PlatformGlyph platform={platform} />;
  return platform === "server" ? (
    <Server aria-hidden className="size-4" />
  ) : (
    <Monitor aria-hidden className="size-4" />
  );
}

const TILE: Record<PlatformBadgeState, string> = {
  verified: "border-success-border bg-success-subtle text-success",
  waiting: "border-border bg-surface-sunken text-fg-muted",
  after: "border-border bg-surface-sunken text-fg-muted",
  unseen: "border-dashed border-border-strong bg-transparent text-fg-muted",
};

export function PlatformBadge({
  platform,
  label,
  state,
  title,
}: {
  platform: string;
  /** The platform's name ("macOS"). */
  label: string;
  state: PlatformBadgeState;
  /** The state in words, after "<label>: " ("Verified Oct 7, 10:42"). */
  title: string;
}): React.ReactElement {
  const name = `${label}: ${title}`;
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      data-platform={platform}
      data-state={state}
      className={cn(
        "relative inline-flex size-7 shrink-0 items-center justify-center rounded-md border",
        TILE[state],
      )}
    >
      <Glyph platform={platform} />
      {state === "unseen" ? null : (
        <span
          aria-hidden
          className="absolute -end-1 -bottom-1 inline-flex size-3.5 items-center justify-center rounded-full bg-surface-raised ring-2 ring-surface-raised"
        >
          {state === "verified" ? (
            <Check className="size-3 text-success" strokeWidth={3} />
          ) : state === "waiting" ? (
            <Clock className="size-3 text-fg-muted" />
          ) : (
            <span className="size-2.5 rounded-full border-2 border-fg-muted" />
          )}
        </span>
      )}
    </span>
  );
}
