import * as React from "react";
import { History } from "lucide-react";
import { formatDateTime } from "../../lib/format.js";
import { Button } from "../Button.js";
import { Callout } from "../Callout.js";
import { Drawer } from "../Drawer.js";
import type { ConflictState } from "./useSettingWrite.js";

/**
 * A 409 on a row: refused (nothing was saved; Reload fetches the current value, the draft stays
 * in the field), then reloaded (what it reads now, and what saving again does).
 */
export function ConflictNote({
  state,
  reloading,
  onReload,
  onDismiss,
  now,
  draft,
}: {
  state: ConflictState;
  reloading: boolean;
  onReload: () => void;
  onDismiss: () => void;
  /** What the setting reads now, for the reloaded message ("45 days, set by ada@x.io"). */
  now: string;
  /** The unsaved value, kept across the reload. */
  draft?: string;
}): React.ReactElement | null {
  if (state === null) return null;
  if (state === "refused") {
    return (
      <Callout
        tone="warning"
        title="This setting changed since you loaded it"
        className="mt-3"
        live
        action={
          <Button
            size="sm"
            variant="outline"
            loading={reloading}
            onClick={onReload}
          >
            Reload
          </Button>
        }
      >
        Someone saved it first, so nothing was changed. Reload to see the
        current value{draft ? `; your ${draft} stays in the field` : ""}, then
        save again.
      </Callout>
    );
  }
  return (
    <Callout
      tone="info"
      title="Reloaded"
      className="mt-3"
      action={
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      It now reads {now}.{" "}
      {draft
        ? `Save again to apply ${draft}, or Discard to keep the current value.`
        : "Change it again if you still need to."}
    </Callout>
  );
}

/** One past change of a setting. */
export interface SettingHistoryEntry {
  id: string;
  /** Who changed it. */
  by: string;
  /** Epoch ms. */
  at: number;
  /** "Off → On", or the trail's own summary. */
  change: string;
}

/**
 * The history drawer of one setting: who changed it, when, and from what to what. Loads when
 * opened; a failed load says so and retries.
 */
export function SettingHistory({
  label,
  load,
}: {
  label: string;
  load: () => Promise<SettingHistoryEntry[]>;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<
    | { phase: "loading" }
    | { phase: "error" }
    | { phase: "ready"; items: SettingHistoryEntry[] }
  >({ phase: "loading" });
  const run = React.useCallback(() => {
    setState({ phase: "loading" });
    load().then(
      (items) => setState({ phase: "ready", items }),
      () => setState({ phase: "error" }),
    );
  }, [load]);
  React.useEffect(() => {
    if (open) run();
  }, [open, run]);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label={`History of ${label.toLowerCase()}`}
      >
        <History aria-hidden />
        History
      </Button>
      <Drawer
        open={open}
        onOpenChange={setOpen}
        title={`${label} history`}
        description="Changes made in the console, newest first."
      >
        {state.phase === "loading" ? (
          <p className="text-sm text-fg-muted" role="status">
            Loading history
          </p>
        ) : state.phase === "error" ? (
          <Callout
            tone="danger"
            title="History could not be loaded"
            action={
              <Button size="sm" variant="outline" onClick={run}>
                Try again
              </Button>
            }
          >
            Nothing was changed.
          </Callout>
        ) : state.items.length === 0 ? (
          <p className="text-sm text-fg-muted">No changes recorded yet.</p>
        ) : (
          <ol className="divide-y divide-border">
            {state.items.map((e) => (
              <li key={e.id} className="space-y-0.5 py-3 text-sm">
                <p className="font-medium text-fg-strong">{e.change}</p>
                <p className="text-fg-muted">
                  {e.by} · {formatDateTime(e.at)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Drawer>
    </>
  );
}
