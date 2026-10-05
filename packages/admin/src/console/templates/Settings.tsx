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
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-fg-muted">
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

/** One settings card. `footer` holds the section's `SaveBar` when it saves on its own. */
export function SettingsSection({
  id,
  title,
  description,
  source,
  actions,
  tone = "default",
  children,
  footer,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  /** A `SourceBadge`. */
  source?: React.ReactNode;
  /** Header-end actions: "Revert to manifest…". */
  actions?: React.ReactNode;
  tone?: "default" | "danger";
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      tabIndex={-1}
      aria-labelledby={headingId}
      className={cn(
        "scroll-mt-20 rounded-lg border bg-surface-raised outline-hidden",
        tone === "danger" ? "border-danger-border" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id={headingId}
              className={cn(
                "text-base font-bold",
                tone === "danger" ? "text-danger" : "text-fg-strong",
              )}
            >
              {title}
            </h2>
            {source}
          </div>
          {description ? (
            <p className="text-sm text-fg-muted">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      <div className="divide-y divide-border">{children}</div>
      {footer}
    </section>
  );
}

/**
 * One setting: label and help on the left, the control (or read-only value) on the right.
 *
 * - `align="end"` (the default) is for compact controls and values: a switch, a pill, a short
 *   input, a select, a link or a button. The control sits flush right, beside the label on every
 *   width while it fits, and wraps under the label (still right-aligned) when it does not.
 * - `align="stretch"` is for wide editors (code editors, paired inputs): label and help left,
 *   the editor filling the right 3/5 at ≥ 1024 px, stacked full width below.
 * - `align="block"` is for editors that need the card's full width (radio cards): the label
 *   line on top, the editor full width under it.
 *
 * `aside` is a read-only status for the row ("Enforced now: …"), drawn flush right on the label
 * line in `stretch` and `block` rows and before the control in `end` rows.
 *
 * `htmlFor` ties the label to a control; for a read-only fact, omit it.
 */
export function SettingsRow({
  label,
  help,
  htmlFor,
  source,
  align = "end",
  aside,
  children,
  footer,
}: {
  label: React.ReactNode;
  help?: React.ReactNode;
  htmlFor?: string;
  /** A `SourceBadge` for this one value (Platform → Settings). */
  source?: React.ReactNode;
  align?: "end" | "stretch" | "block";
  aside?: React.ReactNode;
  children: React.ReactNode;
  /** A per-row `SaveBar` when the row saves on its own. */
  footer?: React.ReactNode;
}): React.ReactElement {
  const labelBlock = (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-bold text-fg-strong">
            {label}
          </label>
        ) : (
          <span className="text-sm font-bold text-fg-strong">{label}</span>
        )}
        {source}
      </div>
      {help ? <p className="text-sm text-fg-muted">{help}</p> : null}
    </div>
  );
  return (
    <div className="px-5 py-4" data-align={align}>
      {align === "block" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            <div className="min-w-0 flex-[1_1_16rem]">{labelBlock}</div>
            {aside ? (
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2 text-sm text-fg">
                {aside}
              </div>
            ) : null}
          </div>
          <div className="min-w-0 text-sm text-fg">{children}</div>
        </div>
      ) : align === "stretch" ? (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-6">
          <div className="min-w-0 space-y-2">
            {labelBlock}
            {aside ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
                {aside}
              </div>
            ) : null}
          </div>
          <div className="min-w-0 text-sm text-fg">{children}</div>
        </div>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0 flex-[1_1_16rem]">{labelBlock}</div>
          {/* Flush right, and so is every line of a value that wraps (a chain of pills). */}
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 text-right text-sm text-fg [&>:not(button)]:justify-end">
            {aside}
            {children}
          </div>
        </div>
      )}
      {footer}
    </div>
  );
}

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
        <p className="text-sm font-bold text-fg-strong">{title}</p>
        <p className="text-sm text-fg-muted">{consequence}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
