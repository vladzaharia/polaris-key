import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Check, Minus } from "lucide-react";
import { cn } from "../lib/cn.js";

type RootProps = React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>;

export interface CheckboxProps extends Omit<
  RootProps,
  "value" | "onChange" | "checked" | "onCheckedChange"
> {
  checked?: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean) => void;
  /** `FormField` spreading: the boolean value. */
  value?: boolean;
  /** `FormField` spreading: called with the new boolean. */
  onChange?: (checked: boolean) => void;
  /** The visible label; with it no separate Label is needed (components.md §3.3). */
  label?: React.ReactNode;
  /** A secondary line under the label, linked with `aria-describedby`. */
  description?: React.ReactNode;
  readOnly?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

export const CHECK_BOX_CLASS = [
  "peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-border-strong bg-surface-sunken",
  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
  "disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger",
  "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-on",
  "data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-accent-on",
  // A 32 px hit target around the 16 px box.
  "relative after:absolute after:-inset-2 after:content-['']",
].join(" ");

export function Checkbox({
  className,
  checked,
  onCheckedChange,
  value,
  onChange,
  label,
  description,
  readOnly,
  id,
  ref,
  ...props
}: CheckboxProps): React.ReactElement {
  const reactId = React.useId();
  const boxId = id ?? `cb-${reactId.replace(/:/g, "")}`;
  const descId = description ? `${boxId}-desc` : undefined;
  const state = checked ?? value ?? false;
  const box = (
    <CheckboxPrimitive.Root
      ref={ref}
      id={boxId}
      checked={state}
      aria-readonly={readOnly || undefined}
      onCheckedChange={(c) => {
        if (readOnly) return;
        const next = c === true;
        onCheckedChange?.(next);
        onChange?.(next);
      }}
      className={cn(CHECK_BOX_CLASS, !label && className)}
      {...props}
      aria-describedby={
        [props["aria-describedby"], descId].filter(Boolean).join(" ") ||
        undefined
      }
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        {state === "indeterminate" ? (
          <Minus aria-hidden className="size-3.5" strokeWidth={3} />
        ) : (
          <Check aria-hidden className="size-3.5" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (!label) return box;
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <span className="mt-0.5 flex">{box}</span>
      <div className="min-w-0">
        <label htmlFor={boxId} className="text-sm text-fg">
          {label}
        </label>
        {description ? (
          <p id={descId} className="text-xs text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
