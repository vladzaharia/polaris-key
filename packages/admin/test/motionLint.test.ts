import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The motion lint (notes/S-23 §6.8; MO-02). New code stays on the motion tokens and patterns
 * (src/motion.css, src/ui/motion/), so it reduces to an instant swap with them. It fails on:
 *
 *   1. `transition-all` (S-23 §6.2 rule 2: never transition everything);
 *   2. arbitrary `duration-[…]`, `ease-[…]` and `delay-[…]` (use the token utilities,
 *      `duration-(--pk-duration-*)`, `ease-standard`…);
 *   3. a raw millisecond value inside a class token (`[transition-duration:150ms]`, `delay-150ms`…);
 *   3a. Tailwind's numbered timing utilities (`duration-300`, `delay-150`), which bypass the
 *      tokens and so never collapse under reduced motion;
 *   4. a JSX `style` that sets `transition*`, `animation*` or `transform` (D8: motion lives in
 *      the stylesheet; dynamic values go through the CSSOM in the motion layer);
 *   5. `animate-pulse`, beyond today's sites (D6: blocks do not pulse; MO-09 and MO-10 retire the
 *      allowlisted ones and shrink the list).
 *
 * The repo has no ESLint (AGENTS.md rule 6), so, like the boundary check, this is a test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

/** Today's `animate-pulse` sites, by file and count (S-23 §4.3). The list may only shrink. */
const PULSE_ALLOWLIST: Record<string, number> = {
  "ui/charts/StatTile.tsx": 2, // MO-09
  "console/pages/platform.tsx": 4, // MO-10
  "console/pages/platformOperations.tsx": 1, // MO-10
  "console/pages/platformSettings.tsx": 2, // MO-10
  "console/pages/platformStores.tsx": 2, // MO-10
  "console/pages/global/Home.tsx": 1, // MO-10
};

export interface MotionFinding {
  rule:
    | "transition-all"
    | "arbitrary-timing"
    | "raw-ms-class"
    | "numbered-timing"
    | "style-motion"
    | "animate-pulse";
  line: number;
  text: string;
}

