import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.js";
import { BUTTON_BASE, BUTTON_SIZES, BUTTON_VARIANTS } from "./classes.js";
import { Spinner } from "./Spinner.js";
import { Tooltip } from "./Tooltip.js";
import { useWriteLock } from "./WriteLock.js";

/** Every variant but the link wraps a long label in the portal (the console keeps one line). */
const WRAPPING = [
  "primary",
  "neutral",
  "secondary",
  "outline",
  "ghost",
  "danger",
  "destructive",
  "quiet",
  "action",
] as const;

/**
 * The console's button (docs/design/admin/components.md §2.1).
 *
 * - `primary` is the section accent (`data-service` scoping): chartreuse in License, yellow in
 *   Config, violet on core pages. `danger` is the danger status, never a section colour.
 * - `loading` keeps the label, swaps the start icon for a spinner and sets `aria-busy`. The
 *   button stays focusable (`aria-disabled` and a click guard, never `disabled`, so focus does
 *   not fall to `<body>` mid-request) and a click does nothing; a caller's `disabled={false}`
 *   cannot re-enable it (fixes UI-1). A busy button keeps its variant look; only a locked or
 *   disabled one (`aria-disabled` and not `aria-busy`) wears the disabled look: the filled
 *   variants take the action-disabled pair.
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
  // A touch screen's target is 44 px tall (EXPERIENCE §7.3); a link-style button keeps its own
  // height but never goes under the 24 px floor (WCAG 2.5.8) unless a caller sits it in a sentence.
  cn(BUTTON_BASE, "pointer-coarse:min-h-11"),
  {
    variants: { variant: BUTTON_VARIANTS, size: BUTTON_SIZES },
    compoundVariants: [
      {
        variant: "link",
        class: "h-auto min-h-6 min-w-0 px-0 pointer-coarse:min-h-6",
      },
      // The portal's variants wrap a long label (200 % text on a phone) instead of running past
      // the screen: the height follows the text, never below the size's own.
      {
        variant: [...WRAPPING],
        size: "xs",
        class:
          "console:whitespace-nowrap console:cramped:whitespace-normal conbig:gap-1 conbig:px-2 conbig:[&>svg:not(:only-child)]:hidden h-auto min-h-7 whitespace-normal py-1.5 text-center bigtext:gap-1 bigtext:px-2 bigtext:[&>svg:not(:only-child)]:hidden",
      },
      {
        variant: [...WRAPPING],
        size: "sm",
        class:
          "console:whitespace-nowrap console:cramped:whitespace-normal conbig:gap-1 conbig:px-2 conbig:[&>svg:not(:only-child)]:hidden h-auto min-h-8 whitespace-normal py-1.5 text-center bigtext:gap-1 bigtext:px-2 bigtext:[&>svg:not(:only-child)]:hidden",
      },
      {
        variant: [...WRAPPING],
        size: "md",
        class:
          "console:whitespace-nowrap console:cramped:whitespace-normal conbig:gap-1 conbig:px-2 conbig:[&>svg:not(:only-child)]:hidden h-auto min-h-9 whitespace-normal py-1.5 text-center bigtext:gap-1 bigtext:px-2 bigtext:[&>svg:not(:only-child)]:hidden",
      },
      {
        variant: [...WRAPPING],
        size: "lg",
        class:
          "console:whitespace-nowrap console:cramped:whitespace-normal conbig:gap-1 conbig:px-2 conbig:[&>svg:not(:only-child)]:hidden h-auto min-h-10 whitespace-normal py-1.5 text-center bigtext:gap-1 bigtext:px-2 bigtext:[&>svg:not(:only-child)]:hidden",
      },
    ],
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
  /** Shows a spinner, sets `aria-busy` and ignores clicks, keeping focus; never overridable. */
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
  disabledReason: reason,
  iconStart,
  iconEnd,
  type = "button",
  children,
  onClick,
  ref,
  ...props
}: ButtonProps): React.ReactElement {
  const reasonId = React.useId();
  let disabledReason = reason;
  const lock = useWriteLock();
  // A view-only member's write button: focusable, with the reason, never a link or a read.
  if (lock.locked && !asChild && !disabledReason && !loading)
    disabledReason = lock.reason ?? "You can view this, not change it.";
  const softDisabled = Boolean(disabledReason) && !loading;
  const busySoft = loading;
  const hardDisabled = Boolean(disabled) && !disabledReason && !loading;
  const classes = cn(buttonVariants({ variant, size }), className);
  const describedBy =
    [props["aria-describedby"], softDisabled ? reasonId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;

  const guardedClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (softDisabled || hardDisabled || busySoft) {
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
      aria-disabled={softDisabled || hardDisabled || busySoft || undefined}
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
      aria-disabled={softDisabled || busySoft || undefined}
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
