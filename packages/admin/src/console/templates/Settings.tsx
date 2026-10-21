/**
 * T4 · Settings, a sectioned form (ADMIN.md §3): Services, Keys & secrets, Settings, Enrollment,
 * Access, Feed, Portal, and Platform → Settings (S-13 §9.1).
 *
 * - Sections are cards of settings rows: label and help left, the control flush right
 *   (`SettingsRow`, `align="stretch"` for wide editors).
 * - Section navigation, only with 3 or more sections: an anchor rail at ≥ 1280 px. A page that
 *   sets `jump` also gets sticky pills from 768 px and a picker below, follows the scroll
 *   (`aria-current="location"`) and keeps the section in the address (`?section=`).
 * - **One form per independently saved resource.** A section (or a single row, as Platform →
 *   Settings does) owns its own `useAdminForm` and `SaveBar`; the bar names its scope. Never one
 *   Save across two endpoints (UPS-1).
 * - `SourceBadge` and "Revert…" sit in the section header (`source`, `actions`).
 * - The danger zone is the last section, with a danger border; each action has its consequence.
 */

import * as React from "react";
import { cn } from "../../lib/cn.js";
import { Section, type SectionProps } from "../../ui/Section.js";
import { codecs, useSearchParam } from "../router.js";

export interface SettingsSectionRef {
  id: string;
  title: string;
}

/** Scroll to a section and give it focus (the router owns the hash, so no navigation). */
function goTo(id: string): void {
  const el = document.getElementById(id);
  el?.scrollIntoView({ block: "start" });
  el?.focus({ preventScroll: true });
}

/** The line below the top of the scroll area that a section's top must have passed to be current. */
const ACTIVE_LINE = 96;

/**
 * The current section: the last whose top is above the line; the last one at the foot of the page
 * (a short last section can never reach the line); the first before any has. Pure, for the test.
 */
export function activeSectionAt(
  tops: readonly number[],
  line: number,
  atBottom: boolean,
): number {
  if (tops.length === 0) return -1;
  if (atBottom) return tops.length - 1;
  let at = 0;
  tops.forEach((t, i) => {
    if (t <= line) at = i;
  });
  return at;
}

/** The scrolling ancestor of the sections: `main#content` in the console. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement)
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n;
  return null;
}

/**
 * Which section the reader is in, following the scroll. A section chosen by click or link is
 * marked at once and held while the page scrolls to it (and after, if it cannot reach the line);
 * the hold ends when the reader scrolls on their own.
 */
