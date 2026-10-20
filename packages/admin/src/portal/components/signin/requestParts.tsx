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
      className="flex items-center gap-3 rounded-md border border-border bg-surface-sunken px-3 py-2"
    >
      <Avatar name={name} email={email} picture={picture} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-fg-strong">{name ?? email}</p>
        {name && email ? (
          <p className="truncate text-sm text-fg-muted">{email}</p>
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
                "flex min-h-14 w-full items-start gap-3 rounded-md border bg-surface-raised px-3 py-3 text-left",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
                checked
                  ? "border-fg-strong ring-1 ring-fg-strong"
                  : "border-border-strong hover:bg-hover",
              )}
            >
              <span
                aria-hidden
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-fg-muted data-[on]:border-fg-strong"
                data-on={checked ? "" : undefined}
              >
                {checked ? (
                  <span className="size-2.5 rounded-full bg-fg-strong" />
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
    <div role="img" aria-label={label} className="flex gap-1" data-ink-meter>
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 flex-1 rounded-full",
            i < filled
              ? "bg-fg-muted"
              : next && i === filled
                ? "bg-fg-strong"
                : "bg-surface-sunken ring-1 ring-inset ring-border-strong",
          )}
        />
      ))}
    </div>
  );
}
