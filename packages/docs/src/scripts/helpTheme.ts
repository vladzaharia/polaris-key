/** The theme storage every docs page shares: the console's key (ThemeProvider.astro), read by ThemeSelect and MobileMenuFooter. */
export type Theme = "auto" | "dark" | "light";

const KEY = "pk-admin-theme";

export function storedTheme(): Theme {
  const v = typeof localStorage !== "undefined" && localStorage.getItem(KEY);
  return v === "dark" || v === "light" ? v : "auto";
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme =
    theme === "auto"
      ? matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  if (typeof localStorage !== "undefined")
    localStorage.setItem(KEY, theme === "auto" ? "system" : theme);
  document.dispatchEvent(new CustomEvent("pk-help-theme", { detail: theme }));
}
