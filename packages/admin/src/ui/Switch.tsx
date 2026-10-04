import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "../lib/cn.js";

type RootProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

export interface SwitchProps extends Omit<
  RootProps,
  "value" | "onChange" | "checked" | "onCheckedChange"
> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  value?: boolean;
  onChange?: (checked: boolean) => void;
  label?: React.ReactNode;
  description?: React.ReactNode;
  readOnly?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

/**
 * An immediate or form-local boolean (components.md §3.3). Never the only control for a
 * confirmed destructive action (LDT-7): that is a button and a `ConfirmDialog`.
 */
export function Switch({
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
}: SwitchProps): React.ReactElement {
  const reactId = React.useId();
  const switchId = id ?? `sw-${reactId.replace(/:/g, "")}`;
  const descId = description ? `${switchId}-desc` : undefined;
  const control = (
    <SwitchPrimitive.Root
      ref={ref}
      id={switchId}
      checked={checked ?? value ?? false}
      aria-readonly={readOnly || undefined}
      onCheckedChange={(c) => {
        if (readOnly) return;
        onCheckedChange?.(c);
        onChange?.(c);
      }}
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border-strong transition-colors duration-(--pk-duration-fast) ease-standard",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=unchecked]:bg-surface-sunken",
        "after:absolute after:-inset-x-1 after:-inset-y-1.5 after:content-['']",
        !label && className,
      )}
      {...props}
      aria-describedby={
        [props["aria-describedby"], descId].filter(Boolean).join(" ") ||
        undefined
      }
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-3.5 rounded-full bg-fg-muted shadow-elevation-1 transition-transform duration-(--pk-duration-fast) ease-standard data-[state=checked]:translate-x-[1.125rem] data-[state=checked]:bg-accent-on data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  );
  if (!label) return control;
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <span className="mt-0.5 flex">{control}</span>
      <div className="min-w-0">
        <label htmlFor={switchId} className="text-sm text-fg">
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