function useActiveSection(
  ids: string[],
  enabled: boolean,
  initial: string | null,
): [string | null, (id: string) => void] {
  const [active, setActive] = React.useState<string | null>(
    initial ?? ids[0] ?? null,
  );
  const hold = React.useRef<{
    id: string;
    settled: number | null;
    timer: number | undefined;
  } | null>(null);
  const topRef = React.useRef<() => number>(() => 0);
  const key = ids.join("|");
  React.useEffect(() => {
    if (!enabled) return;
    const list = key ? key.split("|") : [];
    const first = document.getElementById(list[0] ?? "");
    const scroller = scrollerOf(first);
    const target: HTMLElement | Window = scroller ?? window;
    const top = () => (scroller ? scroller.scrollTop : window.scrollY);
    topRef.current = top;
    let frame = 0;
    const compute = () => {
      frame = 0;
      const h = hold.current;
      if (h) {
        // Still moving toward the chosen section: keep it. Once the scroll stops, remember where.
        window.clearTimeout(h.timer);
        h.timer = window.setTimeout(() => {
          if (hold.current) hold.current.settled = top();
        }, 150);
        if (h.settled === null || Math.abs(top() - h.settled) < 8) return;
        hold.current = null;
      }
      const base = scroller ? scroller.getBoundingClientRect().top : 0;
      const els = list.map((id) => document.getElementById(id));
      const live = els.filter((e): e is HTMLElement => e !== null);
      const area = scroller ?? document.documentElement;
      const atBottom =
        area.scrollHeight -
          (scroller ? scroller.scrollTop : window.scrollY) -
          (scroller ? scroller.clientHeight : window.innerHeight) <
        4;
      const at = activeSectionAt(
        live.map((e) => e.getBoundingClientRect().top - base),
        ACTIVE_LINE,
        atBottom,
      );
      const id = live[at]?.id;
      if (id) setActive(id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(compute);
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    compute();
    return () => {
      target.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key, enabled]);
  const choose = React.useCallback((id: string) => {
    window.clearTimeout(hold.current?.timer);
    hold.current = {
      id,
      settled: null,
      // If the page never scrolls (the section is already there), the hold still ends.
      timer: window.setTimeout(() => {
        if (hold.current) hold.current.settled = topRef.current();
      }, 150),
    };
    setActive(id);
  }, []);
  return [active, choose];
}

function FadeEdge({
  children,
}: {
  children: (ref: React.RefObject<HTMLUListElement | null>) => React.ReactNode;
}): React.ReactElement {
  const ref = React.useRef<HTMLUListElement | null>(null);
  const [more, setMore] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () =>
      setMore(el.scrollWidth - el.scrollLeft - el.clientWidth > 2);
    check();
    el.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      el.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, []);
  return (
    <div
      style={
        more
          ? {
              maskImage:
                "linear-gradient(to right, black calc(100% - 2.5rem), transparent)",
              WebkitMaskImage:
                "linear-gradient(to right, black calc(100% - 2.5rem), transparent)",
            }
          : undefined
      }
    >
      {children(ref)}
    </div>
  );
}

export function SettingsTemplate({
  header,
  sections,
  children,
  jump = false,
}: {
  header: React.ReactNode;
  /** The sections, in order, for the section navigation. */
  sections: SettingsSectionRef[];
  /** `SettingsSection`s (and a final `DangerZone`). */
  children: React.ReactNode;
  /**
   * A long page that jumps between sections: sticky pills (tablet) and a picker (phone) join the
   * rail, the current section is marked as the page scrolls, and it is kept in the address
   * (`?section=`). Off, the rail only scrolls to the section.
   */
  jump?: boolean;
}): React.ReactElement {
  const rail = sections.length >= 3;
  const ids = React.useMemo(() => sections.map((s) => s.id), [sections]);
  const [wanted, setWanted] = useSearchParam("section", codecs.string());
  const [active, choose] = useActiveSection(
    ids,
    rail && jump,
    wanted && ids.includes(wanted) ? wanted : null,
  );
  // A shared link opens at its section, once.
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (!jump || opened.current || !wanted || !ids.includes(wanted)) return;
    opened.current = true;
    choose(wanted);
    requestAnimationFrame(() => goTo(wanted));
  }, [jump, wanted, ids, choose]);
  const go = (id: string) => {
    goTo(id);
    if (!jump) return;
    choose(id);
    // The section is part of the address, so it can be linked. Same page: the entry is replaced
    // and the unsaved-changes guard is not asked.
    setWanted(id, { replace: true, force: true });
  };
  const current = jump ? active : null;
  return (
    <div className="space-y-6" data-template="settings">
      {header}
      {rail && jump ? (
        <div className="sticky top-0 z-10 -mx-1 bg-surface-page px-1 py-2 xl:hidden">
          <nav aria-label="Jump to section" className="hidden md:block">
            <FadeEdge>
              {(ref) => (
                <ul ref={ref} className="flex gap-1.5 overflow-x-auto pb-1">
                  {sections.map((s) => (
                    <li key={s.id} className="shrink-0">
                      <a
                        href={`#${s.id}`}
                        aria-current={s.id === current ? "location" : undefined}
                        onClick={(e) => {
                          e.preventDefault();
                          go(s.id);
                        }}
                        className={cn(
                          "block rounded-full border px-3 py-1 text-sm",
                          s.id === current
                            ? "border-border-strong bg-surface-sunken font-medium text-fg-strong"
                            : "border-border text-fg-muted hover:text-fg-strong",
                        )}
                      >
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </FadeEdge>
          </nav>
          <div className="md:hidden">
            <select
              aria-label="Jump to section"
              value={current ?? ""}
              onChange={(e) => go(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface-raised px-3 text-sm text-fg-strong"
            >
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
      <div
        className={cn(
          "mx-auto grid w-full max-w-[72rem] grid-cols-1 gap-6",
          rail && "xl:grid-cols-[12rem_minmax(0,1fr)]",
        )}
      >
        {rail ? (
          <nav aria-label="On this page" className="hidden xl:block">
            <p className="mb-2 text-xs font-medium text-fg-muted">
              On this page
            </p>
            <ul className="sticky top-4 space-y-1 border-l border-border text-sm">
              {sections.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    aria-current={s.id === current ? "location" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      go(s.id);
                    }}
                    className={cn(
                      "-ml-px block border-l-2 py-0.5 pl-3 hover:border-border-strong hover:text-fg-strong",
                      s.id === current
                        ? "border-border-strong font-medium text-fg-strong"
                        : "border-transparent text-fg-muted",
                    )}
                  >
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </div>
  );
}

/**
 * One settings card: the shared `Section variant="settings"` (EXPERIENCE.md §3), from `ui/`.
 * `footer` holds the section's `SaveBar` when it saves on its own.
 */
export function SettingsSection({
  id,
  ...props
}: Omit<SectionProps, "variant" | "id" | "headingLevel"> & {
  id: string;
}): React.ReactElement {
  return <Section {...props} id={id} variant="settings" />;
}

/** The settings row is the shared engine layout (ST-07): `ui/settings/`. */
export { SettingsRow } from "../../ui/settings/SettingsRow.js";

/** The last section: a danger border, one row per destructive action. */
export function DangerZone({
  id = "danger-zone",
  children,
}: {
  id?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <SettingsSection id={id} title="Danger zone" tone="danger">
      {children}
    </SettingsSection>
  );
}

/** One destructive action: what it does, its consequence, and the button that opens its confirm. */
export function DangerAction({
  title,
  consequence,
  action,
}: {
  title: string;
  consequence: React.ReactNode;
  /** A `danger` Button that opens the matching `ConfirmDialog`. */
  action: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-semibold text-fg-strong">{title}</p>
        <p className="text-sm text-fg-muted">{consequence}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
