// Reference: strict JSON parsing, config resolution and environment values (§2.2.1).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [k: string]: Json };

export interface RemoteEntry {
  state: "default" | "enforced" | "hidden";
  value: Json;
  updatedAt: number;
}

export interface ListEntry {
  key: string;
  value: Json;
  enforced: boolean;
}

/** Rule 2's limits, restated as literals (they are not generated constants). */
const REF_MAX_DEPTH = 64;
const REF_MAX_DECIMAL_EXPONENT = 307;
const REF_MAX_EXPONENT_DIGITS = 6;

const refOwn = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/** Rule 2's number range, judged from the token's digits (the reference's own copy). */
export function refNumberInRange(token: string): boolean {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/.exec(token);
  if (!m) throw new Error(`refNumberInRange: not a number token: ${token}`);
  const int = m[1]!;
  const frac = m[2] ?? "";
  const expDigits = (m[4] ?? "0").replace(/^0+/, "");
  if (expDigits.length > REF_MAX_EXPONENT_DIGITS) return false;
  const exp = (m[3] === "-" ? -1 : 1) * Number(expDigits || "0");
  const digits = int + frac;
  const first = digits.search(/[1-9]/);
  if (first === -1) return true;
  const power = int.length - 1 - first + exp;
  return (
    power >= -REF_MAX_DECIMAL_EXPONENT && power <= REF_MAX_DECIMAL_EXPONENT
  );
}

class RefRefused extends Error {}

/**
 * A small recursive-descent parser of rule 2's strict JSON. It refuses a 65th level before
 * descending into it, compares member names as JS strings (scalar comparison once lone
 * surrogates are refused) and never normalizes them, refuses a member name holding U+0000,
 * accepts noncharacters, and judges each number token from its digits before reading it with
 * `Number`.
 */
export function refParseStrict(
  text: string,
): { ok: true; value: Json } | { ok: false } {
  let i = 0;
  const refuse = (): never => {
    throw new RefRefused();
  };
  const ws = (): void => {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  };
  const str = (): string => {
    if (text[i] !== '"') refuse();
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) refuse();
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        break;
      }
      if (c < 0x20) refuse();
      if (c === 0x5c) {
        const e = text[i + 1];
        i += 2;
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (e !== undefined && refOwn(simple, e)) out += simple[e];
        else if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) refuse();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else refuse();
        continue;
      }
      out += text[i];
      i++;
    }
    // No lone surrogate, escaped or raw.
    for (let k = 0; k < out.length; k++) {
      const u = out.charCodeAt(k);
      if (u >= 0xd800 && u <= 0xdbff) {
        const n = out.charCodeAt(k + 1);
        if (n >= 0xdc00 && n <= 0xdfff) {
          k++;
          continue;
        }
        refuse();
      } else if (u >= 0xdc00 && u <= 0xdfff) refuse();
    }
    return out;
  };
  const num = (): number => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(i),
    );
    if (!m) refuse();
    const token = m![0];
    i += token.length;
    if (!refNumberInRange(token)) refuse();
    return Number(token);
  };
  const value = (depth: number): Json => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      if (depth + 1 > REF_MAX_DEPTH) refuse();
      i++;
      if (c === "[") {
        const arr: Json[] = [];
        ws();
        if (text[i] === "]") {
          i++;
          return arr;
        }
        for (;;) {
          arr.push(value(depth + 1));
          ws();
          if (text[i] === ",") {
            i++;
            continue;
          }
          if (text[i] === "]") {
            i++;
            return arr;
          }
          refuse();
        }
      }
      const obj: { [k: string]: Json } = {};
      const names = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const name = str();
        if (name.indexOf("\u0000") !== -1) refuse();
        if (names.has(name)) refuse();
        names.add(name);
        ws();
        if (text[i] !== ":") refuse();
        i++;
        Object.defineProperty(obj, name, {
          value: value(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        refuse();
      }
    }
    if (c === '"') return str();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return num();
    for (const [lit, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return v;
      }
    }
    return refuse();
  };
  try {
    const v = value(0);
    ws();
    if (i !== text.length) return { ok: false };
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof RefRefused) return { ok: false };
    throw e;
  }
}

/** Rule 2: the parsed value, or the raw string unchanged. */
function refEnvValue(raw: string): Json {
  const parsed = refParseStrict(raw);
  return parsed.ok ? parsed.value : raw;
}

export interface RefContext {
  remote: Record<string, RemoteEntry> | null;
  localOverrides: Record<string, Json>;
  env: Record<string, string>;
  envPrefix: string;
}

export function refResolve(
  ctx: RefContext,
  key: string,
  fallback: Json,
  withEnv: boolean,
): { value: Json; source: string } {
  const entry =
    ctx.remote !== null && refOwn(ctx.remote, key) ? ctx.remote[key]! : null;
  if (entry && entry.state === "enforced")
    return { value: entry.value, source: "enforced" };
  if (entry && entry.state === "hidden")
    return { value: entry.value, source: "hidden" };
  if (refOwn(ctx.localOverrides, key))
    return { value: ctx.localOverrides[key]!, source: "local" };
  const name = ctx.envPrefix + key.split(".").join("__");
  if (withEnv && refOwn(ctx.env, name))
    return { value: refEnvValue(ctx.env[name]!), source: "env" };
  if (entry) return { value: entry.value, source: "remote-default" };
  return { value: fallback, source: "fallback" };
}

export function refList(ctx: RefContext, withEnv: boolean): ListEntry[] {
  const out: ListEntry[] = [];
  for (const key of Object.keys(ctx.remote ?? {})) {
    const entry = ctx.remote![key]!;
    if (entry.state === "hidden") continue;
    out.push({
      key,
      value: refResolve(ctx, key, null, withEnv).value,
      enforced: entry.state === "enforced",
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Canonical JSON equality (notes/A7 §5): keys unordered, arrays ordered, numbers by value (an
 *  integral float equals its integer, and -0 equals 0). */
export function canonicalEqual(a: Json, b: Json): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as Json[];
    return (
      a.length === bb.length && a.every((x, k) => canonicalEqual(x, bb[k]!))
    );
  }
  const ao = a as { [k: string]: Json };
  const bo = b as { [k: string]: Json };
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  return (
    ak.length === bk.length &&
    ak.every((k) => refOwn(bo, k) && canonicalEqual(ao[k]!, bo[k]!))
  );
}
