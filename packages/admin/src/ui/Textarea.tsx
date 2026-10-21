import * as React from "react";
import { cn } from "../lib/cn.js";
import { useWriteLock } from "./WriteLock.js";

export interface TextareaProps extends Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onChange"
> {
  /** Code and JSON: the mono stack (sans by default). */
  mono?: boolean;
  /** Grow with the content up to `max-h-96` (CSS `field-sizing: content`; no inline style). */
  autoGrow?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onValueChange?: (value: string) => void;
  ref?: React.Ref<HTMLTextAreaElement>;
}

export function Textarea({
  className,
  mono,
  autoGrow = true,
  onChange,
  onValueChange,
  ref,
  ...props
}: TextareaProps): React.ReactElement {
  const { locked } = useWriteLock();
  return (
    <textarea
      ref={ref}
      onChange={(e) => {
        onChange?.(e);
        onValueChange?.(e.target.value);
      }}
      className={cn(
        "min-h-20 w-full rounded-md border border-border-strong bg-surface-sunken px-3 py-2 text-sm text-fg",
        "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-surface-page read-only:text-fg-muted",
        "aria-[invalid=true]:border-danger",
        autoGrow && "field-sizing-content max-h-96",
        mono && "font-mono text-xs",
        className,
      )}
      {...props}
      readOnly={props.readOnly || locked || undefined}
    />
  );
}