// Banned names are spelled in pieces, so Tailwind's source scan never sees them in this file.
const TRANSITION_ALL = new RegExp(`(^|[\\s"'\`:])${"transition"}-${"all"}\\b`);
const ARBITRARY_TIMING = new RegExp(
  `(^|[\\s"'\`:])(${["duration", "ease", "delay"].join("|")})-\\[`,
);
const NUMBERED_TIMING = new RegExp(
  `(^|[\\s"'\`:])(${["duration", "delay"].join("|")})-\\d+(?![\\w.-])`,
);
const PULSE = new RegExp(`\\b${"animate"}-${"pulse"}\\b`);
const STYLE_MOTION_KEY =
  /(?:^|[{,\s])["']?(transition[A-Za-z]*|animation[A-Za-z]*|transform)["']?\s*:/;

/** Blank out comments, keeping line numbers (strings are kept: class names live in them). */
function stripComments(code: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const chunk = code.slice(i, end === -1 ? code.length : end + 2);
      out += chunk.replace(/[^\n]/g, " ");
      i += chunk.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The string literals in `code` (quotes and templates), with the line each starts on. */
function strings(code: string): Array<{ value: string; line: number }> {
  const out: Array<{ value: string; line: number }> = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const m of code.matchAll(re)) {
    const line = code.slice(0, m.index).split("\n").length;
    out.push({ value: m[2]!, line });
  }
  return out;
}

/** The object or expression after each `style={`, brace-balanced. */
function styleProps(code: string): Array<{ value: string; line: number }> {
  const out: Array<{ value: string; line: number }> = [];
  for (const m of code.matchAll(/\bstyle=\{/g)) {
    let depth = 1;
    let j = m.index! + m[0].length;
    while (j < code.length && depth > 0) {
      if (code[j] === "{") depth++;
      else if (code[j] === "}") depth--;
      j++;
    }
    out.push({
      value: code.slice(m.index! + m[0].length, j - 1),
      line: code.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/** Lint one file's source. */
export function lintMotion(source: string): MotionFinding[] {
  const code = stripComments(source);
  const findings: MotionFinding[] = [];
  const lines = code.split("\n");
  lines.forEach((text, k) => {
    if (TRANSITION_ALL.test(text))
      findings.push({ rule: "transition-all", line: k + 1, text: text.trim() });
    if (ARBITRARY_TIMING.test(text))
      findings.push({
        rule: "arbitrary-timing",
        line: k + 1,
        text: text.trim(),
      });
    if (NUMBERED_TIMING.test(text))
      findings.push({
        rule: "numbered-timing",
        line: k + 1,
        text: text.trim(),
      });
    if (PULSE.test(text))
      findings.push({ rule: "animate-pulse", line: k + 1, text: text.trim() });
  });
  for (const s of strings(code))
    for (const token of s.value.split(/\s+/))
      // A class-shaped token (a utility, a variant or an arbitrary value) holding a raw ms value.
      if (/\d+(\.\d+)?ms\b/.test(token) && /[-[:]/.test(token))
        findings.push({ rule: "raw-ms-class", line: s.line, text: token });
  for (const p of styleProps(code)) {
    const m = p.value.match(STYLE_MOTION_KEY);
    if (m) findings.push({ rule: "style-motion", line: p.line, text: m[1]! });
  }
  return findings;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
      out.push(p);
  }
  return out;
}

describe("the motion lint", () => {
  const files = sourceFiles(SRC).map((p) => ({
    rel: relative(SRC, p).split(sep).join("/"),
    findings: lintMotion(readFileSync(p, "utf8")),
  }));

  it("scans the app's source", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.rel === "ui/motion/viewTransition.ts")).toBe(
      true,
    );
  });

  it("finds no transition-all, arbitrary or numbered timing, raw ms classes or motion in JSX style", () => {
    const bad = files.flatMap((f) =>
      f.findings
        .filter((x) => x.rule !== "animate-pulse")
        .map((x) => `${f.rel}:${x.line} ${x.rule}: ${x.text}`),
    );
    expect(bad).toEqual([]);
  });

  it("allows animate-pulse only at today's sites, and the allowlist only shrinks", () => {
    const counts: Record<string, number> = {};
    for (const f of files) {
      const n = f.findings.filter((x) => x.rule === "animate-pulse").length;
      if (n) counts[f.rel] = n;
    }
    for (const [file, n] of Object.entries(counts))
      expect(
        n,
        `${file}: ${n} animate-pulse (allowed ${PULSE_ALLOWLIST[file] ?? 0}); use a shaped skeleton (.pk-skeleton)`,
      ).toBeLessThanOrEqual(PULSE_ALLOWLIST[file] ?? 0);
    for (const [file, allowed] of Object.entries(PULSE_ALLOWLIST))
      expect(
        counts[file] ?? 0,
        `${file} has fewer animate-pulse sites than allowed: lower PULSE_ALLOWLIST`,
      ).toBe(allowed);
  });
});

describe("the motion lint's fixture", () => {
  // Assembled from pieces for the same reason as the patterns above.
  const t = "transition";
  const [du, ea, de] = ["duration", "ease", "delay"];
  const fixture = [
    `export const A = () => <div className="${t}-all hover:bg-hover" />;`,
    `export const B = () => <div className="${du}-[250ms]" />;`,
    `export const C = () => <div className="${ea}-[cubic-bezier(0,0,1,1)]" />;`,
    `export const D = () => <div className="[${t}-duration:150ms] opacity-0" />;`,
    `export const E = () => <div style={{ ${t}: "opacity 1s" }} />;`,
    `export const F = () => <div style={{ animationDuration: x }} />;`,
    `export const G = () => <div style={{ "transform": "scale(2)" }} />;`,
    `export const H = () => <div className="h-4 animate-${"pulse"}" />;`,
    `export const I = () => <div className={cn("${de}-[80ms]", a)} />;`,
    `export const J = () => <div className="transition-opacity ${du}-300" />;`,
    `export const K = () => <div className={cn("hover:${de}-150", a)} />;`,
  ].join("\n");

  it("fails on each banned pattern", () => {
    const found = lintMotion(fixture);
    const byLine = (line: number) =>
      found.filter((f) => f.line === line).map((f) => f.rule);
    expect(byLine(1)).toContain("transition-all");
    expect(byLine(2)).toContain("arbitrary-timing");
    expect(byLine(3)).toContain("arbitrary-timing");
    expect(byLine(4)).toContain("raw-ms-class");
    expect(byLine(5)).toEqual(["style-motion"]);
    expect(byLine(6)).toEqual(["style-motion"]);
    expect(byLine(7)).toEqual(["style-motion"]);
    expect(byLine(8)).toEqual(["animate-pulse"]);
    expect(byLine(9)).toContain("arbitrary-timing");
    expect(byLine(10)).toEqual(["numbered-timing"]);
    expect(byLine(11)).toEqual(["numbered-timing"]);
  });

  it("passes the token forms, geometry styles, comments and prose", () => {
    const ok = [
      `const a = <i className="transition-colors duration-(--pk-duration-fast) ease-standard" />;`,
      `const b = <td style={{ height: top, padding: 0 }} />;`,
      `const c = <div style={{ "--sidebar-w": rail ? "3.5rem" : "15rem" } as React.CSSProperties} />;`,
      `// a comment about ${t}-all and 120ms is fine`,
      `/* animate-${"pulse"} in a block comment */`,
      `const d = "Retry in 500ms";`,
      `el.style.setProperty("--pk-countdown", \`\${ms}ms\`);`,
      `const e = <i className="delay-(--pk-delay-skeleton) duration-(--pk-duration-base)" />;`,
      `const f = "Waits 300 ms"; // duration-300 in a comment, and the-duration-300 is not a utility`,
    ].join("\n");
    expect(lintMotion(ok)).toEqual([]);
  });
});
