import * as React from "react";
import {
  Code2,
  FileCode2,
  Layers,
  Link2,
  PencilLine,
  RotateCcw,
  Server,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn.js";
import { formatDate } from "../lib/format.js";
import { Button } from "./Button.js";
import { Popover, PopoverClose } from "./Popover.js";
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

/**
 * The row's Revert, offered by the setting row around its badge: the popover carries it, so the
 * row has no text button that shifts from row to row (B-040).
 */
export interface RowRevert {
  label: string;
  run: () => void;
}
export const RowRevertContext = React.createContext<RowRevert | null>(null);

/** The row's Revert as a button, for a row whose owner shows as a pill, not a badge. */
export function RowRevertButton(): React.ReactElement | null {
  const row = React.useContext(RowRevertContext);
  if (!row) return null;
  return (
    <Button size="sm" variant="ghost" onClick={row.run} aria-label={row.label}>
      <RotateCcw aria-hidden />
      Revert…
    </Button>
  );
}

export interface SourceBadgeProps {
  source: Source;
  /** Replaces the badge's word ("Default" where "Code default" would mean the code). */
  label?: string;
  /** The manifest file that owns it, e.g. `.pkey/schema` (manifest only). */
  path?: string;
  /** Who set a runtime value. */
  by?: string;
  /** When a runtime value was set (epoch ms). */
  at?: number;
  /** Replaces the popover's explanation, where the default says something untrue for the value. */
  explain?: React.ReactNode;
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
  label,
  path,
  explain,
  by,
  at,
  onRevert: onRevertProp,
  className,
}: SourceBadgeProps): React.ReactElement {
  const row = React.useContext(RowRevertContext);
  const onRevert = onRevertProp ?? row?.run;
  const text = label ?? LABEL[source];
  const setBy =
    source === "runtime" && (by || at !== undefined) ? (
      <>
        Set
        {by ? (
          <>
            {" "}
            by <bdi>{by}</bdi>
          </>
        ) : null}
        {at !== undefined ? <> · {formatDate(at)}</> : null}
      </>
    ) : null;
  return (
    <Popover
      label={text}
      trigger={
        <button
          type="button"
          aria-haspopup="dialog"
          className={cn(
            "inline-flex rounded-full focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
            className,
          )}
        >
          <StatusPill tone={TONE[source]} icon={ICON[source]}>
            {text}
            <span className="sr-only">: what this means</span>
          </StatusPill>
        </button>
      }
    >
      <div className="space-y-2">
        <p className="text-sm text-fg">
          {explain ?? explanation(source, path)}
        </p>
        {setBy ? <p className="text-xs text-fg-muted">{setBy}</p> : null}
        {onRevert ? (
          <PopoverClose asChild>
            <Button
              size="sm"
              variant="outline"
              onClick={onRevert}
              aria-label={row && !onRevertProp ? row.label : undefined}
            >
              Revert…
            </Button>
          </PopoverClose>
        ) : null}
      </div>
    </Popover>
  );
}
