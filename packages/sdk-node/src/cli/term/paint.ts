// Paint styled spans for one terminal (UI-KITS.md §2.1 "Terminal"): the role table is the
// generated TERMINAL_SGR, drawn with `util.styleText` so a role is a named Node style, never a
// hand-written escape. Truecolor appears in one place only, the product chip, and only when the
// terminal says it can (caps.color === "truecolor"). With colour off every span is plain text;
// the chip and a user code keep a one-cell pad so they still read as a block. Every text passes
// the sanitiser (sanitize.ts) here, at the writer, before any escape is put around it.

import { styleText } from "node:util";
import { TERMINAL_SGR, type TerminalRole } from "../tokens.generated.js";
import type { TerminalCaps } from "./caps.js";
import { osc8 } from "./osc.js";
import { clean } from "./sanitize.js";
import type { Line, Span } from "./width.js";

/**
 * The roles a span may carry: the generated table plus `code` (a user code in reverse video).
 * A `code` or `chip` span carries its own one-cell pad in its text, so widths stay exact.
 */
export type Role = TerminalRole | "code";

/** One `util.styleText` format name. */
type StyleName = Extract<Parameters<typeof styleText>[0], string>;

/** SGR parameter → `util.styleText` format name. */
const STYLE_NAMES: Record<string, StyleName> = {
  "1": "bold",
  "2": "dim",
  "4": "underline",
  "7": "inverse",
  "31": "red",
  "32": "green",
  "33": "yellow",
  "35": "magenta",
  "36": "cyan",
  "90": "gray",
};

/** The style names for one role. */
export function roleStyles(role: Role): StyleName[] {
  if (role === "code") return ["inverse", "bold"];
  if (role === "reset") return [];
  return TERMINAL_SGR[role]
    .split(";")
    .map((code) => STYLE_NAMES[code])
    .filter((s): s is StyleName => s !== undefined);
}

/** The accent the chip draws in truecolor (the resolver's `solid` and `on`, §3.3). */
export interface ChipColors {
  solid: string;
  on: string;
}

/** Per-role truecolor overrides from `theme.colors` (hex), applied only in truecolor. */
export type RoleColors = Partial<Record<TerminalRole, string>>;

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class Painter {
  constructor(
    readonly caps: TerminalCaps,
    /** The product accent, or null for the ink chip (§1.2: no icon, no accent). */
    readonly accent: ChipColors | null = null,
    readonly overrides: RoleColors = {},
    /** No product accent at all (§1.2 step 3): the accent role draws as `strong`, not cyan. */
    readonly ink = false,
  ) {}

  get colored(): boolean {
    return this.caps.color !== "none";
  }

  /** Apply roles to text. */
  style(raw: string, roles: readonly string[] = []): string {
    // The writer's one sanitiser: no control character from any text reaches the terminal.
    const text = clean(raw);
    if (!this.colored || text === "" || roles.length === 0) return text;
    let out = text;
    for (const r of roles as Role[]) {
      const role: Role = this.ink && r === "accent" ? "strong" : r;
      const hex =
        this.caps.color === "truecolor" && role !== "code"
          ? this.overrides[role as TerminalRole]
          : undefined;
      const c = hex ? rgb(hex) : null;
      if (c) {
        out = `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${out}\x1b[39m`;
        continue;
      }
      const names = roleStyles(role);
      if (names.length) out = styleText(names, out, { validateStream: false });
    }
    return out;
  }

  /** One span: its roles, a code's pad, and an OSC 8 link when the terminal takes them. */
  span(s: Span): string {
    const roles = s.style ?? [];
    const painted = roles.includes("chip")
      ? this.chipText(s.text)
      : this.style(s.text, roles);
    return s.link && this.caps.links ? osc8(s.link, painted) : painted;
  }

  line(line: Line): string {
    return line.map((s) => this.span(s)).join("");
  }

  /**
   * The product chip: the name on the accent (truecolor), inverse cyan (ANSI-16 with an accent),
   * plain inverse (the ink chip) or a padded name (no colour).
   */
  chip(name: string): string {
    return this.chipText(` ${name} `);
  }

  /** The chip's colours over already padded text. */
  chipText(raw: string): string {
    const text = clean(raw);
    if (!this.colored) return text;
    if (this.caps.color === "truecolor" && this.accent) {
      const bg = rgb(this.accent.solid);
      const fg = rgb(this.accent.on);
      if (bg && fg)
        return `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m${text}\x1b[39m\x1b[49m`;
    }
    return this.accent && !this.ink
      ? styleText(["cyan", "inverse"], text, { validateStream: false })
      : styleText("inverse", text, { validateStream: false });
  }
}
