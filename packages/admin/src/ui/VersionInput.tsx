import * as React from "react";
import { isValidVersion, versionRangeError } from "../lib/version.js";
import { Input, type InputProps } from "./Input.js";

export interface VersionInputProps extends Omit<
  InputProps,
  "value" | "onChange" | "mono"
> {
  value: string | null | undefined;
  /** The trimmed text; blank is `""`. */
  onChange?: (value: string) => void;
}

/**
 * A version field (components.md §3.3): mono, validated with the server's rule (`lib/version.ts`,
 * the same `SEMVER_RE` the admin handlers use). Use `versionError` / `versionRangeError` for the
 * message, so a min/max pair is checked across fields.
 */
export function VersionInput({
  value,
  onChange,
  placeholder = "2.0.0",
  ...props
}: VersionInputProps): React.ReactElement {
  return (
    <Input
      {...props}
      mono
      spellCheck={false}
      autoComplete="off"
      inputMode="text"
      placeholder={placeholder}
      value={value ?? ""}
      onValueChange={(v) => onChange?.(v.trim())}
    />
  );
}

/** The message for one version field, or `null` (blank is allowed unless `required`). */
export function versionError(
  value: string | null | undefined,
  opts: { required?: boolean } = {},
): string | null {
  const v = (value ?? "").trim();
  if (!v) return opts.required ? "Enter a version." : null;
  return isValidVersion(v) ? null : "Use a version such as 2.0.0.";
}

export { versionRangeError };
