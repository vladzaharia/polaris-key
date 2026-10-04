import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "../lib/cn.js";
import { Checkbox } from "./Checkbox.js";
import { CONTROL_INPUT } from "./inputBase.js";

export interface SecretInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange"
> {
  value: string | null | undefined;
  onChange?: (value: string) => void;
  /** A value is already stored: typing a new one needs "Replace the existing value" (SEC-3). */
  configured?: boolean;
  /** Controlled overwrite confirmation (with `configured`). */
  replace?: boolean;
  onReplaceChange?: (replace: boolean) => void;
  ref?: React.Ref<HTMLInputElement>;
}

/**
 * A write-only secret field (components.md §3.3). Reveal shows only what is being typed: stored
 * secrets are never returned by the server and have no reveal. When `configured`, the field stays
 * read-only until "Replace the existing value" is ticked, so a stored secret is never overwritten
 * by accident.
 */
export function SecretInput({
  value,
  onChange,
  configured,
  replace: replaceProp,
  onReplaceChange,
  className,
  disabled,
  readOnly,
  id,
  ref,
  ...props
}: SecretInputProps): React.ReactElement {
  const [revealed, setRevealed] = React.useState(false);
  const [replaceLocal, setReplaceLocal] = React.useState(false);
  const replace = replaceProp ?? replaceLocal;
  const reactId = React.useId();
  const inputId = id ?? `secret-${reactId.replace(/:/g, "")}`;
  const locked = Boolean(configured) && !replace;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          type={revealed ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={value ?? ""}
          placeholder={
            configured
              ? "Configured · enter a new value to replace it"
              : undefined
          }
          onChange={(e) => onChange?.(e.target.value)}
          disabled={disabled}
          readOnly={readOnly || locked}
          className={cn(CONTROL_INPUT, "pr-11 font-mono text-xs")}
          {...props}
        />
        <button
          type="button"
          aria-pressed={revealed}
          aria-label={revealed ? "Hide value" : "Reveal value"}
          aria-controls={inputId}
          disabled={disabled || locked}
          onClick={() => setRevealed((r) => !r)}
          className="absolute right-1 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-sm text-fg-muted hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
        >
          {revealed ? (
            <EyeOff aria-hidden className="size-4" />
          ) : (
            <Eye aria-hidden className="size-4" />
          )}
        </button>
      </div>
      {configured ? (
        <Checkbox
          label="Replace the existing value"
          description="The stored value is overwritten when you save. It cannot be recovered."
          checked={replace}
          disabled={disabled || readOnly}
          onCheckedChange={(on) => {
            setReplaceLocal(on);
            onReplaceChange?.(on);
            if (!on) onChange?.("");
          }}
        />
      ) : null}
    </div>
  );
}
