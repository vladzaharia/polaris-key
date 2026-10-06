/**
 * Counted native-regex work for the worker's ReDoS checks: they count work and never read a clock,
 * so load cannot fail them (the rule P1-13 set for the Godot SDK). V8's `RegExp` reports no step
 * count, so a check
 *
 *   1. records every native regex run the code under test makes (`recordRegexRuns`: a wrapper on
 *      `RegExp.prototype.exec`, which `test`, `replace`, `split`, `match` and `matchAll` all reach
 *      once the prototype is modified, as the spec's RegExpExec requires), and
 *   2. replays each run on the small backtracking engine below, which counts one step per
 *      instruction it executes (`replaySteps`).
 *
 * Irregexp is a backtracking engine that tries the same alternatives in the same order. Its
 * optimisations (literal pre-scans, greedy-loop shortcuts) save it steps but leave these
 * patterns' growth unchanged. So a run that is linear here is linear there, and a pattern that
 * backtracks super-linearly here backtracks there too: the shapes R10-07 and the notes summary's
 * ReDoS fix are about.
 *
 * Syntax the engine does not model (lookaround, backreferences, the `i` flag, a loop whose body
 * can match the empty string) throws, so a new pattern fails the check loudly instead of
 * counting nothing. Wrapping `exec` invalidates V8's regexp fast paths for the rest of the
 * process; that costs speed, never results.
 */

/** One native regex execution: the pattern, and where in which input it was asked to look. */
export interface RegexRun {
  source: string;
  flags: string;
  input: string;
  lastIndex: number;
}

/** Runs `fn` and returns what it returned together with every native regex run it made. */
export function recordRegexRuns<T>(fn: () => T): {
  result: T;
  runs: RegexRun[];
} {
  const runs: RegexRun[] = [];
  const exec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, s: string) {
    runs.push({
      source: this.source,
      flags: this.flags,
      input: String(s),
      lastIndex: this.lastIndex,
    });
    return exec.call(this, s);
  };
  try {
    return { result: fn(), runs };
  } finally {
    RegExp.prototype.exec = exec;
  }
}

/** Total backtracking steps to replay every run (a run that matched stops where it matched). */
export function replaySteps(runs: readonly RegexRun[]): number {
  let total = 0;
  const programs = new Map<string, Program>();
  for (const r of runs) {
    const key = `${r.flags}/${r.source}`;
    let p = programs.get(key);
    if (!p) {
      p = compile(r.source, r.flags);
      programs.set(key, p);
    }
    total += execRun(p, r.input, r.lastIndex).steps;
  }
  return total;
}

/** Steps for one `exec` of `source` (with `flags`) against `input`, as `RegExp` would run it,
 *  and whether it found a match (the self-test compares that with `RegExp`). */
export function regexSteps(
  source: string,
  flags: string,
  input: string,
  lastIndex = 0,
): { steps: number; matched: boolean } {
  return execRun(compile(source, flags), input, lastIndex);
}

/** A replay that runs this long is not linear in anything a test feeds it: stop counting. */
const MAX_STEPS = 50_000_000;

// ── the engine ───────────────────────────────────────────────────────────────

type Node =
  | { t: "set"; test: (c: number) => boolean }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; opts: Node[] }
  | { t: "rep"; node: Node; min: number; max: number; greedy: boolean }
  | { t: "bol" }
  | { t: "eol" }
  | { t: "wordb"; neg: boolean };

type Inst =
  | { op: "set"; test: (c: number) => boolean }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; x: number }
  | { op: "bol" }
  | { op: "eol" }
  | { op: "wordb"; neg: boolean }
  | { op: "match" };

interface Program {
  insts: Inst[];
  global: boolean;
  sticky: boolean;
  multiline: boolean;
}

const isLineTerm = (c: number) =>
  c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isWord = (c: number) =>
  isDigit(c) ||
  (c >= 0x41 && c <= 0x5a) ||
  (c >= 0x61 && c <= 0x7a) ||
  c === 0x5f;
const isSpace = (c: number) =>
  c === 0x20 ||
  (c >= 0x09 && c <= 0x0d) ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;

function unsupported(source: string, what: string): never {
  throw new Error(
    `regexReplay: /${source}/ uses ${what}, which it does not model`,
  );
}

class Parser {
  private i = 0;
  constructor(
    private readonly src: string,
    private readonly dotAll: boolean,
  ) {}

  parse(): Node {
    const node = this.alt();
    if (this.i < this.src.length) unsupported(this.src, "an unbalanced `)`");
    return node;
  }

  private alt(): Node {
    const opts = [this.seq()];
    while (this.src[this.i] === "|") {
      this.i++;
      opts.push(this.seq());
    }
    return opts.length === 1 ? opts[0]! : { t: "alt", opts };
  }

