import * as React from "react";
import { Textarea } from "./Textarea.js";

/** The reason a critical change asks for, kept in the activity log (a confirmation's child). */
export function ReasonField({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (v: string) => void;
}): React.ReactElement {
  return (
    <div className="space-y-1 text-sm">
      <label className="block space-y-1">
        <span className="font-medium text-fg-strong">Reason</span>
        <Textarea
          value={value}
          onValueChange={onValueChange}
          maxLength={500}
          rows={2}
          placeholder="Why this changes"
        />
      </label>
      <p className="text-xs text-fg-muted">
        Required. Kept in the activity log.
      </p>
    </div>
  );
}
