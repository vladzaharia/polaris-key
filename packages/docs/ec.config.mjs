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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The docs package directory: this file's own folder, or, when the `<Code>` component's copy of it
// is bundled into the SSR output (astro.config.mjs maps its config module here) and
// `import.meta.url` is the bundle's, the working directory Astro builds from.
const ROOT = [dirname(fileURLToPath(import.meta.url)), process.cwd()].find(
  (d) => existsSync(join(d, "ec-copy.js")),
);
if (!ROOT)
  throw new Error("ec.config.mjs: cannot find the docs package directory");

// The console's highlight roles, read from its source: this file is loaded by plain Node, which
// cannot import the admin package's TypeScript. test/codeThemes.test.ts pins the parse against the
// real `TOKEN_CLASS` and `LANGUAGE_LABEL`.
const HIGHLIGHT = readFileSync(
  join(ROOT, "..", "admin", "src", "lib", "highlight.ts"),
  "utf8",
);
export function recordFromSource(name) {
  const body = new RegExp(`export const ${name}[^=]*=\\s*\\{([^}]*)\\}`).exec(
    HIGHLIGHT,
  )?.[1];
  if (!body) throw new Error(`lib/highlight.ts has no ${name}`);
  return Object.fromEntries(
    [...body.matchAll(/^\s*(\w+):\s*"([^"]*)"/gm)].map((m) => [m[1], m[2]]),
  );
}
const TOKEN_CLASS = recordFromSource("TOKEN_CLASS");
const LANGUAGE_LABEL = recordFromSource("LANGUAGE_LABEL");

const tokens = createRequire(join(ROOT, "package.json"))(
  "@polaris-key/brand/tokens.json",
);

const SUNKEN = {
  dark: tokens.themes.dark.surface.sunken,
  light: tokens.themes.light.surface.sunken,
};
if (typeof SUNKEN.dark !== "string" || typeof SUNKEN.light !== "string")
  throw new Error("@polaris-key/brand tokens.json has no surface.sunken");

// A block with an angle-bracket placeholder (`<slug>`) has no Copy button: pasted into a shell,
// `<slug>` is an input redirect (style guide §7). Markup languages use angle brackets for real.
const MARKUP = new Set(["xml", "html", "tsx", "jsx", "vue", "svelte", "svg"]);
const PLACEHOLDER = /<[a-z][a-z0-9]*(?:[ -][a-z0-9]+)*>/;
const noCopyOnPlaceholders = {
  name: "pk-no-copy-on-placeholders",
  hooks: {
    postprocessRenderedBlock: ({ codeBlock, renderData }) => {
      if (MARKUP.has(codeBlock.language)) return;
      if (!PLACEHOLDER.test(codeBlock.code)) return;
      const frame = renderData.blockAst;
      frame.children = (frame.children ?? []).filter(
        (c) => !(c.properties?.className ?? []).includes("copy"),
      );
    },
  },
};

// ---- Themes: the console's highlight roles (docs plan 8.2) ---------------------------------------
//
// `TOKEN_CLASS` in the console's lib/highlight.ts says which role colours which token (keyword →
// info, string → success, number → warning, key → accent-fg, comment → fg-subtle, punctuation →
// fg-muted). The class names are resolved here against tokens.json, per theme, so there is no
// colour of the docs' own and no blue. Syntax-role contrast (>= 4.5:1 on the code ground) is
// pinned by test/codeThemes.test.ts.
function roleColour(theme, role) {
  const t = tokens.themes[theme];
  const colours = {
    "text-fg": t.text.default,
    "text-fg-muted": t.text.muted,
    "text-fg-subtle": t.text.subtle,
    "text-info": t.status.info.fg,
    "text-success": t.status.success.fg,
    "text-warning": t.status.warning.fg,
    "text-accent-fg": t.accent.violet.fg,
  };
  const c = colours[role];
  if (!c)
    throw new Error(`highlight role ${role} has no colour in tokens.json`);
  return c;
}

