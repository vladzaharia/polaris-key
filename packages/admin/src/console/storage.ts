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
  /** Collapsed sidebar sections, per signed-in operator. */
  navCollapsed: (sub: string) => `pk-admin-nav-collapsed:${sub}`,
  /** The sidebar rail (icons only), per viewer. */
  sidebarRail: "pk-admin-sidebar-rail",
  /** The product switcher's recent products. */
  recentProducts: "pk-admin-recent-products",
  /** The command palette's recent commands. */
  recentCommands: "pk-admin-recent-commands",
} as const;
