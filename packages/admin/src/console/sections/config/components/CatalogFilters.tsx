import * as React from "react";
import { cn } from "../../../../lib/cn.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { Input } from "../../../../ui/Input.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { Select } from "../../../../ui/Select.js";
import { Unlocked, useWriteLock } from "../../../../ui/WriteLock.js";
import { ENTRY_TYPE_LABELS, type EntryType } from "./entryType.js";

type Mode = "form" | "json";
type Kind = "all" | "setting" | "secret" | "minted" | "flag";

/** A view-only member's note above the editor (B-230): what they can do, and whom to ask. */
export function ViewOnlyNote(): React.ReactElement | null {
  const lock = useWriteLock();
  return lock.locked ? (
    <Callout tone="info" title="You can view this catalog, not change it">
      {lock.reason}
    </Callout>
  ) : null;
}

/**
 * The editor's search, type filter, changed-only toggle and Form/JSON switch. They only read, so
 * they stay usable under a view-only lock.
 */
export function CatalogFilters({
  mode,
  setMode,
  query,
  setQuery,
  kind,
  setKind,
  changedOnly,
  setChangedOnly,
  hasFlags,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
  query: string;
  setQuery: (q: string) => void;
  kind: Kind;
  setKind: (k: Kind) => void;
  changedOnly: "0" | "1";
  setChangedOnly: (c: "0" | "1") => void;
  hasFlags: boolean;
}): React.ReactElement {
  return (
    <Unlocked>
      {mode === "json" ? <div className="flex-1" /> : null}
      <div
        className={cn(
          "min-w-[min(12rem,100%)] flex-1",
          mode === "json" && "hidden",
        )}
      >
        <Input
          type="search"
          aria-label="Search entries"
          placeholder="Search key, label, category…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className={cn("w-40 max-w-full", mode === "json" && "hidden")}>
        <Select
          aria-label="Type"
          value={kind}
          options={[
            { value: "all", label: "All types" },
            ...(
              [
                "setting",
                "secret",
                "minted",
                ...(hasFlags ? ["flag"] : []),
              ] as EntryType[]
            ).map((k) => ({ value: k, label: ENTRY_TYPE_LABELS[k] })),
          ]}
          onChange={(v) => setKind((v ?? "all") as Kind)}
        />
      </div>
      {mode === "json" ? null : (
        <Checkbox
          label="Changed only"
          checked={changedOnly === "1"}
          onCheckedChange={(on) => setChangedOnly(on ? "1" : "0")}
        />
      )}
      <SegmentedControl<Mode>
        aria-label="Editing mode"
        value={mode}
        onChange={(m) => setMode(m)}
        options={[
          { value: "form", label: "Form" },
          { value: "json", label: "JSON" },
        ]}
      />
    </Unlocked>
  );
}
