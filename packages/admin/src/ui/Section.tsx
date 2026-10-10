import * as React from "react";
import { cn } from "../lib/cn.js";

/**
 * The one titled card both apps build pages from (EXPERIENCE.md §3, §4): radius `xl`, a header at
 * `px-5 py-3.5` over a rule, and elevation 1 in the light theme only (dark separates by surface).
 *
 * - `variant="content"` (the default; `Panel` is its alias): a dashboard or record panel. The
 *   header holds the title, an optional line of context and one action at its end ("All
 *   releases →"); the body is padded and grows to fill a stretched cell, so neighbouring panels
 *   share their top and bottom edges (`STRETCH_CELL` in `templates/Dashboard.tsx`).
 * - `variant="settings"`: a settings card. It is an anchor (`id`, focusable for the section rail),
 *   its body is a stack of `SettingsRow`s divided by rules (no padding: each row pads itself),
 *   the title can carry a `SourceBadge`, and `footer` holds the section's `SaveBar` when it saves
 *   on its own. `tone="danger"` is the danger zone.
 */
export interface SectionProps {
  variant?: "content" | "settings";
  /** The anchor id. Settings sections need one (the rail and deep links scroll to it). */
  id?: string;
  title: React.ReactNode;
  /** One line under the title, only when it says more than the title (EXPERIENCE.md §2). */
  description?: React.ReactNode;
  /** Beside the title: a `SourceBadge`. */
  source?: React.ReactNode;
  /** The header's end: one link or button for content; header actions for settings. */
  actions?: React.ReactNode;
  tone?: "default" | "danger";
  /** After the body: a settings section's `SaveBar`. */
  footer?: React.ReactNode;
  headingLevel?: 2 | 3;
  children: React.ReactNode;
  className?: string;
}

export function Section({
  variant = "content",
  id,
  title,
  description,
  source,
  actions,
  tone = "default",
  footer,
  headingLevel = 2,
  children,
  className,
}: SectionProps): React.ReactElement {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const autoId = React.useId();
  const headingId = id ? `${id}-heading` : autoId;
  const settings = variant === "settings";
  const danger = tone === "danger";
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      {...(settings ? { tabIndex: -1 } : {})}
      data-section={variant}
      className={cn(
        "flex flex-col rounded-xl border bg-surface-raised light:shadow-elevation-1",
        danger ? "border-danger-border" : "border-border",
        settings && "scroll-mt-20 outline-hidden",
        className,
      )}
    >
      {settings ? (
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <Heading
                id={headingId}
                className={cn(
                  "text-base font-semibold",
                  danger ? "text-danger" : "text-fg-strong",
                )}
              >
                {title}
              </Heading>
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
      ) : (
        // The title takes the free width and the action stays right, centred on the title; only
        // an action wider than what is left (a phone) wraps under the title.
        <div
          data-card-header=""
          className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Heading
                id={headingId}
                className={cn(
                  "text-base font-semibold",
                  danger ? "text-danger" : "text-fg-strong",
                )}
              >
                {title}
              </Heading>
              {source}
            </div>
            {description ? (
              <p className="text-sm text-fg-muted">{description}</p>
            ) : null}
          </div>
          {/* A labelled ghost button that ends the header meets the edge by its ink (the
              trailing ghost rule in styles.css; the header is a data-card-header). The action
              never sets the header's height: a 32 px sm button or a 36 px field beside a 24 px
              title would grow this header past its siblings', so it hangs 6 px into the padding
              (the layout lint's rhythm/header-height). */}
          {actions ? <div className="-my-1.5 max-w-full">{actions}</div> : null}
        </div>
      )}
      {settings ? (
        <div className="divide-y divide-border">{children}</div>
      ) : (
        <div className="min-w-0 flex-1 p-5">{children}</div>
      )}
      {footer}
    </section>
  );
}

export interface PanelProps extends Omit<SectionProps, "variant" | "actions"> {
  /** A link or button at the header's end ("All releases →"). */
  action?: React.ReactNode;
}

/** `Section variant="content"` under the console's older name (EXPERIENCE.md §3). */
export function Panel({ action, ...props }: PanelProps): React.ReactElement {
  return <Section {...props} variant="content" actions={action} />;
}