// TextMate scopes per console token kind.
const SCOPES = {
  comment: ["comment", "punctuation.definition.comment"],
  string: ["string", "punctuation.definition.string"],
  number: ["constant.numeric"],
  keyword: [
    "keyword",
    "storage",
    "constant.language",
    "support.function.builtin.shell",
    "entity.name.command.shell",
  ],
  key: [
    "support.type.property-name",
    "entity.name.tag.yaml",
    "meta.object-literal.key",
    "variable.other.property",
    "string.unquoted.plain.out.yaml",
    "support.type.property-name.toml",
    "keyword.key.toml",
  ],
  punctuation: [
    "punctuation",
    "meta.brace",
    "meta.delimiter",
    "keyword.operator",
  ],
};

export function brandTheme(mode) {
  const t = tokens.themes[mode];
  const rule = (kind) => ({
    scope: SCOPES[kind],
    settings: { foreground: roleColour(mode, TOKEN_CLASS[kind]) },
  });
  return {
    name: `polaris-key-${mode}`,
    type: mode,
    colors: {
      "editor.background": t.surface.sunken,
      "editor.foreground": roleColour(mode, TOKEN_CLASS.plain),
    },
    settings: [
      {
        settings: {
          foreground: roleColour(mode, TOKEN_CLASS.plain),
          background: t.surface.sunken,
        },
      },
      // Later rules win: punctuation first, then the specific kinds.
      rule("punctuation"),
      rule("keyword"),
      rule("key"),
      rule("number"),
      rule("string"),
      rule("comment"),
    ],
  };
}

// ---- The frame: the console's CodeBlock anatomy ------------------------------------------------
//
// A header with the file or language label and Copy docked in it (never over code); terminal
// frames titled Terminal; ligatures off; Copy announces through its live region, and when the
// clipboard refuses, selects the code and says which chord to press (the console's CopyButton
// does the same). No notes footer and no wrap toggle: the console's block has neither a footer
// nor a docs-side equivalent yet.
const LABELS = {
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  mjs: "JavaScript",
  jsx: "JSX",
  json: LANGUAGE_LABEL.json,
  jsonc: "JSON",
  yaml: LANGUAGE_LABEL.yaml,
  yml: LANGUAGE_LABEL.yaml,
  toml: LANGUAGE_LABEL.toml,
  python: "Python",
  py: "Python",
  swift: "Swift",
  kotlin: "Kotlin",
  kt: "Kotlin",
  gdscript: "GDScript",
  gd: "GDScript",
  html: "HTML",
  css: "CSS",
  xml: "XML",
  sql: "SQL",
  md: "Markdown",
  mdx: "MDX",
  text: LANGUAGE_LABEL.text,
  txt: LANGUAGE_LABEL.text,
  plaintext: LANGUAGE_LABEL.text,
};
const TERMINAL = new Set([
  "sh",
  "bash",
  "zsh",
  "shell",
  "shellscript",
  "shellsession",
  "console",
  "powershell",
  "ps1",
  "bat",
  "batch",
  "cmd",
]);

// The Copy behaviour is a real script file (ec-copy.js), so it is parsed, linted and tested as one.
export const COPY_MODULE = readFileSync(join(ROOT, "ec-copy.js"), "utf8");

