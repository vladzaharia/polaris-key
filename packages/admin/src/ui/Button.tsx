import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.js";
import { Spinner } from "./Spinner.js";
import { Tooltip } from "./Tooltip.js";

/**
 * The console's button (docs/design/admin/components.md §2.1).
 *
 * - `primary` is the section accent (`data-service` scoping): chartreuse in License, yellow in
 *   Config, violet on core pages. `danger` is the danger status, never a section colour.
 * - `loading` keeps the label, swaps the start icon for a spinner, sets `aria-busy` and ALWAYS
 *   disables the button; a caller's `disabled={false}` cannot re-enable it (fixes UI-1).
 * - `disabledReason` renders `aria-disabled` instead of `disabled`, so the button stays focusable,
 *   shows the reason in a tooltip and links it with `aria-describedby`; clicks do nothing. There
 *   is no `pointer-events: none` anywhere (fixes UI-2).
 * - `type` defaults to `"button"`, so a button inside a `<form>` never submits by accident; a
 *   submit button says `type="submit"` (fixes UI-3).
 * - `asChild` honours `loading` and `disabledReason` with `aria-disabled` and a click guard.
 * - Hover and press never snap (MO-08): the filled variants lighten their token colour by mixing,
 *   not with a `brightness` filter (filters are not transitioned and never animate per frame,
 *   S-23 §6.2), so the hover eases with the other colours; `pk-pressable` gives the press.
 */
export const buttonVariants = cva(
  [
    "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-normal",
    // The press pattern (src/motion.css `.pk-pressable`, S-23 §6.1): 0.98 on :active, never when
    // disabled or busy, with the colours at `micro`. Scale is paint only, so neighbours never move.
    "pk-pressable",
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
    "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
    "[&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-on shadow-elevation-1 hover:not-disabled:not-aria-disabled:bg-[color-mix(in_oklab,var(--pk-accent),white_10%)]",
        secondary:
          "bg-hover text-fg-strong hover:not-disabled:not-aria-disabled:bg-surface-sunken",
        outline:
          "border border-border-strong bg-transparent text-fg hover:not-disabled:not-aria-disabled:bg-hover hover:not-disabled:not-aria-disabled:text-fg-strong",
        ghost:
          "bg-transparent text-fg hover:not-disabled:not-aria-disabled:bg-hover hover:not-disabled:not-aria-disabled:text-fg-strong",
        danger:
          "bg-danger text-danger-on shadow-elevation-1 hover:not-disabled:not-aria-disabled:bg-[color-mix(in_oklab,var(--pk-danger),white_10%)]",
        /** Deprecated alias of `danger`, kept for the legacy views until chunk 11. */
        destructive:
          "bg-danger text-danger-on shadow-elevation-1 hover:not-disabled:not-aria-disabled:bg-[color-mix(in_oklab,var(--pk-danger),white_10%)]",
        link: "h-auto px-0 text-accent-fg underline-offset-4 hover:underline",
        /**
         * The customer portal's outlined quick action (PORTAL.md §5.2): transparent, a
         * `border-border-strong` outline, a `text-fg-strong` label, the icon in `text-accent-fg`.
         */
        quiet:
          "border border-border-strong bg-transparent font-bold text-fg-strong [&_svg]:text-accent-fg hover:not-disabled:not-aria-disabled:bg-hover",
        /**
         * The portal header's Activate license (PORTAL.md §5.2): `bg-surface-raised`, a
         * `border-border-strong` outline, the key glyph in `text-accent-fg`.
         */
        action:
          "border border-border-strong bg-surface-raised font-bold text-fg-strong [&_svg]:text-accent-fg hover:not-disabled:not-aria-disabled:bg-hover",
      },
      size: {
        xs: "h-7 min-w-7 px-2 text-xs [&_svg]:size-3.5",
        sm: "h-8 min-w-8 px-3 text-xs [&_svg]:size-4",
        md: "h-9 min-w-9 px-4 text-sm [&_svg]:size-4",
        lg: "h-10 min-w-10 px-6 text-sm [&_svg]:size-4",
        /** Deprecated: a square icon button. Use `IconButton`. */
        icon: "size-9 text-sm [&_svg]:size-4",
      },
    },
    compoundVariants: [{ variant: "link", class: "h-auto min-w-0 px-0" }],
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>;
export type ButtonSize = NonNullable<
  VariantProps<typeof buttonVariants>["size"]
>;

export interface ButtonProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type">,
    VariantProps<typeof buttonVariants> {
  /** Shows a spinner and disables the button; never overridable. */
  loading?: boolean;
  /** Why the button cannot be used right now: shown as a tooltip, linked for assistive tech. */
  disabledReason?: string;
  iconStart?: React.ReactNode;
  iconEnd?: React.ReactNode;
  type?: "button" | "submit" | "reset";
  asChild?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  disabledReason,
  iconStart,
  iconEnd,
  type = "button",
  children,
  onClick,
  ref,
  ...props
}: ButtonProps): React.ReactElement {
  const reasonId = React.useId();
  const softDisabled = Boolean(disabledReason) && !loading;
  const hardDisabled = loading || (Boolean(disabled) && !disabledReason);
  const classes = cn(buttonVariants({ variant, size }), className);
  const describedBy =
    [props["aria-describedby"], softDisabled ? reasonId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;

  const guardedClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (softDisabled || hardDisabled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onClick?.(e);
  };

  const content = asChild ? (
    children
  ) : (
    <>
      {loading ? <Spinner className="size-4" label="" /> : iconStart}
      {children}
      {iconEnd}
    </>
  );

  const element = asChild ? (
    <Slot.Root
      ref={ref}
      className={classes}
      data-variant={variant ?? "primary"}
      data-size={size ?? "md"}
      aria-disabled={softDisabled || hardDisabled || undefined}
      aria-busy={loading || undefined}
      onClick={guardedClick}
      {...props}
      aria-describedby={describedBy}
    >
      {content}
    </Slot.Root>
  ) : (
    <button
      ref={ref}
      // eslint-disable-next-line react/button-has-type -- the type is a typed prop with a default
      type={type}
      className={classes}
      data-variant={variant ?? "primary"}
      data-size={size ?? "md"}
      disabled={hardDisabled}
      aria-disabled={softDisabled || undefined}
      aria-busy={loading || undefined}
      onClick={guardedClick}
      {...props}
      aria-describedby={describedBy}
    >
      {content}
    </button>
  );

  if (!softDisabled) return element;
  return (
    <>
      <Tooltip content={disabledReason}>{element}</Tooltip>
      <span id={reasonId} className="sr-only">
        {disabledReason}
      </span>
    </>
  );
}
