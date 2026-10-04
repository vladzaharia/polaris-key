/**
 * A tiny static highlighter for `CodeBlock` (components.md §6.7): json, ts, sh, toml and yaml,
 * with no runtime library. It is a single left-to-right scan per line that recognises comments,
 * strings, numbers, keywords, keys and punctuation; anything else is plain text. Good enough for
 * snippets and config excerpts, deliberately not a parser.
 */

export type CodeLanguage = "json" | "ts" | "sh" | "toml" | "yaml" | "text";

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "key"
  | "punctuation";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS: Record<CodeLanguage, ReadonlySet<string>> = {
  json: new Set(["true", "false", "null"]),
  ts: new Set([
    "import",
    "from",
    "export",
    "const",
    "let",
    "var",
    "function",
    "return",
    "await",
    "async",
    "new",
    "if",
    "else",
    "for",
    "of",
    "in",
    "type",
    "interface",
    "true",
    "false",
    "null",
    "undefined",
    "class",
    "extends",
    "default",
  ]),
  sh: new Set([
    "export",
    "if",
    "then",
    "fi",
    "for",
    "do",
    "done",
    "echo",
    "cd",
    "npm",
    "pnpm",
    "npx",
    "curl",
    "pkey",
  ]),
  toml: new Set(["true", "false"]),
  yaml: new Set(["true", "false", "null", "yes", "no"]),
  text: new Set(),
};

const COMMENT_START: Record<CodeLanguage, string | null> = {
  json: null,
  ts: "//",
  sh: "#",
  toml: "#",
  yaml: "#",
  text: null,
};

const PUNCT = /[{}[\](),:;=.<>+\-*/|&!?]/;

function push(tokens: Token[], kind: TokenKind, text: string): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ kind, text });
}

/** Tokenize one line. */
export function tokenizeLine(line: string, language: CodeLanguage): Token[] {
  const tokens: Token[] = [];
  if (language === "text") {
    push(tokens, "plain", line);
    return tokens;
  }
  const comment = COMMENT_START[language];
  const keywords = KEYWORDS[language];

  // A TOML table header: [section] / [[array]].
  if (language === "toml" && /^\s*\[/.test(line)) {
    const m = /^(\s*)(\[\[?[^\]]*\]\]?)(.*)$/.exec(line);
    if (m) {
      push(tokens, "plain", m[1]!);
      push(tokens, "key", m[2]!);
      tokens.push(...tokenizeLine(m[3]!, language));
      return tokens;
    }
  }
  // A YAML or TOML key at line start: `key:` / `key =`.
  if (language === "yaml" || language === "toml") {
    const re =
      language === "yaml"
        ? /^(\s*-?\s*)([A-Za-z0-9_.\-"']+)(\s*:)(?=\s|$)/
        : /^(\s*)([A-Za-z0-9_.\-"']+)(\s*=)/;
    const m = re.exec(line);
    if (m && !line.trimStart().startsWith(comment ?? "\0")) {
      push(tokens, "plain", m[1]!);
      push(tokens, "key", m[2]!);
      push(tokens, "punctuation", m[3]!);
      line = line.slice(m[0].length);
    }
  }

  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i]!;
    if (comment && rest.startsWith(comment)) {
      push(tokens, "comment", rest);
      break;
    }
    if (ch === '"' || ch === "'" || (ch === "`" && language === "ts")) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      const text = line.slice(i, Math.min(j + 1, line.length));
      // A JSON string followed by a colon is a key.
      const after = line.slice(i + text.length).trimStart();
      push(
        tokens,
        language === "json" && after.startsWith(":") ? "key" : "string",
        text,
      );
      i += text.length;
      continue;
    }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (num && !/[A-Za-z0-9_]/.test(line[i - 1] ?? "")) {
      push(tokens, "number", num[0]);
      i += num[0].length;
      continue;
    }
    if (language === "sh" && ch === "$") {
      const v = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.exec(rest);
      if (v) {
        push(tokens, "keyword", v[0]);
        i += v[0].length;
        continue;
      }
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(rest);
    if (word) {
      push(tokens, keywords.has(word[0]) ? "keyword" : "plain", word[0]);
      i += word[0].length;
      continue;
    }
    push(tokens, PUNCT.test(ch) ? "punctuation" : "plain", ch);
    i++;
  }
  return tokens;
}

/** Tokenize a whole snippet, one token list per line. */
export function tokenize(code: string, language: CodeLanguage): Token[][] {
  return code
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => tokenizeLine(l, language));
}

/**
 * Brand text tokens per kind. Only `fg` tokens (≥ 4.5:1 on every surface, BRAND.md §4) so
 * highlighted code stays readable in both themes.
 */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: "text-fg",
  comment: "text-fg-subtle",
  string: "text-success",
  number: "text-warning",
  keyword: "text-info",
  key: "text-accent-fg",
  punctuation: "text-fg-muted",
};
