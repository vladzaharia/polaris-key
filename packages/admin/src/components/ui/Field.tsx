import * as React from "react";
import { cn } from "../../lib/cn.js";
import { Label } from "./Label.js";

/**
 * A labelled form-field wrapper that wires `aria-describedby` to its help + error text and
 * stamps `aria-invalid` on the control. It clones a single control child to inject the
 * generated `id`/`aria-*` so callers never hand-thread accessibility attributes.
 */
export interface FieldProps {
  label: React.ReactNode;
  htmlFor?: string;
  help?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
  /** Optional trailing node rendered next to the label (e.g. a state badge). */
  labelAside?: React.ReactNode;
  children: React.ReactElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | "true" | "false";
    "aria-required"?: boolean;
  }>;
}

let counter = 0;
function useFieldId(explicit?: string): string {
  const reactId = React.useId();
  return explicit ?? `pk-field-${reactId || ++counter}`;
}

export function Field({
  label,
  htmlFor,
  help,
  error,
  required,
  className,
  labelAside,
  children,
}: FieldProps): React.ReactElement {
  const id = useFieldId(htmlFor);
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  const control = React.cloneElement(children, {
    id,
    "aria-describedby": describedBy,
    "aria-invalid": error ? "true" : undefined,
    "aria-required": required || undefined,
  });

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>
          {label}
          {required ? <span className="ml-0.5 text-destructive">*</span> : null}
        </Label>
        {labelAside}
      </div>
      {control}
      {help ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
