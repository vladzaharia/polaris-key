// A linear-time regular-expression matcher for JSON-Schema `pattern`, used instead of the
// host `RegExp`.
//
// WHY NOT `new RegExp(...)`. Catalog `pattern` values are operator-supplied (admin publish,
// or `.pkey/schema` in a linked product repo). V8's engine backtracks, so a pattern like
// `(x+x+)+y` — eight characters — costs ~57 s of worker CPU against a 34-character input
// (finding R10-09). A source-length cap is not a mitigation: the pathological patterns are
// short. Static "nested quantifier" rejection helps but leaks (`(a|a)*` has star height 1 and
// is still exponential; `a*a*a*b` is polynomial), so the only control that actually holds is
// an engine that cannot backtrack.
//
// This is a Thompson/Pike NFA simulation: the whole current state set advances one input code
// point at a time, so matching is O(instructions x input) with no backtracking, for every
// pattern, including adversarial ones. Constructs that cannot be expressed without
// backtracking — backreferences, lookaround, `\b` — are rejected at compile time rather than
// silently ignored, and the input length is capped as defence in depth.
//
// Semantics target the ECMAScript `u`-flag dialect Ajv used (`unicodeRegExp: true`), matched
// code point by code point, unanchored (JSON Schema `pattern` is a partial match), with no
// `i`/`m`/`s` flags. `src/regex.test.ts` differential-tests this against the host `RegExp`.

/** Longest accepted `pattern` source. Long patterns are a smell, not a threat model. */
export const MAX_PATTERN_SOURCE = 300;
/** Instruction-budget ceiling for one compiled pattern (bounds `{n,m}` expansion). */
export const MAX_PATTERN_PROGRAM = 2000;
/** Largest `{n,m}` bound accepted. */
export const MAX_PATTERN_REPEAT = 100;
/** Longest input a pattern is ever matched against; longer values fail closed. */
export const MAX_PATTERN_INPUT = 4096;

/** A `pattern` this matcher refuses to compile. Fail closed: never fall back to `RegExp`. */
export class UnsupportedPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPatternError";
  }
}

// ── AST ──────────────────────────────────────────────────────────────────────

type ClassRange = readonly [number, number];

interface CharSet {
  readonly negate: boolean;
  readonly ranges: readonly ClassRange[];
  /** Shorthand classes: `d`, `D`, `w`, `W`, `s`, `S`. */
  readonly shorthand: readonly string[];
}

type Node =
  | { readonly k: "empty" }
  | { readonly k: "alt"; readonly opts: readonly Node[] }
  | { readonly k: "seq"; readonly items: readonly Node[] }
  | {
      readonly k: "rep";
      readonly node: Node;
      readonly min: number;
      readonly max: number;
    }
  | { readonly k: "set"; readonly set: CharSet }
  | { readonly k: "any" }
  | { readonly k: "start" }
  | { readonly k: "end" };

