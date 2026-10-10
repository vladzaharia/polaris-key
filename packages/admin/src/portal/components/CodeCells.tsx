import * as React from "react";
import { cn } from "../../lib/cn.js";
import { t } from "../../lib/copy.js";

/** Sign-in and confirmation codes are six digits (I-02, I-07). */
export const CODE_LENGTH = 6;

/**
 * One input drawn as six cells (§3.4, §3.14): `autocomplete="one-time-code"`, numeric, one
 * accessible name ("6-digit code", `signin.code.label`), paste fills it. The cells are a mirror
 * behind the transparent input, never six inputs.
 */
export function CodeCells({
  id,
  value,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  value: string;
  invalid: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  const [focused, setFocused] = React.useState(false);
  const at = Math.min(value.length, CODE_LENGTH - 1);
  return (
    <div className="relative">
      <div aria-hidden className="grid grid-cols-6 gap-2">
        {Array.from({ length: CODE_LENGTH }, (_, i) => (
          <div
            key={i}
            className={cn(
              "flex h-14 items-center justify-center rounded-md border bg-surface-sunken font-mono text-2xl font-semibold text-fg-strong",
              invalid
                ? "border-danger"
                : focused && i === at
                  ? "border-focus ring-2 ring-focus"
                  : "border-border-strong",
            )}
          >
            {value[i] ?? ""}
          </div>
        ))}
      </div>
      <input
        id={id}
        aria-label={t("signin.code.label")}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={CODE_LENGTH}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) =>
          onChange(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))
        }
        className="absolute inset-0 size-full cursor-text bg-transparent text-transparent caret-transparent outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
      />
    </div>
  );
}