  private seq(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && !"|)".includes(this.src[this.i]!))
      items.push(this.quantified());
    return { t: "seq", items };
  }

  private quantified(): Node {
    const atom = this.atom();
    const c = this.src[this.i];
    let min: number;
    let max: number;
    if (c === "*") [min, max] = [0, Infinity];
    else if (c === "+") [min, max] = [1, Infinity];
    else if (c === "?") [min, max] = [0, 1];
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
      if (!m) unsupported(this.src, "a `{` that is not a quantifier");
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      this.i += m[0].length - 1;
    } else return atom;
    this.i++;
    let greedy = true;
    if (this.src[this.i] === "?") {
      greedy = false;
      this.i++;
    }
    if (atom.t === "bol" || atom.t === "eol" || atom.t === "wordb")
      unsupported(this.src, "a quantified assertion");
    if (max === Infinity && nullable(atom))
      unsupported(this.src, "a loop whose body can match the empty string");
    return { t: "rep", node: atom, min, max, greedy };
  }

  private atom(): Node {
    const c = this.src[this.i++]!;
    switch (c) {
      case "^":
        return { t: "bol" };
      case "$":
        return { t: "eol" };
      case ".":
        return {
          t: "set",
          test: this.dotAll ? () => true : (x) => !isLineTerm(x),
        };
      case "(": {
        if (this.src[this.i] === "?") {
          if (this.src[this.i + 1] !== ":")
            unsupported(this.src, "lookaround or a named group");
          this.i += 2;
        }
        const inner = this.alt();
        if (this.src[this.i] !== ")") unsupported(this.src, "an unclosed `(`");
        this.i++;
        return inner;
      }
      case "[":
        return this.cls();
      case "\\":
        return this.escape(false);
      case "*":
      case "+":
      case "?":
      case "{":
        return unsupported(this.src, "a quantifier with nothing to repeat");
      default: {
        const code = c.charCodeAt(0);
        return { t: "set", test: (x) => x === code };
      }
    }
  }

  /** After a `\`. Inside a class `\b` is a backspace and assertions do not exist. */
  private escape(inClass: boolean): Node {
    const c = this.src[this.i++];
    if (c === undefined) return unsupported(this.src, "a trailing `\\`");
    const one = (code: number): Node => ({ t: "set", test: (x) => x === code });
    switch (c) {
      case "d":
        return { t: "set", test: isDigit };
      case "D":
        return { t: "set", test: (x) => !isDigit(x) };
      case "w":
        return { t: "set", test: isWord };
      case "W":
        return { t: "set", test: (x) => !isWord(x) };
      case "s":
        return { t: "set", test: isSpace };
      case "S":
        return { t: "set", test: (x) => !isSpace(x) };
      case "t":
        return one(0x09);
      case "n":
        return one(0x0a);
      case "r":
        return one(0x0d);
      case "f":
        return one(0x0c);
      case "v":
        return one(0x0b);
      case "0":
        return one(0x00);
      case "b":
        return inClass ? one(0x08) : { t: "wordb", neg: false };
      case "B":
        if (inClass) return unsupported(this.src, "`\\B` in a class");
        return { t: "wordb", neg: true };
      case "x":
      case "u": {
        const n = c === "x" ? 2 : 4;
        const hex = this.src.slice(this.i, this.i + n);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n)
          return unsupported(this.src, `a malformed \\${c} escape`);
        this.i += n;
        return one(parseInt(hex, 16));
      }
      default:
        if (/[1-9k]/.test(c)) return unsupported(this.src, "a backreference");
        if (/[A-Za-z]/.test(c))
          return unsupported(this.src, `the escape \\${c}`);
        return one(c.charCodeAt(0));
    }
  }

  private cls(): Node {
    let negate = false;
    if (this.src[this.i] === "^") {
      negate = true;
      this.i++;
    }
    const parts: Array<(c: number) => boolean> = [];
    // ECMAScript: a `]` straight after `[` closes an empty class (it is not a literal).
    while (this.src[this.i] !== "]") {
      if (this.i >= this.src.length) unsupported(this.src, "an unclosed `[`");
      const lo = this.classAtom();
      if (
        this.src[this.i] === "-" &&
        this.src[this.i + 1] !== "]" &&
        this.i + 1 < this.src.length &&
        lo.code !== null
      ) {
        this.i++;
        const hi = this.classAtom();
        if (hi.code === null) unsupported(this.src, "a class range to a class");
        const [a, b] = [lo.code, hi.code];
        parts.push((x) => x >= a && x <= b);
      } else parts.push(lo.test);
    }
    this.i++;
    const any = (x: number) => parts.some((p) => p(x));
    return { t: "set", test: negate ? (x) => !any(x) : any };
  }

  private classAtom(): { code: number | null; test: (c: number) => boolean } {
    const c = this.src[this.i++]!;
    if (c !== "\\") {
      const code = c.charCodeAt(0);
      return { code, test: (x) => x === code };
    }
    const before = this.i;
    const node = this.escape(true);
    if (node.t !== "set")
      return unsupported(this.src, "an assertion in a class");
    const esc = this.src.slice(before, this.i);
    const single = /^[dDwWsS]$/.test(esc) ? null : codeOfEscape(esc);
    return { code: single, test: node.test };
  }
}

