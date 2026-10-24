import * as React from "react";

/**
 * Screen-reader announcements (ADMIN.md §5.6, components.md §5.3).
 *
 * - `<LiveRegion message>`: a polite region whose text is announced whenever it changes.
 * - `announce(text)`: a fire-and-forget announcement through one shared polite region (mounted by
 *   `<Announcer />` once near the root; the kit gallery and the console mount it). Used by copy
 *   buttons ("Copied"), table filtering ("12 rows") and loading ("Licenses loaded").
 */
export function LiveRegion({
  message,
  id,
  politeness = "polite",
}: {
  message: string;
  id?: string;
  politeness?: "polite" | "assertive";
}): React.ReactElement {
  return (
    <div
      id={id}
      role={politeness === "assertive" ? "alert" : "status"}
      aria-live={politeness}
      aria-atomic="true"
      className="sr-only"
    >
      {message}
    </div>
  );
}

type Listener = (message: string) => void;
const listeners = new Set<Listener>();
let last = "";

/** Announce `message` politely. Repeating the same text still re-announces it. */
export function announce(message: string): void {
  last = message;
  for (const l of listeners) l(message);
}

/**
 * Page announcements (focusRoute's "{title}, page loaded"). A route's initial load is covered by
 * it, so `useLoadingAnnouncement` asks `pageAnnouncementCovers` before saying "{noun} loaded".
 */
let pagePending = 0;
let pageEpoch = 0;
let pageSpokenAt = -Infinity;
const COVER_MS = 300;
const now = (): number => performance.now();

/** A page announcement is being awaited (focusRoute started). Returns its `end`. */
export function beginPageAnnouncement(): () => void {
  pagePending++;
  let open = true;
  return (): void => {
    if (!open) return;
    open = false;
    pagePending--;
  };
}

/** The page announcement was just spoken. */
export function markPageAnnounced(): void {
  pageEpoch++;
  pageSpokenAt = now();
}

/** A snapshot taken when a load starts; pass it to `pageAnnouncementCovers` when it ends. */
export function pageAnnouncementMark(): { epoch: number; early: boolean } {
  return {
    epoch: pageEpoch,
    early: pagePending > 0 || now() - pageSpokenAt < COVER_MS,
  };
}

/** True when the load that began at `mark` fell in a navigation's page announcement. */
export function pageAnnouncementCovers(mark: {
  epoch: number;
  early: boolean;
}): boolean {
  return mark.early || pagePending > 0 || pageEpoch !== mark.epoch;
}

/** The last announced text (tests). */
export function lastAnnouncement(): string {
  return last;
}

/** The shared polite region `announce()` writes to. Mount once. */
export function Announcer(): React.ReactElement {
  const [state, setState] = React.useState({ message: "", n: 0 });
  React.useEffect(() => {
    const l: Listener = (message) => setState((s) => ({ message, n: s.n + 1 }));
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  // Alternate a zero-width suffix so an identical message is still a text change.
  const text = state.message + (state.n % 2 ? "\u200b" : "");
  return <LiveRegion message={text} id="pk-announcer" />;
}
