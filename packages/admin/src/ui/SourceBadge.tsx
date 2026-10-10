import * as React from "react";
import {
  Code2,
  FileCode2,
  Layers,
  Link2,
  PencilLine,
  Server,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn.js";
import { formatDate } from "../lib/format.js";
import { Button } from "./Button.js";
import { Popover } from "./Popover.js";
import { StatusPill } from "./StatusPill.js";
import type { Tone } from "../lib/status.js";

/**
 * Who owns a value (components.md §6.6; one implementation, replacing three). Anything a resync
 * or a deploy can overwrite carries one; its popover says what the next resync or a revert does.
 *
 * - `manifest`: written by `.pkey/…`; the next resync re-applies it.
 * - `admin`: claimed in the console; survives a resync.
 * - `default`: the value built into Polaris Key (platform settings).
 * - `deploy`: set by the deployment's environment (wrangler vars).
 * - `runtime`: a console override of a deploy var or default, with who set it and when.
 * - `platform`: inherited from the platform's default for every product.
 * - `derived`: worked out from other settings; nothing to edit here.
 *
 * An override is neutral ink: a set value is not a status, so no tone colours it (B17).
 */
export type Source =
  | "manifest"
  | "admin"
  | "default"
  | "deploy"
  | "runtime"
  | "platform"
  | "derived";

const LABEL: Record<Source, string> = {
  manifest: "From manifest",
  admin: "Set in console",
  default: "Code default",
  deploy: "Deploy var",
  runtime: "Set in console",
  platform: "Platform default",
  derived: "Derived",
};

// Each source names its owner by glyph, never the neutral tone's hollow circle (which reads as an
// unchecked radio).
const ICON: Record<Source, LucideIcon> = {
  manifest: FileCode2,
  admin: PencilLine,
  default: Code2,
  deploy: Server,
  runtime: PencilLine,
  platform: Layers,
  derived: Link2,
};

const TONE: Record<Source, Tone> = {
  manifest: "neutral",
  admin: "neutral",
  default: "neutral",
  deploy: "neutral",
  runtime: "neutral",
  platform: "neutral",
  derived: "neutral",
};

export interface SourceBadgeProps {
  source: Source;
  /** The manifest file that owns it, e.g. `.pkey/schema` (manifest only). */
  path?: string;
  /** Who set a runtime value. */
  by?: string;
  /** When a runtime value was set (epoch ms). */
  at?: number;
  /** Renders "Revert…" in the popover; the caller confirms (an L1 action). */
  onRevert?: () => void;
  className?: string;
}

function explanation(source: Source, path?: string): React.ReactNode {
  switch (source) {
    case "manifest":
      return (
        <>
          From manifest: the next resync re-applies{" "}
          <code className="font-mono text-xs">{path ?? ".pkey/…"}</code>.
          Editing it here claims it for the console.
        </>
      );
    case "admin":
      return (
        <>
          Set in console: survives a resync.{" "}
          <strong className="font-semibold">Revert to manifest</strong> hands it
          back.
        </>
      );
    case "default":
      return "The value built into Polaris Key. Set it in the console to override it.";
    case "deploy":
      return "Set by the deployment's environment (wrangler vars). A console value overrides it; Revert hands it back.";
    case "runtime":
      return "Set in console: overrides the deploy var and the code default. Revert removes the override.";
    case "platform":
      return "Inherited from the platform's default. Set it for this product to override it.";
    case "derived":
      return "Worked out from other settings. Change those instead.";
  }
}

export function SourceBadge({
  source,
  path,
  by,
  at,
  onRevert,
  className,
}: SourceBadgeProps): React.ReactElement {
  const setBy =
    source === "runtime" && (by || at !== undefined)
      ? [
          "Set",
          by ? `by ${by}` : null,
          at !== undefined ? `· ${formatDate(at)}` : null,
        ]
          .filter(Boolean)
          .join(" ")
      : null;
  return (
    <Popover
      label={LABEL[source]}
      trigger={
        <button
          type="button"
          aria-haspopup="dialog"
          className={cn(
            "inline-flex rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
            className,
          )}
        >
          <StatusPill tone={TONE[source]} icon={ICON[source]}>
            {LABEL[source]}
            <span className="sr-only">: what this means</span>
          </StatusPill>
        </button>
      }
    >
      <div className="space-y-2">
        <p className="text-sm text-fg">{explanation(source, path)}</p>
        {setBy ? <p className="text-xs text-fg-muted">{setBy}</p> : null}
        {onRevert ? (
          <Button size="sm" variant="outline" onClick={onRevert}>
            Revert…
          </Button>
        ) : null}
      </div>
    </Popover>
  );
}