/** The code point a single-character escape body (after `\`) stands for. */
function codeOfEscape(esc: string): number {
  const fixed: Record<string, number> = {
    t: 0x09,
    n: 0x0a,
    r: 0x0d,
    f: 0x0c,
    v: 0x0b,
    "0": 0x00,
    b: 0x08,
  };
  if (esc in fixed) return fixed[esc]!;
  if (esc[0] === "x" || esc[0] === "u") return parseInt(esc.slice(1), 16);
  return esc.charCodeAt(0);
}

function nullable(n: Node): boolean {
  switch (n.t) {
    case "set":
      return false;
    case "seq":
      return n.items.every(nullable);
    case "alt":
      return n.opts.some(nullable);
    case "rep":
      return n.min === 0 || nullable(n.node);
    default:
      return true;
  }
}

function compile(source: string, flags: string): Program {
  if (/[^gmsuyd]/.test(flags)) unsupported(source, `the flags "${flags}"`);
  const ast = new Parser(source, flags.includes("s")).parse();
  const insts: Inst[] = [];
  const emit = (n: Node): void => {
    switch (n.t) {
      case "set":
        insts.push({ op: "set", test: n.test });
        return;
      case "bol":
      case "eol":
        insts.push({ op: n.t });
        return;
      case "wordb":
        insts.push({ op: "wordb", neg: n.neg });
        return;
      case "seq":
        for (const item of n.items) emit(item);
        return;
      case "alt": {
        const ends: number[] = [];
        for (let k = 0; k < n.opts.length; k++) {
          if (k < n.opts.length - 1) {
            const split =
              insts.push({ op: "split", x: insts.length + 1, y: -1 }) - 1;
            emit(n.opts[k]!);
            ends.push(insts.push({ op: "jmp", x: -1 }) - 1);
            (insts[split] as { y: number }).y = insts.length;
          } else emit(n.opts[k]!);
        }
        for (const j of ends) (insts[j] as { x: number }).x = insts.length;
        return;
      }
      case "rep": {
        for (let k = 0; k < n.min; k++) emit(n.node);
        if (n.max === Infinity) {
          const loop = insts.push({ op: "split", x: -1, y: -1 }) - 1;
          emit(n.node);
          insts.push({ op: "jmp", x: loop });
          const body = loop + 1;
          const exit = insts.length;
          insts[loop] = n.greedy
            ? { op: "split", x: body, y: exit }
            : { op: "split", x: exit, y: body };
          return;
        }
        const splits: number[] = [];
        for (let k = n.min; k < n.max; k++) {
          splits.push(insts.push({ op: "split", x: -1, y: -1 }) - 1);
          emit(n.node);
        }
        const exit = insts.length;
        for (const s of splits)
          insts[s] = n.greedy
            ? { op: "split", x: s + 1, y: exit }
            : { op: "split", x: exit, y: s + 1 };
        return;
      }
    }
  };
  emit(ast);
  insts.push({ op: "match" });
  return {
    insts,
    global: flags.includes("g"),
    sticky: flags.includes("y"),
    multiline: flags.includes("m"),
  };
}

/** One `exec`: an anchored attempt at each start position until one matches (only at
 *  `lastIndex` when sticky), as RegExpBuiltinExec does. */
function execRun(
  p: Program,
  input: string,
  lastIndex: number,
): { steps: number; matched: boolean } {
  const from = p.global || p.sticky ? lastIndex : 0;
  if (from > input.length) return { steps: 0, matched: false };
  let steps = 0;
  for (let start = from; start <= input.length; start++) {
    const r = attempt(p, input, start, MAX_STEPS - steps);
    steps += r.steps;
    if (r.matched) return { steps, matched: true };
    if (p.sticky) break;
  }
  return { steps, matched: false };
}

function attempt(
  p: Program,
  input: string,
  start: number,
  budget: number,
): { steps: number; matched: boolean } {
  const { insts, multiline } = p;
  const len = input.length;
  const stack: number[] = [];
  let pc = 0;
  let pos = start;
  let steps = 0;
  for (;;) {
    if (++steps > budget)
      throw new Error(
        `regexReplay: past ${MAX_STEPS} steps; the pattern backtracks super-linearly here`,
      );
    const inst = insts[pc]!;
    let ok = false;
    switch (inst.op) {
      case "set":
        if (pos < len && inst.test(input.charCodeAt(pos))) {
          pos++;
          ok = true;
        }
        break;
      case "split":
        stack.push(inst.y, pos);
        pc = inst.x;
        continue;
      case "jmp":
        pc = inst.x;
        continue;
      case "bol":
        ok = pos === 0 || (multiline && isLineTerm(input.charCodeAt(pos - 1)));
        break;
      case "eol":
        ok = pos === len || (multiline && isLineTerm(input.charCodeAt(pos)));
        break;
      case "wordb": {
        const a = pos > 0 && isWord(input.charCodeAt(pos - 1));
        const b = pos < len && isWord(input.charCodeAt(pos));
        ok = (a !== b) !== inst.neg;
        break;
      }
      case "match":
        return { steps, matched: true };
    }
    if (ok) {
      pc++;
      continue;
    }
    if (stack.length === 0) return { steps, matched: false };
    pos = stack.pop()!;
    pc = stack.pop()!;
  }
}
