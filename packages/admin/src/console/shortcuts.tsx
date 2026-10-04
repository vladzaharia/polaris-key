/**
 * Global keyboard shortcuts (ADMIN.md §5.5).
 *
 * Rules: a shortcut never fires while focus is in a text input, a select, a textarea or an editor;
 * every shortcut is listed in the sheet (`?`); and no single-key shortcut writes anything.
 *
 * Two-key sequences (`g o`) are tracked here: a `g` arms the sequence for one second.
 */

import * as React from "react";

export interface ShortcutDef {
  /** Display keys, e.g. "⌘K", "g o", "?". */
  keys: string;
  label: string;
  scope: "global" | "product";
}

/** Is the event's target somewhere a typed key belongs to the field, not to the console? */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  }
  return target.closest("[role=textbox], .cm-editor") !== null;
}

/** Is this the platform's command modifier (⌘ on Apple platforms, Ctrl elsewhere)? */
export function isModKey(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

export interface ShortcutHandlers {
  /** `/` outside a field opens the palette. */
  openPalette: () => void;
  /** `⌘K` / `Ctrl+K` toggles it: pressed again while the palette is open, it closes (owner, 2026-10-03). */
  togglePalette: () => void;
  /** `?` */
  openSheet: () => void;
  /** `⌘\` / `Ctrl+\` */
  toggleSidebar: () => void;
  /** `g <key>`: return true when the key was handled. */
  go: (key: string) => boolean;
}

/** Install the global shortcuts for the console shell. */
export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  const ref = React.useRef(handlers);
  ref.current = handlers;
  React.useEffect(() => {
    let armedUntil = 0;
    // ⌘K works everywhere, including from a field (it is how you leave one for the palette), and
    // from inside the open palette, where it closes it again. It listens in the capture phase so
    // no focused widget (the palette's own input included) can swallow it first.
    const onModK = (e: KeyboardEvent): void => {
      if (isModKey(e) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        ref.current.togglePalette();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      const h = ref.current;
      if (isModKey(e) && e.key === "\\") {
        e.preventDefault();
        h.toggleSidebar();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const now = Date.now();
      if (armedUntil > now) {
        armedUntil = 0;
        if (h.go(e.key.toLowerCase())) e.preventDefault();
        return;
      }
      if (e.key === "g") {
        armedUntil = now + 1000;
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        h.openPalette();
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        h.openSheet();
      }
    };
    window.addEventListener("keydown", onModK, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onModK, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}

/** The global shortcuts, as the sheet lists them. Product `g` keys come from `nav.ts`. */
export const GLOBAL_SHORTCUTS: ShortcutDef[] = [
  { keys: "⌘K", label: "Open the command palette", scope: "global" },
  { keys: "/", label: "Open the command palette", scope: "global" },
  { keys: "?", label: "Show keyboard shortcuts", scope: "global" },
  { keys: "g h", label: "Go to Home", scope: "global" },
  { keys: "g p", label: "Change product", scope: "global" },
  { keys: "⌘\\", label: "Collapse or expand the sidebar", scope: "global" },
  { keys: "Esc", label: "Close the topmost overlay", scope: "global" },
];
