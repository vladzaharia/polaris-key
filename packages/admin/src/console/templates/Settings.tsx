/**
 * T4 · Settings, a sectioned form (ADMIN.md §3): Services, Keys & secrets, Settings, Enrollment,
 * Access, Feed, Portal, and Platform → Settings (S-13 §9.1).
 *
 * - Sections are cards of settings rows: label and help left, the control flush right
 *   (`SettingsRow`, `align="stretch"` for wide editors).
 * - Section navigation, only with 3 or more sections: an anchor rail at ≥ 1280 px, pills under
 *   the header from 768 px, a picker below. The active section follows the scroll
 *   (`aria-current="location"`), and the section is kept in the address (`?section=`).
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

/** The first of `ids` that is on screen, following the scroll. `null` where nothing is observable. */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = React.useState<string | null>(ids[0] ?? null);
  const key = ids.join("|");
  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const list = key ? key.split("|") : [];
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = list.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: "-72px 0px -65% 0px" },
    );
    for (const id of list) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [key]);
  return active;
}

export function SettingsTemplate({
  header,
  sections,
  children,
}: {
  header: React.ReactNode;
  /** The sections, in order, for the section navigation. */
  sections: SettingsSectionRef[];
  /** `SettingsSection`s (and a final `DangerZone`). */
  children: React.ReactNode;
}): React.ReactElement {
  const rail = sections.length >= 3;
  const ids = React.useMemo(() => sections.map((s) => s.id), [sections]);
  const spied = useActiveSection(rail ? ids : []);
  const [wanted, setWanted] = useSearchParam("section", codecs.string());
  const active = spied && ids.includes(spied) ? spied : (ids[0] ?? null);
  // A shared link opens at its section, once.
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current || !wanted || !ids.includes(wanted)) return;
    opened.current = true;
    requestAnimationFrame(() => goTo(wanted));
  }, [wanted, ids]);
  const go = (id: string) => {
    goTo(id);
    // The section is part of the address, so it can be linked; the entry is replaced, not added.
    setWanted(id, { replace: true });
  };
  return (
    <div className="space-y-6" data-template="settings">
      {header}
      {rail ? (
        <>
          <nav
            aria-label="Jump to section"
            className="hidden md:block xl:hidden"
          >
            <ul className="flex gap-1.5 overflow-x-auto pb-1">
              {sections.map((s) => (
                <li key={s.id} className="shrink-0">
                  <a
                    href={`#${s.id}`}
                    aria-current={s.id === active ? "location" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      go(s.id);
                    }}
                    className={cn(
                      "block rounded-full border px-3 py-1 text-sm",
                      s.id === active
                        ? "border-border-strong bg-surface-sunken font-medium text-fg-strong"
                        : "border-border text-fg-muted hover:text-fg-strong",
                    )}
                  >
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="md:hidden">
            <select
              aria-label="Jump to section"
              value={active ?? ""}
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
        </>
      ) : null}
      <div
        className={cn(
          "mx-auto grid w-full max-w-[72rem] grid-cols-1 gap-6",
          rail && "xl:grid-cols-[12rem_minmax(0,1fr)]",
        )}
      >
        {rail ? (
          <nav aria-label="On this page" className="hidden xl:block">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-muted">
              On this page
            </p>
            <ul className="sticky top-4 space-y-1 border-l border-border text-sm">
              {sections.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    aria-current={s.id === active ? "location" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      go(s.id);
                    }}
                    className={cn(
                      "-ml-px block border-l-2 py-0.5 pl-3 hover:border-border-strong hover:text-fg-strong",
                      s.id === active
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
