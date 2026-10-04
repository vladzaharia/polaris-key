// Expressive Code (the docs' code blocks), on the brand tokens (docs/design/BRAND.md §4).
//
// Starlight already points the code-block chrome at its --sl-color-* variables, which
// src/styles/global.css maps onto the --pk-* tokens. This file moves the code surface itself to
// --pk-surface-sunken ("wells, code blocks") and tells Expressive Code the hex value behind it in
// each theme, so its syntax-colour contrast pass (minimum 5.5:1) measures against the background
// the reader actually sees. The two values are read from @polaris-key/brand's tokens.json (the
// same source tokens.css is generated from), never written out here.

import { createRequire } from "node:module";
import { defineEcConfig } from "@astrojs/starlight/expressive-code";

const tokens = createRequire(import.meta.url)("@polaris-key/brand/tokens.json");

const SUNKEN = {
  dark: tokens.themes.dark.surface.sunken,
  light: tokens.themes.light.surface.sunken,
};
if (typeof SUNKEN.dark !== "string" || typeof SUNKEN.light !== "string")
  throw new Error("@polaris-key/brand tokens.json has no surface.sunken");

export default defineEcConfig({
  customizeTheme(theme) {
    const sunken = theme.type === "dark" ? SUNKEN.dark : SUNKEN.light;
    theme.bg = sunken;
    theme.colors["editor.background"] = sunken;
    theme.styleOverrides.frames = {
      ...theme.styleOverrides.frames,
      editorBackground: "var(--pk-surface-sunken)",
      terminalBackground: "var(--pk-surface-sunken)",
      editorActiveTabBackground: "var(--pk-surface-sunken)",
      editorTabBarBackground: "var(--pk-surface-raised)",
      terminalTitlebarBackground: "var(--pk-surface-raised)",
      editorTabBarBorderBottomColor: "var(--pk-border-subtle)",
      terminalTitlebarBorderBottomColor: "var(--pk-border-subtle)",
      editorActiveTabIndicatorTopColor: "var(--pk-accent)",
      inlineButtonForeground: "var(--pk-text-muted)",
      inlineButtonBorder: "var(--pk-border-strong)",
      tooltipSuccessBackground: "var(--pk-success)",
      tooltipSuccessForeground: "var(--pk-success-on)",
    };
    return theme;
  },
  styleOverrides: {
    borderColor: "var(--pk-border-subtle)",
    borderRadius: "var(--pk-radius-md)",
    codeFontFamily: "var(--pk-font-mono)",
    uiFontFamily: "var(--pk-font-sans)",
    focusBorder: "var(--pk-focus)",
  },
});
