/**
 * Viewer preferences in `localStorage` (ADMIN.md §5.3: optimistic, local, never server state).
 *
 * Storage can be missing or throw (private mode, blocked site data, a full quota), and a
 * preference is never worth an error: every read falls back to the default and every write is
 * best-effort.
 */

export function readPref<T>(
  key: string,
  parse: (raw: unknown) => T | undefined,
  fallback: T,
): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the preference lasts for this page only.
  }
}

/** A string array, or `undefined` for anything else. */
export function stringArray(raw: unknown): string[] | undefined {
  return Array.isArray(raw) && raw.every((v) => typeof v === "string")
    ? (raw as string[])
    : undefined;
}

/** The storage keys, in one place. */
export const PREF_KEYS = {
  /** The sidebar rail (icons only), per viewer. */
  sidebarRail: "pk-admin-sidebar-rail",
  /** The product switcher's recent products. */
  recentProducts: "pk-admin-recent-products",
  /** The command palette's recent commands. */
  recentCommands: "pk-admin-recent-commands",
  /**
   * Prefix: a one-time moment shown, `<prefix><moment>:<slug>` (EXPERIENCE.md §0.7; MO-11). Written
   * by `ui/motion`'s `Celebration` (which the portal shares), listed here so every console key is.
   */
  momentPrefix: "pk-moment:",
  /** Prefix: when the console last saw a product before a moment's milestone (`components/Moment`). */
  momentBeforePrefix: "pk-moment-before:",
} as const;
