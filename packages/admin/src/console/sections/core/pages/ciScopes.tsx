import * as React from "react";
import { CI_SCOPES } from "../../../../api.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { StatusPill } from "../../../../ui/StatusPill.js";

/** What each scope lets a CI run do, in the docs' words. */
const SCOPE_TEXT: Record<string, string> = {
  "release:publish": "Publish releases",
  "release:promote": "Promote releases on channels",
  "release:yank": "Yank releases",
  "distribution:report": "Report store status",
  "distribution:rollout": "Start and change rollouts",
  "distribution:feeds": "Publish package feeds",
  "distribution:listing": "Upload listing assets",
  "assets:write": "Upload hosted assets",
};

export function ScopeList({
  scopes,
}: {
  scopes: string[];
}): React.ReactElement {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <StatusPill key={s} tone="neutral" icon={null} size="sm">
          {SCOPE_TEXT[s] ?? s}
        </StatusPill>
      ))}
    </span>
  );
}

export function ScopePicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}): React.ReactElement {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-fg-strong">Scopes</legend>
      {CI_SCOPES.map((s) => (
        <Checkbox
          key={s}
          label={SCOPE_TEXT[s] ?? s}
          description={s}
          checked={value.includes(s)}
          onCheckedChange={(on) =>
            onChange(on ? [...value, s].sort() : value.filter((x) => x !== s))
          }
        />
      ))}
      {value.length === 0 ? (
        <p className="text-xs text-danger">Choose at least one scope.</p>
      ) : null}
    </fieldset>
  );
}
