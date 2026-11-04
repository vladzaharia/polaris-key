import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { t } from "../../lib/copy.js";

/**
 * The pieces every step of the card shares (SIGN-IN.md §3.2 step slots): the h1 the card focuses
 * on a step change, the "or" rule, and the quiet links under a rule.
 */
export function AuthTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <h1
      tabIndex={-1}
      className={cn(
        "text-2xl/8 font-semibold text-fg-strong outline-none forced-colors:outline-none",
        className,
      )}
    >
      {children}
    </h1>
  );
}

/**
 * The step's one primary (SIGNIN-REDESIGN §4): the action fill, 48 px, Control type (16/24 at
 * 500), full width, no trailing arrow. Pair it with `variant="neutral" size="xl"`.
 */
export const AUTH_PRIMARY_CLASS =
  "h-auto min-h-12! w-full whitespace-normal py-2 text-center text-base/6 font-medium";

/**
 * The one skin of every alternative way in and every decline (§4): a full-width 48 px outlined
 * button, `--pk-border-strong`, Control type in `--pk-text-strong`, a 20 px icon and the label centred as
 * one run. Pair it with `variant="outline" size="xl"` (or `<a>` with `METHOD_LINK_CLASS`).
 */
export const AUTH_METHOD_CLASS =
  "h-auto min-h-12! w-full whitespace-normal py-2 text-center text-base/6 font-medium text-fg-strong";

/** The same skin on a bare element (an anchor): what `Button variant="outline"` adds. */
export const AUTH_METHOD_ELEMENT_CLASS =
  "inline-flex h-auto min-h-12! w-full items-center justify-center gap-2 rounded-md border border-border-strong bg-transparent px-6 py-2 text-center text-base/6 font-medium text-fg-strong transition-colors duration-(--pk-duration-fast) hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&_svg]:size-5 [&_svg]:shrink-0";

/** The card's text input: 48 px at 16 px, focus is the 1 px border in strong ink, no ring, no offset (§4). */
export const AUTH_INPUT_CLASS =
  "h-12 pointer-coarse:h-12 text-base focus-visible:border-fg-strong focus-visible:outline-0 focus-visible:outline-offset-0";

/** A help line under a field or a checkbox (§2 Secondary: 14/20 at 400, muted). */
export const AUTH_HELP_CLASS = "text-sm/5 text-fg-muted";

/** The label above a field or a section (§2 Label: 14/20 at 500). */
export const AUTH_LABEL_CLASS = "block text-sm/5 font-medium text-fg-strong";

/**
 * The card's one link style (§6, BRAND §7.9): 14/20 at 400 in `--pk-text-default`, a 1 px
 * `--pk-border-strong` underline at a 3 px offset with skip-ink, `--pk-text-strong` on hover, the family's
 * focus ring. Never coral, never violet, no icon. A 44 px target under a coarse pointer.
 */
export const AUTH_LINK_CLASS =
  "inline-flex items-center justify-center rounded-sm text-sm/5 font-normal text-fg underline decoration-border-strong decoration-1 underline-offset-[3px] [text-decoration-skip-ink:auto] transition-colors duration-(--pk-duration-fast) hover:text-fg-strong hover:decoration-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus min-h-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

/** "or" between the email form and the other ways (§3.3): Secondary type, one 1 px hairline each side. */
export function OrDivider(): React.ReactElement {
  return (
    <div
      className="flex items-center gap-3 text-sm/5 text-fg-muted"
      aria-hidden
    >
      <span className="h-px flex-1 bg-border" />
      {t("signin.or")}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * The step's tertiary line (§6): one centred line of exits and switches (Back, Cancel, Use a
 * different email, Send a new code), items 24 px apart, wrapping. No rule above it. The coarse
 * pointer's 44 px targets are pulled back by a negative margin so the visible rhythm holds.
 */
export function QuietLinks({
  children,
}: {
  children: React.ReactNode;
  /** Kept for callers that drew the direct card's stacked list; the line is one row now. */
  stacked?: boolean;
}): React.ReactElement {
  return (
    <div
      data-quiet-links
      className="flex flex-wrap items-center justify-center gap-x-6 text-sm/5 pointer-coarse:-my-3"
    >
      {children}
    </div>
  );
}

export function QuietLink({
  onClick,
  disabled = false,
  children,
}: {
  onClick: () => void;
  /** Not usable right now (a request is in flight): stays focusable, does nothing, looks muted. */
  disabled?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      className={cn(
        AUTH_LINK_CLASS,
        "aria-disabled:cursor-default aria-disabled:opacity-60",
      )}
    >
      {children}
    </button>
  );
}

/**
 * A neutral notice with a glyph (UI-KITS DL6): an outcome the person can read at a glance, never a
 * tint of the accent. `role="alert"`, so it is announced when it replaces the waiting line.
 */
export function AuthNotice({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-fg"
    >
      <Info aria-hidden className="mt-0.5 size-5 shrink-0 text-fg-muted" />
      <p className="min-w-0 [overflow-wrap:anywhere]">{children}</p>
    </div>
  );
}

/**
 * Focus the step's h1 when `key` changes after the first render, and announce it once: a change
 * inside one card step (the gate's code stage, a device code restarted) replaces the control the
 * person pressed, and focus must not fall to the page (SIGN-IN.md §3.14). Render `live` once.
 */
export function useStepFocus(key: string): {
  ref: React.RefObject<HTMLDivElement | null>;
  live: React.ReactElement;
} {
  const ref = React.useRef<HTMLDivElement>(null);
  const [announce, setAnnounce] = React.useState("");
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const h1 = ref.current?.querySelector<HTMLElement>("h1");
    if (!h1) return;
    h1.focus({ preventScroll: true });
    setAnnounce(h1.textContent ?? "");
  }, [key]);
  return {
    ref,
    live: (
      <div aria-live="polite" data-step-announcer className="sr-only">
        {announce}
      </div>
    ),
  };
}
