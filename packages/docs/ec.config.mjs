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
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The docs package directory. Not `import.meta.url`: the `<Code>` component's copy of this file is
// bundled into the SSR output (astro.config.mjs maps its config module here), where that URL
// is the bundle's. Astro builds with the package as the working directory.
const ROOT = process.cwd();

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

const COPY_MODULE = `try{(()=>{
const chord=()=>/Mac|iPhone|iPad|iPod/.test((navigator.platform||"")+" "+(navigator.userAgent||""))?"\u2318C":"Ctrl+C";
const say=(box,text)=>{const live=box&&box.querySelector("[aria-live]");if(!live)return;live.querySelectorAll(".feedback").forEach(n=>n.remove());const f=document.createElement("div");f.className="feedback";f.textContent=text;live.append(f);requestAnimationFrame(()=>f.classList.add("show"));setTimeout(()=>f.classList.remove("show"),2500);setTimeout(()=>f.remove(),3000)};
const exec=(text)=>{const pre=document.createElement("pre");Object.assign(pre.style,{opacity:"0",pointerEvents:"none",position:"absolute",left:"0",top:"0",width:"20px",height:"20px",userSelect:"all"});pre.setAttribute("aria-hidden","true");pre.textContent=text;document.body.appendChild(pre);const r=document.createRange();r.selectNode(pre);const s=getSelection();if(!s){pre.remove();return false}s.removeAllRanges();s.addRange(r);let ok=false;try{ok=document.execCommand("copy")}finally{s.removeAllRanges();pre.remove()}return ok};
document.addEventListener("click",async(e)=>{
const btn=e.target instanceof Element?e.target.closest(".expressive-code .copy button"):null;
if(!btn)return;
e.stopPropagation();
const text=btn.dataset.code.replace(/\u007f/g,"\n");
const box=btn.parentElement;
let ok=false;
try{await navigator.clipboard.writeText(text);ok=true}catch{ok=exec(text)}
if(ok){say(box,btn.dataset.copied||"Copied");return}
const code=btn.closest("figure")?.querySelector("pre code");
if(code){const r=document.createRange();r.selectNodeContents(code);const s=getSelection();s?.removeAllRanges();s?.addRange(r)}
say(box,"Press "+chord()+" to copy");
},true);
})();}catch(e){console.error("[pk] copy module failed:",e)}`;

const brandFrame = {
  name: "pk-brand-frame",
  baseStyles: `
    /* The console's code block: no ligatures (components.md 6.7). */
    pre, code { font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; }
    /* Copy is docked in the header bar, never over the code. */
    .frame.has-title .copy, .frame.is-terminal .copy {
      inset-block-start: calc(var(--header-border-width, 1px) + (var(--header-height, 2.25rem) - 2.25rem) / 2);
      inset-inline-end: 0.25rem;
    }
    .frame.has-title .copy button, .frame.is-terminal .copy button { width: 2.25rem; height: 2.25rem; opacity: 1; }
    .frame .copy .feedback { inset-block-start: 100%; }
    .frame figcaption.header { min-height: 2.25rem; }
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