const brandFrame = {
  name: "pk-brand-frame",
  baseStyles: `
    /* The console's code block: no ligatures (components.md 6.7). */
    pre, code { font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; }

    /* One flat header: a mono, muted label on the left, Copy docked on the right. */
    .frame .header { min-height: 2.25rem; padding-inline-end: 2.5rem; align-items: center; }
    .frame .header::before, .frame .header::after { display: none; }
    .frame .header .title {
      font-family: var(--pk-font-mono);
      font-size: 0.75rem;
      line-height: 1rem;
      font-weight: 400;
      color: var(--pk-text-muted);
      background: none;
      border: 0;
      border-radius: 0;
      padding: 0 0.75rem;
      margin: 0;
      text-align: start;
    }
    .frame .header .title::before, .frame .header .title::after { display: none; }
    /* A terminal title sits on the left like a file label, over the same hairline. */
    .frame.is-terminal .header { justify-content: flex-start !important; border-bottom: 1px solid var(--pk-border-subtle); }
    .frame.is-terminal .header .title { margin-inline-start: 0; }

    /* Copy: a quiet 28 px ghost button inside the header (never over the code). */
    .frame .copy {
      inset-block-start: 0.25rem;
      inset-inline-end: 0.5rem;
      align-items: flex-start;
    }
    .frame .copy button { width: 1.75rem; height: 1.75rem; opacity: 1; background: transparent; border-radius: var(--pk-radius-md); }
    .frame .copy button:hover, .frame .copy button:focus-visible { background: var(--pk-admin-fill, var(--pk-surface-overlay)); }
    .frame .copy button:hover::after, .frame .copy button:focus-visible::after { background-color: var(--pk-text-strong); }
    .frame .copy .feedback { inset-block-start: 100%; inset-inline-end: 0; }
    /* The hint when the clipboard refused is not a success: neutral, and it stays. */
    .frame .copy .feedback.pk-hint {
      background: var(--pk-surface-raised);
      color: var(--pk-text-default);
      border: 1px solid var(--pk-border-strong);
    }
    @media (forced-colors: active) {
      .frame .copy button { border: 1px solid ButtonText; forced-color-adjust: none; }
      .frame .copy button::after { background-color: ButtonText; forced-color-adjust: none; }
      .frame .copy button:hover::after, .frame .copy button:focus-visible::after { background-color: ButtonText; }
      .frame .copy .feedback { background: Canvas; color: CanvasText; border: 1px solid CanvasText; }
    }
  `,
  jsModules: [COPY_MODULE],
  hooks: {
    preprocessCode: ({ codeBlock }) => {
      const { props, language } = codeBlock;
      if (props.title !== undefined || props.frame === "none") return;
      const lang = String(language || "").toLowerCase();
      props.title = TERMINAL.has(lang)
        ? "Terminal"
        : (LABELS[lang] ?? undefined);
    },
  },
};

export default defineEcConfig({
  themes: [brandTheme("dark"), brandTheme("light")],
  minSyntaxHighlightingColorContrast: 4.5,
  plugins: [brandFrame, noCopyOnPlaceholders],
  customizeTheme(theme) {
    const sunken = theme.type === "dark" ? SUNKEN.dark : SUNKEN.light;
    theme.bg = sunken;
    theme.colors["editor.background"] = sunken;
    // The console CodeBlock's frame: one flat header on the code ground, a quiet label, no editor
    // tab, no traffic lights, no shadow (components.md 6.7).
    theme.styleOverrides.frames = {
      ...theme.styleOverrides.frames,
      frameBoxShadowCssValue: "none",
      editorBackground: "var(--pk-surface-sunken)",
      terminalBackground: "var(--pk-surface-sunken)",
      editorTabBarBackground: "var(--pk-surface-sunken)",
      terminalTitlebarBackground: "var(--pk-surface-sunken)",
      editorActiveTabBackground: "var(--pk-surface-sunken)",
      editorActiveTabForeground: "var(--pk-text-muted)",
      terminalTitlebarForeground: "var(--pk-text-muted)",
      editorActiveTabBorderColor: "transparent",
      editorActiveTabIndicatorHeight: "0px",
      editorActiveTabIndicatorTopColor: "transparent",
      editorActiveTabIndicatorBottomColor: "transparent",
      editorTabBarBorderColor: "transparent",
      editorTabBarBorderBottomColor: "var(--pk-border-subtle)",
      terminalTitlebarBorderBottomColor: "var(--pk-border-subtle)",
      terminalTitlebarDotsOpacity: "0",
      inlineButtonForeground: "var(--pk-text-muted)",
      inlineButtonBackground: "var(--pk-text-muted)",
      inlineButtonBorderOpacity: "0",
      tooltipSuccessBackground: "var(--pk-success-subtle)",
      tooltipSuccessForeground: "var(--pk-text-strong)",
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
