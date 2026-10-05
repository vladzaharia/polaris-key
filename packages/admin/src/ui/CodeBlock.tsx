import * as React from "react";
import { WrapText } from "lucide-react";
import { cn } from "../lib/cn.js";
import { TOKEN_CLASS, tokenize, type CodeLanguage } from "../lib/highlight.js";
import { ValueCopyButton } from "./IdChip.js";

export interface CodeBlockProps {
  code: string;
  language?: CodeLanguage;
  /** Shown in the header; also names the block for assistive tech. */
  filename?: string;
  /** A copy button in the header (default true). */
  copy?: boolean;
  lineNumbers?: boolean;
  /** Start wrapped; the header toggle flips it. */
  wrap?: boolean;
  className?: string;
}

const LANGUAGE_LABEL: Record<CodeLanguage, string> = {
  json: "JSON",
  ts: "TypeScript",
  sh: "Shell",
  toml: "TOML",
  yaml: "YAML",
  text: "Text",
};

/**
 * A static, highlighted code snippet (components.md §6.7): a tiny in-house tokenizer
 * (`lib/highlight.ts`), copy, a wrap toggle and optional line numbers. No runtime highlighter.
 */
export function CodeBlock({
  code,
  language = "text",
  filename,
  copy = true,
  lineNumbers = false,
  wrap: initialWrap = false,
  className,
}: CodeBlockProps): React.ReactElement {
  const [wrap, setWrap] = React.useState(initialWrap);
  const lines = React.useMemo(() => tokenize(code, language), [code, language]);
  const name = filename ?? `${LANGUAGE_LABEL[language]} snippet`;
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-surface-sunken",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted"
          title={filename ?? LANGUAGE_LABEL[language]}
        >
          {filename ?? LANGUAGE_LABEL[language]}
        </span>
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => setWrap((w) => !w)}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-fg-muted hover:bg-hover hover:text-fg-strong",
            wrap && "text-fg-strong",
          )}
        >
          <WrapText aria-hidden className="size-3.5" />
          Wrap
        </button>
        {copy ? <ValueCopyButton value={code} label={`Copy ${name}`} /> : null}
      </div>
      <pre
        tabIndex={0}
        role="region"
        aria-label={name}
        className={cn(
          "pk-scroll overflow-x-auto p-3 font-mono text-xs leading-5",
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
        )}
      >
        <code>
          {lines.map((tokens, i) => (
            <span key={i} className="block">
              {lineNumbers ? (
                <span
                  aria-hidden
                  className="mr-4 inline-block w-6 select-none text-right text-fg-subtle"
                >
                  {i + 1}
                </span>
              ) : null}
              {tokens.length === 0 ? "\n" : null}
              {tokens.map((t, j) => (
                <span key={j} className={TOKEN_CLASS[t.kind]}>
                  {t.text}
                </span>
              ))}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
