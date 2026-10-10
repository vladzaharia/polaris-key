/**
 * T4 · Settings, a sectioned form (ADMIN.md §3): Services, Keys & secrets, Settings, Enrollment,
 * Access, Feed, Portal, and Platform → Settings (S-13 §9.1).
 *
 * - Sections are cards of settings rows: label and help left, the control flush right
 *   (`SettingsRow`, `align="stretch"` for wide editors).
 * - "On this page" is an anchor rail, only with 3 or more sections and at ≥ 1280 px.
 * - **One form per independently saved resource.** A section (or a single row, as Platform →
 *   Settings does) owns its own `useAdminForm` and `SaveBar`; the bar names its scope. Never one
 *   Save across two endpoints (UPS-1).
 * - `SourceBadge` and "Revert…" sit in the section header (`source`, `actions`).
 * - The danger zone is the last section, with a danger border; each action has its consequence.
 */

import * as React from "react";
import { cn } from "../../lib/cn.js";
import { Section, type SectionProps } from "../../ui/Section.js";

export interface SettingsSectionRef {
  id: string;
  title: string;
}

export function SettingsTemplate({
  header,
  sections,
  children,
}: {
  header: React.ReactNode;
  /** The sections, in order, for the "On this page" rail. */
  sections: SettingsSectionRef[];
  /** `SettingsSection`s (and a final `DangerZone`). */
  children: React.ReactNode;
}): React.ReactElement {
  const rail = sections.length >= 3;
  return (
    <div className="space-y-6" data-template="settings">
      {header}
      <div
        className={cn(
          "grid grid-cols-1 gap-6",
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
                    onClick={(e) => {
                      // The console's router owns the hash: scroll instead of navigating.
                      e.preventDefault();
                      const el = document.getElementById(s.id);
                      el?.scrollIntoView({ block: "start" });
                      el?.focus({ preventScroll: true });
                    }}
                    className="-ml-px block border-l-2 border-transparent py-0.5 pl-3 text-fg-muted hover:border-border-strong hover:text-fg-strong"
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
