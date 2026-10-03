import * as React from "react";

/**
 * Theme, per docs/design/BRAND.md §3: dark first, following the system, with a persisted
 * override.
 *
 *   preference "system" → no data-theme on <html>; tokens.css follows prefers-color-scheme
 *                         (dark when the OS gives no answer)
 *   preference "dark"   → data-theme="dark"
 *   preference "light"  → data-theme="light"
 *
 * The preference is stored in localStorage under THEME_STORAGE_KEY ("system" is stored too, so
 * an explicit return to system survives a reload). The pre-paint script in index.html and
 * manage.html applies a stored "dark"/"light" before the bundle loads, so there is no flash of
 * the wrong theme; this provider takes over from there and tracks the OS live while on
 * "system". The same key serves the console and the portal: they share an origin, and a viewer
 * who chose light in one expects light in the other.
 */
export type Theme = "dark" | "light";
export type ThemePreference = "system" | Theme;

export const THEME_STORAGE_KEY = "pk-admin-theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

interface ThemeContextValue {
  /** The theme actually showing. */
  theme: Theme;
  /** What the viewer chose. */
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  /** Pin the opposite of the theme showing now. */
  toggle: () => void;
  /** system → dark → light → system. */
  cycle: () => void;
}

const ThemeCtx = React.createContext<ThemeContextValue | null>(null);

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system")
      return stored;
  } catch {
    // storage unavailable (private mode): follow the system
  }
  return "system";
}

function systemTheme(): Theme {
  // jsdom and very old engines have no matchMedia; dark is the brand fallback.
  if (typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

function useSystemTheme(): Theme {
  const [theme, setTheme] = React.useState<Theme>(systemTheme);
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(LIGHT_QUERY);
    const onChange = (): void => setTheme(mql.matches ? "light" : "dark");
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return theme;
}

const NEXT: Record<ThemePreference, ThemePreference> = {
  system: "dark",
  dark: "light",
  light: "system",
};

/** Provide + persist the theme preference, and mirror it onto <html data-theme>. */
export function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [preference, setPreference] =
    React.useState<ThemePreference>(readPreference);
  const system = useSystemTheme();
  const theme: Theme = preference === "system" ? system : preference;

  React.useEffect(() => {
    const root = document.documentElement;
    if (preference === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", preference);
    // The resolved theme as a class too, for anything that styled off the pre-brand
    // `.dark`/`.light` classes; the tokens themselves key on data-theme and the media query.
    root.classList.remove("dark", "light");
    root.classList.add(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // storage may be unavailable (private mode) — the theme still applies for the session
    }
  }, [preference, theme]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      theme,
      preference,
      setPreference,
      toggle: () => setPreference(theme === "dark" ? "light" : "dark"),
      cycle: () => setPreference((p) => NEXT[p]),
    }),
    [theme, preference],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeCtx);
  if (!ctx)
    return {
      theme: "dark",
      preference: "system",
      setPreference: () => undefined,
      toggle: () => undefined,
      cycle: () => undefined,
    };
  return ctx;
}
