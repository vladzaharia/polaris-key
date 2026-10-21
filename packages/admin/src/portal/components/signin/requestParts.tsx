import * as React from "react";
import { RadioGroup } from "radix-ui";
import { cn } from "../../../lib/cn.js";
import { t } from "../../../lib/copy.js";
import { Avatar } from "../Avatar.js";

/**
 * The pieces the app card's steps share (PX-14a; SIGN-IN.md §3.6 to §3.9): the person row, a
 * neutral radio group, a neutral callout and the entries meter. Ink states throughout: the
 * selected row and the focus ring are neutral, coral is identity only (D9a), and nothing here
 * ever uses amber or the danger colour for a limit.
 */

/** The step's one primary: the neutral ink button the card uses everywhere. */
export const PRIMARY_CLASS =
  "h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold";

/** Person row: avatar, name, email and **Not you?**, which ends this account's part of the flow. */
export function PersonRow({
  name,
  email,
  picture,
  onNotYou,
}: {
  name: string | null;
  email: string | null;
  picture: string | null;
  onNotYou: () => void;
}): React.ReactElement {
  return (
    <div
      data-person-row
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface-sunken px-3 py-2"
    >
      <Avatar name={name} email={email} picture={picture} size={40} />
      <div className="min-w-[12ch] flex-[1_1_12ch]">
        <p className="font-medium text-fg-strong [overflow-wrap:anywhere]">
          {name ?? email}
        </p>
        {name && email ? (
          <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
            {email}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onNotYou}
        className="inline-flex min-h-11 shrink-0 items-center rounded-sm px-1 text-sm underline decoration-2 underline-offset-4 hover:text-fg-strong"
      >
        {t("signin.notYou")}
      </button>
    </div>
  );
}

/** A neutral callout (UI-KITS DL6): a limit the person can fix, never a warning or an error. */
export function NeutralCallout({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      data-callout
      className="flex items-start gap-3 rounded-md border border-border bg-surface-sunken px-4 py-3 text-fg"
    >
      <span
        aria-hidden
        className="mt-0.5 shrink-0 text-fg-muted [&_svg]:size-5"
      >
        {icon}
      </span>
      <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
        {children}
      </div>
    </div>
  );
}

export interface ChoiceOption {
  value: string;
  /** The row's content: lines and tags, no controls. */
  children: React.ReactNode;
  /** Names the row for a screen reader (the title and its facts). */
  label: string;
}

/**
 * One radio group of rows, nothing selected unless `value` says so (a choice is never silent).
 * The error sits under the group, linked with `aria-describedby`; the primary stays enabled.
 */
export const ChoiceGroup = React.forwardRef<
  HTMLDivElement,
  {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: readonly ChoiceOption[];
    error?: string | null;
    id: string;
  }
>(function ChoiceGroup({ label, value, onChange, options, error, id }, ref) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-2">
      <RadioGroup.Root
        ref={ref}
        id={id}
        value={value}
        onValueChange={onChange}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="space-y-2"
      >
        {options.map((o) => {
          const checked = value === o.value;
          return (
            <RadioGroup.Item
              key={o.value}
              value={o.value}
              aria-label={o.label}
              data-checked={checked ? "" : undefined}
              className={cn(
                "relative flex min-h-14 w-full items-start gap-3 overflow-hidden rounded-md border px-3 py-3 text-start",
                "before:absolute before:inset-y-0 before:start-0 before:w-[3px]",
                "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
                checked
                  ? "border-border-strong bg-hover before:bg-[var(--pk-locker-accent)] forced-colors:border-[Highlight] forced-colors:outline forced-colors:outline-2 forced-colors:outline-[Highlight] forced-colors:before:bg-[Highlight]"
                  : "border-border-strong bg-surface-raised hover:bg-hover",
              )}
            >
              <span
                aria-hidden
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full outline-2 -outline-offset-2 outline-fg-muted data-[on]:outline-fg-strong"
                data-on={checked ? "" : undefined}
              >
                {checked ? (
                  <svg
                    viewBox="0 0 10 10"
                    className="size-2.5 text-fg-strong"
                    aria-hidden
                  >
                    <circle cx="5" cy="5" r="5" fill="currentColor" />
                  </svg>
                ) : null}
              </span>
              <span className="min-w-0 flex-1 space-y-1">{o.children}</span>
            </RadioGroup.Item>
          );
        })}
      </RadioGroup.Root>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
});

/** A neutral pill: a tier, a tag. Text, never colour alone. */
export function Pill({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span className="inline-flex items-center rounded-full border border-border-strong px-2 py-0.5 text-xs font-medium text-fg">
      {children}
    </span>
  );
}

/**
 * A seat or entry meter in ink: `used` segments in muted, the one `next` (if any) in strong ink,
 * the rest outlined. Never amber, never red: a full meter is a limit, not an error (auth-10).
 */
export function InkMeter({
  used,
  limit,
  next = false,
  label,
}: {
  used: number;
  limit: number;
  /** Mark the segment after the used ones (this entry, this seat). */
  next?: boolean;
  label: string;
}): React.ReactElement | null {
  if (!(limit > 0)) return null;
  const segments = Math.min(limit, 10);
  const share = (n: number): number => Math.round((n / limit) * segments);
  const filled = Math.min(segments, share(Math.min(used, limit)));
  return (
    <div
      role="img"
      aria-label={label}
      className="flex gap-1 forced-color-adjust-none"
      data-ink-meter
    >
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 flex-1 rounded-full forced-colors:border forced-colors:border-[CanvasText]",
            i < filled
              ? "bg-fg-muted forced-colors:bg-[CanvasText]"
              : next && i === filled
                ? "bg-fg-strong forced-colors:bg-[Highlight]"
                : "bg-surface-sunken ring-1 ring-inset ring-border-strong forced-colors:bg-[Canvas]",
          )}
        />
      ))}
    </div>
  );
}
