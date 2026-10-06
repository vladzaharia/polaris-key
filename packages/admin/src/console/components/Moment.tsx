/**
 * The console's first-time moments (EXPERIENCE.md §0.7; notes/S-23 §6.4; MO-11): first license,
 * first catalog publish, first release, store connected, product launched. Each shows **once per
 * product** (the key is `<moment>:<slug>`), as one quiet line with the success pattern beside it:
 * `<Celebration>` draws its check and bursts six plain sparks in the section accent, never the
 * Polaris mark, never a pill, never blocking input. Under reduced motion the check is static and
 * there is no burst; the line itself, and what it says, are the same.
 *
 * "Once" is stored, not remembered per mount: `ui/motion`'s `pk-moment:<key>` entry in
 * localStorage is written the moment the line is shown, so a refetch, a layout change, a remount
 * or a later visit never shows it again.
 *
 * "First" has to be new to count. A product older than this feature has long had its catalog and
 * its releases: the first time the console looks it records the moment as seen, silently, instead
 * of celebrating something months old. A moment counts as new when its milestone is recent:
 *
 * - its own time is within `RECENT_SECONDS` (a release's `publishedAt`), or
 * - with no time of its own, the console saw the product *before* the milestone within
 *   `RECENT_SECONDS` (a `pk-moment-before:<key>` entry holding when it last looked, kept fresh
 *   while a page shows the product before the milestone; it only ever enables a moment, never
 *   blocks one, and an old sighting simply stops counting), or
 * - the page saw it happen: it showed the product before the milestone and the milestone landed
 *   while it was open (a refetch brought the release), however long the tab had been open. That
 *   one is also announced, since it appears on its own.
 */

import * as React from "react";
import { cn } from "../../lib/cn.js";
import { Button } from "../../ui/Button.js";
import { announce } from "../../ui/LiveRegion.js";
import {
  Celebration,
  markMomentSeen,
  momentSeen,
} from "../../ui/motion/index.js";
import { PREF_KEYS } from "../storage.js";

/** How recent a milestone must be to be celebrated: a week. */
export const RECENT_SECONDS = 7 * 86_400;

/** A commit rewrites the stored "before" sighting once it is this old (seconds), not every time. */
const RESTAMP_SECONDS = 3600;

const BEFORE_PREFIX = PREF_KEYS.momentBeforePrefix;

/** The stored key of a console moment: once per product. */
export function momentKey(moment: ConsoleMoment, slug: string): string {
  return `${moment}:${slug}`;
}

export type ConsoleMoment =
  | "product-created"
  | "first-license"
  | "first-catalog"
  | "first-release"
  | "store-connected"
  | "product-launched";

/** What a page can tell about a moment's milestone right now. */
export type MomentObservation =
  /** Still loading, or the read failed: decide nothing yet. */
  | { state: "unknown" }
  /** The milestone has not happened. */
  | { state: "before" }
  /** It has; `at` (epoch seconds) is when, if the data says. */
  | { state: "after"; at?: number | null };

const nowSeconds = (): number => Date.now() / 1000;

function lastSeenBefore(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(BEFORE_PREFIX + key);
    const at = raw === null ? NaN : Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function markBefore(key: string): void {
  try {
    window.localStorage.setItem(
      BEFORE_PREFIX + key,
      String(Math.floor(nowSeconds())),
    );
  } catch {
    // storage unavailable: a moment with no time of its own will not be celebrated
  }
}

function forgetBefore(key: string): void {
  try {
    window.localStorage.removeItem(BEFORE_PREFIX + key);
  } catch {
    // nothing to forget
  }
}

/**
 * Does this mount show the moment `key`? Decided once, the first time `seen` says the milestone
 * has happened: true when the moment is new (see the module comment) and has not been shown
 * before. Once true it stays true for the life of the mount (a refetch neither hides nor replays
 * it); the line marks the key seen as it mounts, so a remount or a later visit gets false. While
 * the milestone has not happened the page keeps watching, and keeps its "before" sighting fresh:
 * when the milestone lands while the page is open, the moment shows there and then, and
 * `announcement` is said once in the polite live region (a moment found with the page's data is
 * part of the page, and is not announced).
 */
export function useMoment(
  key: string,
  seen: MomentObservation,
  announcement?: string,
): boolean {
  const [shown, setShown] = React.useState<string | null>(null);
  const decided = React.useRef<string | null>(null);
  // The key whose milestone this mount saw not yet happen: if it happens now, it happened here.
  const watched = React.useRef<string | null>(null);
  const message = React.useRef(announcement);
  message.current = announcement;
  const state = seen.state;
  const at = seen.state === "after" ? (seen.at ?? null) : null;
  // Every commit (no dependency list): a layout effect, so a moment found with the data is in the
  // first paint of it. It writes storage only when something changed or the sighting is stale.
  React.useLayoutEffect(() => {
    if (decided.current === key || state === "unknown") return;
    if (momentSeen(key)) {
      decided.current = key;
      return;
    }
    if (state === "before") {
      watched.current = key;
      const last = lastSeenBefore(key);
      if (last === null || nowSeconds() - last > RESTAMP_SECONDS)
        markBefore(key);
      return;
    }
    decided.current = key;
    const live = watched.current === key;
    const since = at ?? lastSeenBefore(key);
    if (live || (since !== null && nowSeconds() - since <= RECENT_SECONDS)) {
      setShown(key);
      if (live && message.current) announce(message.current);
      return;
    }
    // Reached before the console could see it happen: recorded, never celebrated late.
    markMomentSeen(key);
    forgetBefore(key);
  });
  return shown === key;
}

/** Record a moment as shown (the line does this itself as it mounts). */
function useMarkShown(key: string): void {
  React.useEffect(() => {
    markMomentSeen(key);
    forgetBefore(key);
  }, [key]);
}

/**
 * One moment, inline: the check and sparks, a bold line, optional detail and actions. For a moment
 * inside another surface (the New license dialog's Done step).
 */
export function MomentLine({
  momentKey: key,
  title,
  children,
  className,
}: {
  momentKey: string;
  title: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  useMarkShown(key);
  return (
    <div
      data-moment={key}
      className={cn("flex items-start gap-3 text-sm", className)}
    >
      <span className="shrink-0 text-accent-fg">
        <Celebration momentKey={key} size={20} />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-bold text-fg-strong">{title}</p>
        {children ? <div className="text-fg-muted">{children}</div> : null}
      </div>
    </div>
  );
}

/**
 * One moment as a card on a dashboard (Overview): the line, one action and Dismiss. Dismiss only
 * hides it for this visit; it has already been recorded as shown.
 */
export function MomentBanner({
  momentKey: key,
  title,
  detail,
  action,
  onDismiss,
}: {
  momentKey: string;
  title: React.ReactNode;
  detail?: React.ReactNode;
  /** One next step: a link or a button. */
  action?: React.ReactNode;
  onDismiss: () => void;
}): React.ReactElement {
  useMarkShown(key);
  return (
    <section
      aria-label={typeof title === "string" ? title : undefined}
      data-moment={key}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-surface-raised px-5 py-3 light:shadow-elevation-1"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3 text-sm">
        <span className="mt-px shrink-0 text-accent-fg">
          <Celebration momentKey={key} size={20} />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-bold text-fg-strong">{title}</p>
          {detail ? <p className="text-fg-muted">{detail}</p> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {action}
        <Button
          variant="ghost"
          size="sm"
          data-moment-dismiss=""
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    </section>
  );
}
