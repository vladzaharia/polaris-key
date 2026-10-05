import * as React from "react";
import { cn } from "../lib/cn.js";
import { Button, type ButtonProps } from "./Button.js";
import { Tooltip } from "./Tooltip.js";

export interface IconButtonProps extends Omit<
  ButtonProps,
  "children" | "iconStart" | "iconEnd" | "asChild" | "aria-label"
> {
  /** Required: the accessible name and the visible tooltip (components.md §2.2). */
  label: string;
  icon: React.ReactNode;
}

/**
 * An icon-only button. `label` is both its `aria-label` and its tooltip, so no icon control is
 * ever unnamed or unexplained. The hit target is at least 32 px (36 px on coarse pointers).
 */
export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  className,
  disabledReason,
  ...props
}: IconButtonProps): React.ReactElement {
  const sizeClass =
    size === "xs"
      ? "size-7"
      : size === "sm"
        ? "size-8"
        : size === "lg"
          ? "size-10"
          : "size-9";
  const button = (
    <Button
      variant={variant}
      size={size}
      aria-label={label}
      data-icon=""
      disabledReason={disabledReason}
      className={cn(sizeClass, "min-w-0 px-0 pointer-coarse:size-9", className)}
      {...props}
    >
      <span aria-hidden className="contents">
        {icon}
      </span>
    </Button>
  );
  // A disabled-with-reason button already carries the reason as its tooltip.
  if (disabledReason) return button;
  return <Tooltip content={label}>{button}</Tooltip>;
}