const SPACE_RANGES: readonly ClassRange[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
const DIGIT_RANGES: readonly ClassRange[] = [[0x30, 0x39]];
const WORD_RANGES: readonly ClassRange[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
const LINE_TERMINATORS: readonly ClassRange[] = [
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
];

function inRanges(cp: number, ranges: readonly ClassRange[]): boolean {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

function matchesShorthand(cp: number, name: string): boolean {
  switch (name) {
    case "d":
      return inRanges(cp, DIGIT_RANGES);
    case "D":
      return !inRanges(cp, DIGIT_RANGES);
    case "w":
      return inRanges(cp, WORD_RANGES);
    case "W":
      return !inRanges(cp, WORD_RANGES);
    case "s":
      return inRanges(cp, SPACE_RANGES);
    default:
      return !inRanges(cp, SPACE_RANGES);
  }
}

function matchesSet(cp: number, set: CharSet): boolean {
  let hit = inRanges(cp, set.ranges);
  if (!hit)
    for (const name of set.shorthand)
      if (matchesShorthand(cp, name)) {
        hit = true;
        break;
      }
  return set.negate ? !hit : hit;
}

// ── parser ───────────────────────────────────────────────────────────────────

/** Escapes that stand for a single literal code point. */
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  f: 0x0c,
  v: 0x0b,
  "0": 0x00,
};

class Parser {
  private i = 0;
  private readonly cps: number[];

  constructor(private readonly source: string) {
    this.cps = Array.from(source, (c) => c.codePointAt(0) as number);
  }

  private fail(msg: string): never {
    throw new UnsupportedPatternError(`pattern: ${msg} (at offset ${this.i})`);
  }

  private peek(): number | undefined {
    return this.cps[this.i];
  }

  private eat(cp: number): boolean {
    if (this.cps[this.i] === cp) {
      this.i++;
      return true;
    }
    return false;
  }

  parse(): Node {
    const node = this.parseAlt();
    if (this.i < this.cps.length) this.fail("unbalanced `)`");
    return node;
  }

  private parseAlt(): Node {
    const opts: Node[] = [this.parseSeq()];
    while (this.eat(0x7c /* | */)) opts.push(this.parseSeq());
    return opts.length === 1 ? (opts[0] as Node) : { k: "alt", opts };
  }

  private parseSeq(): Node {
    const items: Node[] = [];
    for (;;) {
      const cp = this.peek();
      if (cp === undefined || cp === 0x7c /* | */ || cp === 0x29 /* ) */) break;
      items.push(this.parseQuantified());
    }
    if (items.length === 0) return { k: "empty" };
    return items.length === 1 ? (items[0] as Node) : { k: "seq", items };
  }

  private parseQuantified(): Node {
    const atom = this.parseAtom();
    const q = this.parseQuantifier();
    if (!q) return atom;
    if (atom.k === "start" || atom.k === "end")
      this.fail("a quantifier may not be applied to an anchor");
    return { k: "rep", node: atom, min: q.min, max: q.max };
  }

  private parseQuantifier(): { min: number; max: number } | null {
    const cp = this.peek();
    let min: number;
    let max: number;
    if (cp === 0x2a /* * */) {
      this.i++;
      min = 0;
      max = Infinity;
    } else if (cp === 0x2b /* + */) {
      this.i++;
      min = 1;
      max = Infinity;
    } else if (cp === 0x3f /* ? */) {
      this.i++;
      min = 0;
      max = 1;
    } else if (cp === 0x7b /* { */) {
      const braced = this.parseBraces();
      if (!braced) return null;
      ({ min, max } = braced);
    } else {
      return null;
    }
    // Laziness (`*?`) cannot change *whether* a match exists, only which one is chosen.
    this.eat(0x3f /* ? */);
    return { min, max };
  }

  private parseBraces(): { min: number; max: number } | null {
    const start = this.i;
    this.i++; // consume `{`
    const digits = (): number | null => {
      let out = "";
      while (this.i < this.cps.length) {
        const c = this.cps[this.i] as number;
        if (c < 0x30 || c > 0x39) break;
        out += String.fromCodePoint(c);
        this.i++;
      }
      return out === "" ? null : Number(out);
    };
    const min = digits();
    if (min === null) {
      this.i = start;
      return null; // a literal `{`, as ECMAScript allows in non-`u` mode — but `u` forbids it
    }
    let max = min;
    if (this.eat(0x2c /* , */)) max = digits() ?? Infinity;
    if (!this.eat(0x7d /* } */)) {
      this.i = start;
      return null;
    }
    if (min > max) this.fail("`{n,m}` with n > m");
    if (max !== Infinity && max > MAX_PATTERN_REPEAT)
      this.fail(
        `\`{n,m}\` bound ${max} exceeds the ${MAX_PATTERN_REPEAT} limit`,
      );
    if (min > MAX_PATTERN_REPEAT)
      this.fail(
        `\`{n,m}\` bound ${min} exceeds the ${MAX_PATTERN_REPEAT} limit`,
      );
    return { min, max };
  }

  private parseAtom(): Node {
    const cp = this.peek();
    if (cp === undefined) this.fail("unexpected end of pattern");
    if (cp === 0x28 /* ( */) return this.parseGroup();
    if (cp === 0x5b /* [ */) return this.parseClass();
    if (cp === 0x2e /* . */) {
      this.i++;
      return { k: "any" };
    }
    if (cp === 0x5e /* ^ */) {
      this.i++;
      return { k: "start" };
    }
    if (cp === 0x24 /* $ */) {
      this.i++;
      return { k: "end" };
    }
    if (cp === 0x5c /* \ */) return this.parseEscape(false);
    if (cp === 0x2a || cp === 0x2b || cp === 0x3f)
      this.fail("a quantifier with nothing to repeat");
    if (cp === 0x7d /* } */ || cp === 0x5d /* ] */)
      this.fail("an unescaped `}` or `]` is not valid in `u` mode");
    this.i++;
    return literal(cp);
  }

  private parseGroup(): Node {
    this.i++; // `(`
    if (this.eat(0x3f /* ? */)) {
      if (this.eat(0x3a /* : */)) {
        // non-capturing — fall through
      } else if (this.peek() === 0x3d /* = */ || this.peek() === 0x21 /* ! */) {
        this.fail("lookahead is not supported (it cannot be matched linearly)");
      } else if (this.peek() === 0x3c /* < */) {
        const after = this.cps[this.i + 1];
        if (after === 0x3d /* = */ || after === 0x21 /* ! */)
          this.fail("lookbehind is not supported");
        // `(?<name>…)` — a named capture. Captures are irrelevant to a boolean match, so
        // consume the name and treat it as a plain group.
        this.i++; // `<`
        while (this.i < this.cps.length && this.cps[this.i] !== 0x3e /* > */)
          this.i++;
        if (!this.eat(0x3e)) this.fail("unterminated group name");
      } else {
        this.fail("unsupported group modifier");
      }
    }
    const inner = this.parseAlt();
    if (!this.eat(0x29 /* ) */)) this.fail("unbalanced `(`");
    return inner;
  }

  /** `inClass` selects character-class escape rules (where `\b` means backspace). */
  private parseEscape(inClass: boolean): Node {
    this.i++; // `\`
    const cp = this.peek();
    if (cp === undefined) this.fail("trailing `\\`");
    const ch = String.fromCodePoint(cp);
    if ("dDwWsS".includes(ch)) {
      this.i++;
      return { k: "set", set: { negate: false, ranges: [], shorthand: [ch] } };
    }
    if (!inClass && (ch === "b" || ch === "B"))
      this.fail("`\\b` / `\\B` word boundaries are not supported");
    if (inClass && ch === "b") {
      this.i++;
      return literal(0x08);
    }
    if (cp >= 0x31 && cp <= 0x39)
      this.fail("backreferences are not supported (they require backtracking)");
    if (ch === "k") this.fail("named backreferences are not supported");
    if (ch === "p" || ch === "P")
      this.fail("`\\p{…}` unicode property escapes are not supported");
    if (ch === "c") {
      const letter = this.cps[this.i + 1];
      if (letter === undefined) this.fail("bad `\\c` escape");
      this.i += 2;
      return literal(letter % 32);
    }
    if (ch === "x") {
      this.i++;
      return literal(this.hex(2));
    }
    if (ch === "u") {
      this.i++;
      if (this.eat(0x7b /* { */)) {
        let out = 0;
        let seen = 0;
        while (this.i < this.cps.length && this.cps[this.i] !== 0x7d) {
          out = out * 16 + this.hexDigit(this.cps[this.i] as number);
          this.i++;
          seen++;
        }
        if (!this.eat(0x7d) || seen === 0) this.fail("bad `\\u{…}` escape");
        return literal(out);
      }
      return literal(this.hex(4));
    }
    if (ch in SIMPLE_ESCAPES) {
      this.i++;
      return literal(SIMPLE_ESCAPES[ch] as number);
    }
    // `u` mode only permits escaping syntax characters; be permissive and take the literal.
    this.i++;
    return literal(cp);
  }

  private hexDigit(cp: number): number {
    if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
    if (cp >= 0x61 && cp <= 0x66) return cp - 0x61 + 10;
    if (cp >= 0x41 && cp <= 0x46) return cp - 0x41 + 10;
    return this.fail("bad hex escape");
  }

  private hex(n: number): number {
    let out = 0;
    for (let k = 0; k < n; k++) {
      const cp = this.cps[this.i];
      if (cp === undefined) this.fail("truncated hex escape");
      out = out * 16 + this.hexDigit(cp);
      this.i++;
    }
    return out;
  }

  private parseClass(): Node {
    this.i++; // `[`
    const negate = this.eat(0x5e /* ^ */);
    const ranges: ClassRange[] = [];
    const shorthand: string[] = [];
    let closed = false;
    while (this.i < this.cps.length) {
      if (this.eat(0x5d /* ] */)) {
        closed = true;
        break;
      }
      const first = this.classAtom();
      if (first.kind === "shorthand") {
        shorthand.push(first.name);
        continue;
      }
      // A `-` is a range only when it sits between two single code points.
      if (this.peek() === 0x2d /* - */ && this.cps[this.i + 1] !== 0x5d) {
        const save = this.i;
        this.i++;
        const second = this.classAtom();
        if (second.kind === "shorthand") {
          // `[a-\d]` is a `u`-mode syntax error; treat the `-` as a literal instead.
          this.i = save;
          ranges.push([first.cp, first.cp]);
          continue;
        }
        if (second.cp < first.cp) this.fail("reversed character-class range");
        ranges.push([first.cp, second.cp]);
        continue;
      }
      ranges.push([first.cp, first.cp]);
    }
    if (!closed) this.fail("unterminated character class");
    return { k: "set", set: { negate, ranges, shorthand } };
  }

  private classAtom():
    | { kind: "cp"; cp: number }
    | { kind: "shorthand"; name: string } {
    if (this.peek() === 0x5c /* \ */) {
      // Inside a class `parseEscape` always yields a `set` node: either a shorthand
      // (`\d`) or a single-code-point literal.
      const node = this.parseEscape(true) as SetNode;
      const name = node.set.shorthand[0];
      if (name !== undefined) return { kind: "shorthand", name };
      return { kind: "cp", cp: (node.set.ranges[0] as ClassRange)[0] };
    }
    const cp = this.peek();
    if (cp === undefined) this.fail("unterminated character class");
    this.i++;
    return { kind: "cp", cp };
  }
}

type SetNode = Extract<Node, { k: "set" }>;

function literal(cp: number): Node {
  return {
    k: "set",
    set: { negate: false, ranges: [[cp, cp]], shorthand: [] },
  };
}

// ── NFA program ──────────────────────────────────────────────────────────────

type Inst =
  | { op: "set"; set: CharSet }
  | { op: "any" }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; x: number }
  | { op: "start" }
  | { op: "end" }
  | { op: "match" };

class Program {
  readonly insts: Inst[] = [];

  emit(inst: Inst): number {
    if (this.insts.length >= MAX_PATTERN_PROGRAM)
      throw new UnsupportedPatternError(
        `pattern: expands past the ${MAX_PATTERN_PROGRAM}-instruction budget`,
      );
    this.insts.push(inst);
    return this.insts.length - 1;
  }

  /** Backpatch a `split`/`jmp` target once the branch length is known. */
  setX(at: number, value: number): void {
    (this.insts[at] as { x: number }).x = value;
  }

  setY(at: number, value: number): void {
    (this.insts[at] as { y: number }).y = value;
  }
}

function emitNode(p: Program, node: Node): void {
  switch (node.k) {
    case "empty":
      return;
    case "set":
      p.emit({ op: "set", set: node.set });
      return;
    case "any":
      p.emit({ op: "any" });
      return;
    case "start":
      p.emit({ op: "start" });
      return;
    case "end":
      p.emit({ op: "end" });
      return;
    case "seq":
      for (const item of node.items) emitNode(p, item);
      return;
    case "alt": {
      const jumps: number[] = [];
      for (let i = 0; i < node.opts.length; i++) {
        if (i === node.opts.length - 1) {
          emitNode(p, node.opts[i] as Node);
          break;
        }
        const split = p.emit({ op: "split", x: 0, y: 0 });
        p.setX(split, p.insts.length);
        emitNode(p, node.opts[i] as Node);
        jumps.push(p.emit({ op: "jmp", x: 0 }));
        p.setY(split, p.insts.length);
      }
      for (const j of jumps) p.setX(j, p.insts.length);
      return;
    }
    case "rep": {
      const { min, max } = node;
      for (let i = 0; i < min; i++) emitNode(p, node.node);
      if (max === Infinity) {
        // `x*` — split into body-or-exit, emit the body, jump back to the split.
        const split = p.emit({ op: "split", x: 0, y: 0 });
        p.setX(split, p.insts.length);
        emitNode(p, node.node);
        p.emit({ op: "jmp", x: split });
        p.setY(split, p.insts.length);
      } else {
        // `x{min,max}` — `max - min` nested optional copies, all exiting to the same point.
        const splits: number[] = [];
        for (let i = min; i < max; i++) {
          const split = p.emit({ op: "split", x: 0, y: 0 });
          p.setX(split, p.insts.length);
          splits.push(split);
          emitNode(p, node.node);
        }
        for (const s of splits) p.setY(s, p.insts.length);
      }
      return;
    }
  }
}

/**
 * A work counter, a test hook (not exported from the package; the counterpart of the Godot SDK's
 * `PKeyPck.scan_probes`, P1-13): every NFA instruction `test` visits, in an epsilon closure or
 * against an input code point, adds one. Per input position that is at most a small multiple of
 * the program's size, so a linear match costs O(instructions x input) steps and a backtracking
 * regression would cost exponentially more. The ReDoS checks diff it around a call instead of
 * reading a clock, so they hold on a machine of any speed or load.
 */
export const patternWork = { steps: 0 };

// ── public API ───────────────────────────────────────────────────────────────

export interface LinearPattern {
  readonly source: string;
  /** True when `input` contains a match. Inputs over `MAX_PATTERN_INPUT` return false. */
  test(input: string): boolean;
}

class CompiledPattern implements LinearPattern {
  private readonly mark: Int32Array;
  private generation = 0;

  constructor(
    readonly source: string,
    private readonly insts: readonly Inst[],
  ) {
    this.mark = new Int32Array(insts.length).fill(-1);
  }

  /** Epsilon-closure of `pc`, appended to `list`. Returns true if `match` is reachable. */
  private addThread(
    list: number[],
    pc: number,
    pos: number,
    len: number,
  ): boolean {
    const stack = [pc];
    while (stack.length) {
      const at = stack.pop() as number;
      patternWork.steps++;
      if (this.mark[at] === this.generation) continue;
      this.mark[at] = this.generation;
      const inst = this.insts[at] as Inst;
      switch (inst.op) {
        case "jmp":
          stack.push(inst.x);
          break;
        case "split":
          stack.push(inst.y, inst.x);
          break;
        case "start":
          if (pos === 0) stack.push(at + 1);
          break;
        case "end":
          if (pos === len) stack.push(at + 1);
          break;
        case "match":
          return true;
        default:
          list.push(at);
      }
    }
    return false;
  }

  test(input: string): boolean {
    if (input.length > MAX_PATTERN_INPUT) return false;
    if (this.generation > 0x7ffffff0) {
      this.mark.fill(-1);
      this.generation = 0;
    }
    const cps = Array.from(input, (c) => c.codePointAt(0) as number);
    const len = cps.length;
    let cur: number[] = [];
    let next: number[] = [];
    for (let pos = 0; pos <= len; pos++) {
      // Seeding the start state at every position makes the search unanchored, which is
      // what JSON Schema `pattern` means. Total work stays O(insts x input).
      this.generation++;
      const carried = cur;
      cur = [];
      for (const pc of carried) {
        if (this.mark[pc] !== this.generation) {
          this.mark[pc] = this.generation;
          cur.push(pc);
        }
      }
      if (this.addThread(cur, 0, pos, len)) return true;
      if (pos === len) break;
      const cp = cps[pos] as number;
      next = [];
      this.generation++;
      for (const pc of cur) {
        patternWork.steps++;
        const inst = this.insts[pc] as Inst;
        const hit =
          inst.op === "any"
            ? !inRanges(cp, LINE_TERMINATORS)
            : inst.op === "set" && matchesSet(cp, inst.set);
        if (hit && this.addThread(next, pc + 1, pos + 1, len)) return true;
      }
      cur = next;
    }
    return false;
  }
}

/**
 * Compile a JSON-Schema `pattern` into a backtracking-free matcher.
 * Throws `UnsupportedPatternError` for anything oversized or inexpressible — callers must
 * treat that as "this schema fragment is invalid", never as "skip the check".
 */
export function compileLinearPattern(source: string): LinearPattern {
  if (typeof source !== "string")
    throw new UnsupportedPatternError("pattern: must be a string");
  if (source.length > MAX_PATTERN_SOURCE)
    throw new UnsupportedPatternError(
      `pattern: source of ${source.length} characters exceeds the ${MAX_PATTERN_SOURCE} limit`,
    );
  const ast = new Parser(source).parse();
  const program = new Program();
  emitNode(program, ast);
  program.emit({ op: "match" });
  return new CompiledPattern(source, program.insts);
}
