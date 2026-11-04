// The line a finished sign-in or key activation leaves over the app. The key entries line is
// ui-core's Toast view (kind `key-entries`); the others are plain success lines.

import type { ReactNode } from "react";
import { contextOf, toastView } from "@polaris-key/ui-core";

import { GLYPHS, text, type KitCtx } from "./parts.js";

/** A toast's copy key and arguments, and the state of the Toast view it came from (none: success). */
export interface GateToast {
  key: string;
  args: Record<string, string | number>;
  state?: string;
}

/** "{left} key entries left" from ui-core's Toast view, or `null` while the view is hidden. */
export function keyEntriesToast(left: number): GateToast | null {
  const view = toastView(contextOf({ toast: { kind: "key-entries", left } }));
  const key = view.copy[0];
  if (view.state === "hidden" || key === undefined) return null;
  return {
    key,
    args: { ...(view.args as Record<string, string | number>) },
    state: view.state,
  };
}

/** One toast line: the view's state picks the glyph and `data-status`. */
export function ToastLine(props: { c: KitCtx; toast: GateToast }): ReactNode {
  const { c, toast } = props;
  const info = toast.state === "info";
  return (
    <div
      className="toast pk-flash"
      role="status"
      data-part="toast"
      data-key={toast.key}
      data-status={info ? "neutral" : "success"}
    >
      {info ? GLYPHS.info() : GLYPHS.success()}
      <span className="texts">
        <span>{text(c, toast.key, toast.args)}</span>
      </span>
    </div>
  );
}
