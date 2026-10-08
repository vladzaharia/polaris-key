// `config-matrix.json`: config resolution and environment values (§2.2.1).

import {
  canonicalEqual,
  type Json,
  type ListEntry,
  type RefContext,
  refList,
  refParseStrict,
  refResolve,
  type RemoteEntry,
} from "./reference/config.js";

// ── Config resolution (config-matrix.json) ───────────────────────────────────
// WIRE-CONTRACT-V3 §2.2.1: the precedence, the variable name (rule 1), the strict environment
// value (rule 2), the host without an environment (rule 3, `expectNoEnv`) and the user-visible
// list (rule 4). Every expectation is checked against the generator-local reference in
// `reference/config.ts`, which imports nothing from client-core or shared-jws for the reason the
// fingerprint section gives: a golden corpus that shares code with the implementation it checks
// cannot catch a bug in it.

interface ResolveCase {
  id: string;
  description: string;
  remote: Record<string, RemoteEntry> | null;
  localOverrides: Record<string, Json>;
  env: Record<string, string>;
  envPrefix: string;
  key: string;
  fallback: Json;
  expect: { value: Json; source: string };
  expectNoEnv?: { value: Json; source: string };
}

interface EnvValueCase {
  id: string;
  description: string;
  raw: string;
  value?: Json;
  anyNumber?: true;
}

interface ListCase {
  id: string;
  description: string;
  remote: Record<string, RemoteEntry> | null;
  localOverrides: Record<string, Json>;
  env: Record<string, string>;
  envPrefix: string;
  expect: ListEntry[];
  expectNoEnv?: ListEntry[];
}
const CM_PREFIX = "PKEY_CONFIG_";

/** Unicode noncharacters: U+FDD0..U+FDEF and U+xxFFFE/U+xxFFFF in every plane. */
function isNoncharacter(cp: number): boolean {
  return (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe;
}

const entry = (state: RemoteEntry["state"], value: Json): RemoteEntry => ({
  state,
  value,
  updatedAt: 1,
});
const DARK = { "ui.theme": entry("default", "dark") };
const BLUE = { [`${CM_PREFIX}ui__theme`]: '"blue"' };

/** A resolve row: `ui.theme` with a `default` entry `"dark"`, unless the row says otherwise. The
 *  expectations are computed by the reference and then compared against the literal ones. */
function resolveRow(
  id: string,
  description: string,
  setup: Partial<
    Omit<ResolveCase, "id" | "description" | "expect" | "expectNoEnv">
  >,
  expect: [Json, string],
  expectNoEnv?: [Json, string],
): ResolveCase {
  const row: ResolveCase = {
    id,
    description,
    remote: setup.remote === undefined ? DARK : setup.remote,
    localOverrides: setup.localOverrides ?? {},
    env: setup.env ?? {},
    envPrefix: setup.envPrefix ?? CM_PREFIX,
    key: setup.key ?? "ui.theme",
    fallback: setup.fallback === undefined ? "system" : setup.fallback,
    expect: { value: expect[0], source: expect[1] },
  };
  if (expectNoEnv)
    row.expectNoEnv = { value: expectNoEnv[0], source: expectNoEnv[1] };
  return row;
}

function resolveCases(): ResolveCase[] {
  const overrides = { localOverrides: { "ui.theme": "light" }, env: BLUE };
  return [
    resolveRow(
      "enforced-beats-local-and-env",
      "An enforced entry is locked: the local override and the environment are ignored.",
      { remote: { "ui.theme": entry("enforced", "dark") }, ...overrides },
      ["dark", "enforced"],
    ),
    resolveRow(
      "hidden-beats-local-and-env",
      "A hidden entry is locked too, and reports hidden.",
      { remote: { "ui.theme": entry("hidden", "s3cr3t") }, ...overrides },
      ["s3cr3t", "hidden"],
    ),
    resolveRow(
      "local-beats-env",
      "Over a default entry, a local override beats the environment.",
      overrides,
      ["light", "local"],
    ),
    resolveRow(
      "env-beats-remote-default",
      "The environment beats the remote default; a host without an environment sees the default.",
      { env: BLUE },
      ["blue", "env"],
      ["dark", "remote-default"],
    ),
    resolveRow(
      "remote-default-beats-fallback",
      "With no override, the remote default answers.",
      {},
      ["dark", "remote-default"],
    ),
    resolveRow(
      "fallback-empty-document",
      "A document without the key: the caller's fallback.",
      { remote: {} },
      ["system", "fallback"],
    ),
    resolveRow(
      "fallback-no-document",
      "No document yet (remote null): the caller's fallback.",
      { remote: null },
      ["system", "fallback"],
    ),
    resolveRow(
      "env-key-absent-from-document",
      "The environment answers for a key the document lacks.",
      { remote: { "other.key": entry("default", 1) }, env: BLUE },
      ["blue", "env"],
      ["system", "fallback"],
    ),
    resolveRow(
      "env-no-document",
      "The environment answers before the first document.",
      { remote: null, env: BLUE },
      ["blue", "env"],
      ["system", "fallback"],
    ),
    resolveRow(
      "local-no-document",
      "A local override answers before the first document.",
      { remote: null, localOverrides: { "ui.theme": "light" } },
      ["light", "local"],
    ),
    resolveRow(
      "local-null-is-a-value",
      "A local override holding JSON null answers null; only fallback means no layer answered.",
      { localOverrides: { "ui.theme": null } },
      [null, "local"],
    ),
    resolveRow(
      "env-null-is-a-value",
      "An environment value of null parses to JSON null, which answers.",
      { env: { [`${CM_PREFIX}ui__theme`]: "null" } },
      [null, "env"],
      ["dark", "remote-default"],
    ),
    resolveRow(
      "remote-default-null-is-a-value",
      "A default entry holding null answers null.",
      { remote: { "ui.theme": entry("default", null) } },
      [null, "remote-default"],
    ),
    resolveRow(
      "enforced-null-is-locked",
      "An enforced entry holding null is still locked.",
      {
        remote: { "ui.theme": entry("enforced", null) },
        localOverrides: { "ui.theme": "light" },
      },
      [null, "enforced"],
    ),
    resolveRow(
      "env-empty-string-is-a-value",
      "A variable that is set counts even when it is empty; its value is the raw empty string.",
      { env: { [`${CM_PREFIX}ui__theme`]: "" } },
      ["", "env"],
      ["dark", "remote-default"],
    ),
    resolveRow(
      "env-name-dots-to-double-underscores",
      "Rule 1: every dot in the key becomes a double underscore.",
      {
        key: "run.concurrency",
        remote: { "run.concurrency": entry("default", 4) },
        env: { [`${CM_PREFIX}run__concurrency`]: "8" },
      },
      [8, "env"],
      [4, "remote-default"],
    ),
    resolveRow(
      "env-name-dotted-form-not-read",
      "The SDK looks up exactly the built name, never the dotted form.",
      {
        key: "run.concurrency",
        remote: { "run.concurrency": entry("default", 4) },
        env: { [`${CM_PREFIX}run.concurrency`]: "8" },
      },
      [4, "remote-default"],
    ),
    resolveRow(
      "env-name-case-sensitive",
      "Nothing but the dots changes, case included.",
      { env: { [`${CM_PREFIX}UI__THEME`]: '"blue"' } },
      ["dark", "remote-default"],
    ),
    resolveRow(
      "env-name-keeps-other-characters",
      "Underscores and hyphens in the key are kept as they are.",
      {
        key: "net_proxy.max-retries",
        remote: { "net_proxy.max-retries": entry("default", 5) },
        env: { [`${CM_PREFIX}net_proxy__max-retries`]: "3" },
      },
      [3, "env"],
      [5, "remote-default"],
    ),
    resolveRow(
      "env-name-custom-prefix",
      "The host's prefix replaces PKEY_CONFIG_, which is then not read.",
      {
        envPrefix: "MYAPP_",
        env: {
          MYAPP_ui__theme: '"blue"',
          [`${CM_PREFIX}ui__theme`]: '"red"',
        },
      },
      ["blue", "env"],
      ["dark", "remote-default"],
    ),
    resolveRow(
      "env-name-withdrawn-prefix-not-read",
      "The withdrawn PLRS_CONFIG_ prefix (Amendment A1) is not read.",
      { env: { PLRS_CONFIG_ui__theme: '"blue"' } },
      ["dark", "remote-default"],
    ),
    resolveRow(
      "prototype-key-absent",
      "A key named like a language built-in is an ordinary key: absent from the document, it falls back.",
      { key: "constructor", remote: {} },
      ["system", "fallback"],
    ),
    resolveRow(
      "prototype-key-in-document",
      "A key named like a language built-in resolves from the document like any other.",
      { key: "toString", remote: { toString: entry("default", "dark") } },
      ["dark", "remote-default"],
    ),
    resolveRow(
      "prototype-key-empty-prefix",
      "With an empty prefix the variable name is the key itself; an empty environment does not hold it.",
      { key: "valueOf", envPrefix: "", remote: null, env: {} },
      ["system", "fallback"],
    ),
  ];
}

const RAW = Symbol("raw");
const ANY = Symbol("anyNumber");

/** `[id, description, raw, value]`: `RAW` expects the raw string back, `ANY` pins only the
 *  verdict (a finite number in the SDK's own type). */
const ENV_VALUE_ROWS: [
  string,
  string,
  string,
  Json | typeof RAW | typeof ANY,
][] = [
  // Parse.
  ["env-value-true", "A JSON literal.", "true", true],
  ["env-value-false", "A JSON literal.", "false", false],
  ["env-value-null", "A JSON literal.", "null", null],
  ["env-value-integer", "An integer.", "42", 42],
  ["env-value-negative-integer", "A negative integer.", "-7", -7],
  ["env-value-zero", "Zero.", "0", 0],
  ["env-value-decimal", "A decimal.", "1.5", 1.5],
  [
    "env-value-decimal-trailing-zero",
    "A decimal with a trailing zero.",
    "2.50",
    2.5,
  ],
  ["env-value-exponent", "An exponent.", "1e3", 1000],
  [
    "env-value-exponent-upper-negative",
    "An upper-case negative exponent.",
    "1E-2",
    0.01,
  ],
  [
    "env-value-fraction-and-exponent",
    "A fraction with an exponent.",
    "0.1e1",
    1,
  ],
  [
    "env-value-negative-zero",
    "Negative zero, which compares equal to 0.",
    "-0",
    0,
  ],
  ["env-value-negative-zero-decimal", "Negative zero as a decimal.", "-0.0", 0],
  [
    "env-value-max-safe-integer",
    "2^53 - 1.",
    "9007199254740991",
    9007199254740991,
  ],
  ["env-value-string", "A quoted string.", '"hello"', "hello"],
  ["env-value-quoted-empty-string", "The quoted empty string.", '""', ""],
  [
    "env-value-string-escapes",
    "A string written with escapes.",
    '"caf\\u00e9 \\u65e5\\n"',
    "caf\u00e9 \u65e5\n",
  ],
  ["env-value-empty-array", "An empty array.", "[]", []],
  ["env-value-empty-object", "An empty object.", "{}", {}],
  [
    "env-value-mixed-array",
    "An array of every JSON type.",
    '["a",1,true,null,{"b":[2.5]}]',
    ["a", 1, true, null, { b: [2.5] }],
  ],
  [
    "env-value-nested-object",
    "Nested objects and arrays.",
    '{"a":{"b":[1,{"c":null}]}}',
    { a: { b: [1, { c: null }] } },
  ],
  [
    "env-value-surrounding-spaces",
    "JSON whitespace around the value.",
    " 42 ",
    42,
  ],
  [
    "env-value-surrounding-json-whitespace",
    "Tab, CR and LF around the value.",
    '\t{"a":1}\r\n',
    { a: 1 },
  ],
  [
    "env-value-noncharacters",
    "Noncharacters are ordinary characters (rule 2), escaped or raw: U+FFFF, U+FDD0, U+1FFFE, then a raw U+FFFF.",
    '["\\uffff","\\ufdd0","\\ud83f\\udffe","\uffff"]',
    ["\uffff", "\ufdd0", "\u{1fffe}", "\uffff"],
  ],
  // Raw: not JSON.
  ["env-value-bare-word", "A bare word.", "dark", RAW],
  ["env-value-python-true", "Python's True is not JSON.", "True", RAW],
  ["env-value-leading-zero", "A leading zero.", "01", RAW],
  ["env-value-trailing-dot", "A trailing decimal point.", "1.", RAW],
  ["env-value-leading-dot", "A leading decimal point.", ".5", RAW],
  ["env-value-plus-sign", "A leading plus sign.", "+1", RAW],
  ["env-value-hex", "A hexadecimal literal.", "0x10", RAW],
  ["env-value-digit-separator", "A digit separator.", "1_000", RAW],
  ["env-value-unclosed-object", "An unclosed object.", "{", RAW],
  ["env-value-unclosed-array", "An unclosed array.", "[1,2", RAW],
  [
    "env-value-unterminated-string",
    "An unterminated string.",
    '"unterminated',
    RAW,
  ],
  ["env-value-trailing-garbage", "Text after the value.", '{"a":1}x', RAW],
  ["env-value-two-texts", "Two JSON texts.", "[1] [2]", RAW],
  ["env-value-empty", "The empty string is not a JSON text.", "", RAW],
  ["env-value-whitespace-only", "Whitespace only.", "   ", RAW],
  [
    "env-value-nbsp-before-number",
    "U+00A0 is not JSON whitespace.",
    "\u00a042",
    RAW,
  ],
  [
    "env-value-bom-before-object",
    "A leading byte order mark is not skipped.",
    "\ufeff{}",
    RAW,
  ],
  [
    "env-value-bom-before-number",
    "A leading byte order mark is not skipped.",
    "\ufeff42",
    RAW,
  ],
  [
    "env-value-form-feed-before-array",
    "U+000C is not JSON whitespace.",
    "\u000c[1]",
    RAW,
  ],
  ["env-value-single-quotes", "Single quotes.", "'single'", RAW],
  ["env-value-unquoted-name", "An unquoted member name.", "{a:1}", RAW],
  // Raw, where the SDKs disagreed before §2.2.1.
  [
    "env-value-trailing-comma-array",
    "A trailing comma in an array.",
    "[1,2,]",
    RAW,
  ],
  [
    "env-value-trailing-comma-object",
    "A trailing comma in an object.",
    '{"a":1,}',
    RAW,
  ],
  [
    "env-value-duplicate-name",
    "Two members of the same name.",
    '{"a":1,"a":2}',
    RAW,
  ],
  [
    "env-value-duplicate-name-escaped",
    'Names compare after unescaping: "a" and "\\u0061" are one name.',
    '{"a":1,"\\u0061":2}',
    RAW,
  ],
  [
    "env-value-duplicate-name-nested",
    "A duplicate at any depth.",
    '{"a":{"b":1,"b":2}}',
    RAW,
  ],
  ["env-value-nan", "NaN is not JSON.", "NaN", RAW],
  ["env-value-infinity", "Infinity is not JSON.", "Infinity", RAW],
  ["env-value-negative-infinity", "-Infinity is not JSON.", "-Infinity", RAW],
  ["env-value-nan-in-array", "NaN inside an array.", "[NaN]", RAW],
  ["env-value-number-overflow", "A number beyond binary64.", "1e400", RAW],
  [
    "env-value-number-negative-overflow",
    "A negative number beyond binary64.",
    "-1e400",
    RAW,
  ],
  [
    "env-value-number-overflow-in-array",
    "An overflowing number inside an array.",
    "[1e400]",
    RAW,
  ],
  [
    "env-value-integer-310-digits",
    "1 followed by 309 zeros: E = 309.",
    "1" + "0".repeat(309),
    RAW,
  ],
  [
    "env-value-lone-high-surrogate",
    "An escaped lone high surrogate.",
    '"\\ud800"',
    RAW,
  ],
  [
    "env-value-lone-low-surrogate-in-array",
    "An escaped lone low surrogate inside an array.",
    '["\\udc00x"]',
    RAW,
  ],
  [
    "env-value-lone-surrogate-name",
    "An escaped lone surrogate in a member name.",
    '{"\\ud800":1}',
    RAW,
  ],
  // Rule 2's number range. E is the power of ten of the first non-zero digit.
  ["env-value-number-e308", "E = 308.", "1e308", RAW],
  [
    "env-value-number-largest-double",
    "The largest double, E = 308: raw however a parser would round it.",
    "1.7976931348623158e308",
    RAW,
  ],
  [
    "env-value-number-309-digits",
    "A 309-digit integer, E = 308.",
    "17976931348623157" + "0".repeat(292),
    RAW,
  ],
  ["env-value-number-e-308", "E = -308.", "1e-308", RAW],
  ["env-value-number-subnormal", "A subnormal, E = -324.", "5e-324", RAW],
  ["env-value-number-underflow", "E = -400.", "1e-400", RAW],
  [
    "env-value-number-zero-seven-digit-exponent",
    "Zero with seven significant exponent digits.",
    "0e1000000",
    RAW,
  ],
  [
    "env-value-number-exponent-past-32-bits",
    "Ten exponent digits, past 2^32.",
    "1e4294967297",
    RAW,
  ],
  [
    "env-value-number-edge-high",
    "E = 307: in range. Only the verdict is pinned (WIRE-CONTRACT-V3 §10).",
    "9.99e307",
    ANY,
  ],
  [
    "env-value-number-edge-low",
    "E = -307: in range. Only the verdict is pinned (WIRE-CONTRACT-V3 §10).",
    "1e-307",
    ANY,
  ],
  [
    "env-value-number-exponent-leading-zeros",
    "An exponent with leading zeros has one significant digit.",
    "1e0000001",
    10,
  ],
  [
    "env-value-number-zero-with-exponent",
    "Zero with an exponent is in range.",
    "0e5",
    0,
  ],
  // Member names.
  [
    "env-value-canonically-equivalent-names",
    "Names compare by scalar value and are never normalized: U+00E9 and U+0065 U+0301 are two names. Their values are equal, so Swift's merge (WIRE-CONTRACT-V3 §10) cannot change the comparison.",
    '{"\\u00e9":1,"e\\u0301":1}',
    { "\u00e9": 1, "e\u0301": 1 },
  ],
  [
    "env-value-name-holds-nul",
    "A member name holding U+0000 keeps the raw string.",
    '{"a\\u0000":1}',
    RAW,
  ],
  [
    "env-value-name-escaped-backslash-u0000",
    "An escaped backslash before u0000: the name holds no U+0000.",
    '{"a\\\\u0000":1}',
    { "a\\u0000": 1 },
  ],
  // Depth.
  [
    "env-value-depth-64-arrays",
    "64 nested arrays parse.",
    "[".repeat(64) + "]".repeat(64),
    nestedArrays(64),
  ],
  [
    "env-value-depth-65-arrays",
    "65 nested arrays stay raw.",
    "[".repeat(65) + "]".repeat(65),
    RAW,
  ],
  [
    "env-value-depth-65-objects",
    "64 nested objects around [1], 65 levels, stay raw.",
    '{"a":'.repeat(64) + "[1]" + "}".repeat(64),
    RAW,
  ],
  [
    "env-value-depth-brackets-in-string",
    "Brackets inside a string do not count, even after an escaped quote.",
    '["\\"' + "[".repeat(65) + '"]',
    ['"' + "[".repeat(65)],
  ],
  [
    "env-value-depth-after-escaped-backslash",
    "The string ends after an escaped backslash, so 64 nested arrays follow it: 65 levels stay raw.",
    '["\\\\",' + "[".repeat(64) + "]".repeat(64) + "]",
    RAW,
  ],
  [
    "env-value-depth-10000",
    "10,000 nested arrays stay raw, and no runner may throw on them.",
    "[".repeat(10000) + "]".repeat(10000),
    RAW,
  ],
];

function nestedArrays(depth: number): Json {
  let v: Json = [];
  for (let k = 1; k < depth; k++) v = [v];
  return v;
}

function envValueCases(): EnvValueCase[] {
  return ENV_VALUE_ROWS.map(([id, description, raw, value]) => {
    if (value === ANY) return { id, description, raw, anyNumber: true };
    return { id, description, raw, value: value === RAW ? raw : value };
  });
}

/** An `envValueCase` as the resolve case it expands to (the file's description says the same). */
function expandEnvValueCase(c: EnvValueCase): RefContext & {
  key: string;
  fallback: Json;
} {
  return {
    remote: null,
    localOverrides: {},
    env: { [`${CM_PREFIX}value`]: c.raw },
    envPrefix: CM_PREFIX,
    key: "value",
    fallback: "(fallback)",
  };
}

function listRow(
  id: string,
  description: string,
  setup: Partial<RefContext>,
  expect: ListEntry[],
  expectNoEnv?: ListEntry[],
): ListCase {
  const row: ListCase = {
    id,
    description,
    remote: setup.remote === undefined ? {} : setup.remote,
    localOverrides: setup.localOverrides ?? {},
    env: setup.env ?? {},
    envPrefix: setup.envPrefix ?? CM_PREFIX,
    expect,
  };
  if (expectNoEnv) row.expectNoEnv = expectNoEnv;
  return row;
}

const le = (key: string, value: Json, enforced = false): ListEntry => ({
  key,
  value,
  enforced,
});

function listCases(): ListCase[] {
  return [
    listRow(
      "list-states-and-layers",
      "Hidden entries are not listed, enforced ones are flagged, and each entry carries its resolved value.",
      {
        remote: {
          a: entry("default", 1),
          b: entry("enforced", 2),
          c: entry("hidden", 3),
          d: entry("default", "x"),
        },
        localOverrides: { b: 99, d: "y" },
        env: { [`${CM_PREFIX}a`]: "5" },
      },
      [le("a", 5), le("b", 2, true), le("d", "y")],
      [le("a", 1), le("b", 2, true), le("d", "y")],
    ),
    listRow(
      "list-omits-local-only-keys",
      "A key only a local override supplies is not listed.",
      { remote: { a: entry("default", 1) }, localOverrides: { z: "local" } },
      [le("a", 1)],
    ),
    listRow(
      "list-omits-env-only-keys",
      "A key only the environment supplies is not listed.",
      { remote: { a: entry("default", 1) }, env: { [`${CM_PREFIX}z`]: "1" } },
      [le("a", 1)],
    ),
    listRow(
      "list-no-document",
      "No document yet: nothing is listed, whatever the overrides.",
      { remote: null, localOverrides: { a: 1 } },
      [],
    ),
    listRow(
      "list-empty-document",
      "An empty document lists nothing.",
      { remote: {} },
      [],
    ),
    listRow(
      "list-only-hidden",
      "A document of hidden entries lists nothing.",
      { remote: { h: entry("hidden", "x") } },
      [],
    ),
    listRow(
      "list-null-value",
      "An entry holding null is listed with null.",
      { remote: { n: entry("default", null) } },
      [le("n", null)],
    ),
    listRow(
      "list-prototype-named-entries",
      "Entries named like language built-ins are ordinary entries.",
      {
        remote: {
          constructor: entry("default", 1),
          toString: entry("enforced", 2),
          valueOf: entry("hidden", 3),
        },
      },
      [le("constructor", 1), le("toString", 2, true)],
    ),
  ];
}

/** E for a single number token: the power of ten of its first non-zero digit (null for zero). */
function decimalPower(token: string): number | null {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!m) return null;
  const digits = m[1]! + (m[2] ?? "");
  const first = digits.search(/[1-9]/);
  if (first === -1) return null;
  return m[1]!.length - 1 - first + Number(m[3] ?? "0");
}

/** The parts of a number token that decide whether every SDK reads it as the same double. */
function numberForm(token: string): {
  digits: string;
  fracDigits: number;
  exp: number;
  expDigits: string;
} {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/.exec(token);
  if (!m) throw new Error(`not a number token: ${token}`);
  const expDigits = (m[4] ?? "0").replace(/^0+/, "") || "0";
  return {
    digits: m[1]! + (m[2] ?? ""),
    fracDigits: (m[2] ?? "").length,
    exp: (m[3] === "-" ? -1 : 1) * Number(expDigits.slice(0, 15)),
    expDigits,
  };
}

/** True when every SDK, Godot included, reads the token as the nearest double: at most 18 digits
 *  before the exponent part (leading zeros included), those digits an integer of at most 2^53,
 *  and the exponent minus the fraction digits within ±22 (WIRE-CONTRACT-V3 §10). */
function exactlyReadEverywhere(token: string): boolean {
  const f = numberForm(token);
  if (f.digits.length > 18) return false;
  if (BigInt(f.digits) > 2n ** 53n) return false;
  const scale = f.exp - f.fracDigits;
  return scale >= -22 && scale <= 22;
}

/** Number tokens outside strings, in a text JSON accepts. */
function numberTokens(text: string): string[] {
  const out: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (m) {
        out.push(m[0]);
        i += m[0].length - 1;
      }
    }
  }
  return out;
}

function checkConfigMatrix(
  resolve: ResolveCase[],
  envValues: EnvValueCase[],
  list: ListCase[],
  file: unknown,
): void {
  const fail = (section: string, id: string, why: string): never => {
    throw new Error(
      `corpus self-check failed: config-matrix/${section}/${id}: ${why}`,
    );
  };
  const ids = new Set<string>();
  const usedSources = new Set<string>();
  const usedTypes = new Set<string>();
  const usedEnforced = new Set<boolean>();
  const typeOf = (v: Json): string =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const envNamesAscii = (
    section: string,
    id: string,
    env: Record<string, string>,
  ) => {
    for (const name of Object.keys(env))
      if (!/^[\x20-\x7e]*$/.test(name))
        fail(section, id, `variable name ${JSON.stringify(name)} is not ASCII`);
  };

  for (const c of resolve) {
    if (ids.has(c.id)) fail("resolveCases", c.id, "duplicate id");
    ids.add(c.id);
    envNamesAscii("resolveCases", c.id, c.env);
    const withEnv = refResolve(c, c.key, c.fallback, true);
    const noEnv = refResolve(c, c.key, c.fallback, false);
    if (
      withEnv.source !== c.expect.source ||
      !canonicalEqual(withEnv.value, c.expect.value)
    )
      fail(
        "resolveCases",
        c.id,
        `the reference answers ${JSON.stringify(withEnv)}`,
      );
    const differs =
      noEnv.source !== withEnv.source ||
      !canonicalEqual(noEnv.value, withEnv.value);
    if (differs !== (c.expectNoEnv !== undefined))
      fail(
        "resolveCases",
        c.id,
        differs ? "expectNoEnv is missing" : "expectNoEnv equals expect",
      );
    if (
      c.expectNoEnv &&
      (noEnv.source !== c.expectNoEnv.source ||
        !canonicalEqual(noEnv.value, c.expectNoEnv.value))
    )
      fail(
        "resolveCases",
        c.id,
        `the reference answers ${JSON.stringify(noEnv)} without an environment`,
      );
    for (const e of [c.expect, c.expectNoEnv]) {
      if (!e) continue;
      usedSources.add(e.source);
      usedTypes.add(typeOf(e.value));
    }
  }

  let equivalentPair = false;
  for (const c of envValues) {
    if (ids.has(c.id)) fail("envValueCases", c.id, "duplicate id");
    ids.add(c.id);
    const ctx = expandEnvValueCase(c);
    const got = refResolve(ctx, ctx.key, ctx.fallback, true);
    if (got.source !== "env")
      fail("envValueCases", c.id, `source ${got.source}`);
    const noEnv = refResolve(ctx, ctx.key, ctx.fallback, false);
    if (noEnv.source !== "fallback" || noEnv.value !== "(fallback)")
      fail(
        "envValueCases",
        c.id,
        "the no-environment expansion does not fall back",
      );
    usedSources.add("env");
    if (c.anyNumber) {
      if (
        typeof got.value !== "number" ||
        !Number.isFinite(got.value) ||
        got.value === 0
      )
        fail(
          "envValueCases",
          c.id,
          "anyNumber, but the reference does not read a non-zero finite number",
        );
      const tokens = numberTokens(c.raw);
      if (tokens.length !== 1 || tokens[0] !== c.raw.trim())
        fail("envValueCases", c.id, "an anyNumber row must be a single number");
      const f = numberForm(tokens[0]!);
      const scale = f.exp - f.fracDigits;
      if (f.digits.length > 18 || scale < -308 || scale > 308)
        fail(
          "envValueCases",
          c.id,
          "an anyNumber row must have at most 18 digits and a scale within ±308",
        );
      usedTypes.add("number");
      continue;
    }
    if (!canonicalEqual(got.value, c.value!))
      fail(
        "envValueCases",
        c.id,
        `the reference answers ${JSON.stringify(got.value)}`,
      );
    usedTypes.add(typeOf(c.value!));
    const keepsRaw =
      typeof c.value === "string" &&
      c.value === c.raw &&
      !refParseStrict(c.raw).ok;
    if (!keepsRaw)
      for (const token of numberTokens(c.raw))
        if (!exactlyReadEverywhere(token))
          fail(
            "envValueCases",
            c.id,
            `the compared number ${token} is outside the forms every SDK reads alike`,
          );
    if (hasEquivalentPair(c.value!)) equivalentPair = true;
  }
  if (!equivalentPair)
    fail(
      "envValueCases",
      "*",
      "no row holds two canonically equivalent member names",
    );

  for (const c of list) {
    if (ids.has(c.id)) fail("listCases", c.id, "duplicate id");
    ids.add(c.id);
    envNamesAscii("listCases", c.id, c.env);
    const sorted = [...c.expect].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    if (sorted.some((e, k) => e !== c.expect[k]))
      fail("listCases", c.id, "expect is not sorted by key");
    const withEnv = refList(c, true);
    const noEnv = refList(c, false);
    const same = (a: ListEntry[], b: ListEntry[]): boolean =>
      a.length === b.length &&
      a.every(
        (e, k) =>
          e.key === b[k]!.key &&
          e.enforced === b[k]!.enforced &&
          canonicalEqual(e.value, b[k]!.value),
      );
    if (!same(withEnv, c.expect))
      fail("listCases", c.id, `the reference lists ${JSON.stringify(withEnv)}`);
    const differs = !same(withEnv, noEnv);
    if (differs !== (c.expectNoEnv !== undefined))
      fail(
        "listCases",
        c.id,
        differs ? "expectNoEnv is missing" : "expectNoEnv equals expect",
      );
    if (c.expectNoEnv && !same(noEnv, c.expectNoEnv))
      fail(
        "listCases",
        c.id,
        `the reference lists ${JSON.stringify(noEnv)} without an environment`,
      );
    for (const e of [...c.expect, ...(c.expectNoEnv ?? [])]) {
      usedEnforced.add(e.enforced);
      usedTypes.add(typeOf(e.value));
    }
  }

  for (const s of [
    "enforced",
    "hidden",
    "local",
    "env",
    "remote-default",
    "fallback",
  ])
    if (!usedSources.has(s)) fail("*", s, "no row expects this source");
  for (const t of ["null", "boolean", "number", "string", "array", "object"])
    if (!usedTypes.has(t))
      fail("*", t, "no row expects a value of this JSON type");
  for (const b of [true, false])
    if (!usedEnforced.has(b))
      fail("*", String(b), "no list row expects this enforced value");

  // Rule 2's character rules are each pinned.
  const keepsRawRow = (c: EnvValueCase): boolean =>
    c.value === c.raw && !refParseStrict(c.raw).ok;
  const parseRow = (c: EnvValueCase): boolean =>
    !c.anyNumber && !keepsRawRow(c);
  const namesOf = (v: Json): string[] => {
    if (v === null || typeof v !== "object") return [];
    if (Array.isArray(v)) return v.flatMap(namesOf);
    return Object.keys(v).flatMap((k) => [k, ...namesOf(v[k]!)]);
  };
  // JS's own parser is lenient about U+0000 in names, which is what this lookup needs.
  const lenient = (raw: string): Json | undefined => {
    try {
      return JSON.parse(raw) as Json;
    } catch {
      return undefined;
    }
  };
  if (
    !envValues.some(
      (c) =>
        keepsRawRow(c) &&
        namesOf(lenient(c.raw) ?? null).some((n) => n.includes("\u0000")),
    )
  )
    fail("envValueCases", "*", "no raw row's member name spells \\u0000");
  if (
    !envValues.some(
      (c) =>
        parseRow(c) && namesOf(c.value!).some((n) => n.includes("\\u0000")),
    )
  )
    fail(
      "envValueCases",
      "*",
      "no parse row's member name spells an escaped backslash before u0000",
    );
  const escapedNonchar = (raw: string): boolean => {
    for (const m of raw.matchAll(/\\u([0-9a-fA-F]{4})/g))
      if (isNoncharacter(parseInt(m[1]!, 16))) return true;
    return false;
  };
  const rawNonchar = (raw: string): boolean => {
    for (const ch of raw) if (isNoncharacter(ch.codePointAt(0)!)) return true;
    return false;
  };
  if (
    !envValues.some(
      (c) => parseRow(c) && escapedNonchar(c.raw) && rawNonchar(c.raw),
    )
  )
    fail(
      "envValueCases",
      "*",
      "no parse row holds a noncharacter both escaped and raw",
    );

  // Rule 2's range on both sides of each edge.
  const singlePower = (c: EnvValueCase): number | null | undefined => {
    const tokens = numberTokens(c.raw);
    return tokens.length === 1 && tokens[0] === c.raw
      ? decimalPower(c.raw)
      : undefined;
  };
  const inRangeAt = (e: number) =>
    envValues.some((c) => !keepsRawRow(c) && singlePower(c) === e);
  const rawAt = (e: number) =>
    envValues.some((c) => keepsRawRow(c) && singlePower(c) === e);
  for (const e of [307, -307])
    if (!inRangeAt(e)) fail("envValueCases", "*", `no parsed row at E = ${e}`);
  for (const e of [308, -308])
    if (!rawAt(e)) fail("envValueCases", "*", `no raw row at E = ${e}`);
  if (
    !envValues.some(
      (c) =>
        keepsRawRow(c) &&
        singlePower(c) !== undefined &&
        numberForm(c.raw).expDigits.length === 7,
    )
  )
    fail(
      "envValueCases",
      "*",
      "no raw row whose exponent has seven significant digits",
    );

  // The whole file, as each runner loads it.
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (v.includes("\u0000")) fail("*", path, "a loaded string holds U+0000");
      if (hasLoneSurrogateRef(v))
        fail("*", path, "a loaded string holds a lone surrogate");
      return;
    }
    if (typeof v === "number") {
      if (!exactlyReadEverywhere(JSON.stringify(v)))
        fail(
          "*",
          path,
          `the number ${v} is outside the forms every SDK reads alike`,
        );
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((x, k) => walk(x, `${path}[${k}]`));
      return;
    }
    const obj = v as Record<string, unknown>;
    const names = Object.keys(obj);
    for (const name of names) {
      if (name.includes("\u0000"))
        fail("*", path, "a loaded member name holds U+0000");
      if (hasLoneSurrogateRef(name))
        fail("*", path, "a loaded member name holds a lone surrogate");
      walk(obj[name], `${path}.${name}`);
    }
    for (let a = 0; a < names.length; a++)
      for (let b = a + 1; b < names.length; b++)
        if (
          names[a] !== names[b] &&
          names[a]!.normalize("NFC") === names[b]!.normalize("NFC") &&
          !canonicalEqual(obj[names[a]!] as Json, obj[names[b]!] as Json)
        )
          fail(
            "*",
            path,
            "two canonically equivalent member names hold different values",
          );
  };
  walk(file, "$");
}

function hasLoneSurrogateRef(s: string): boolean {
  for (let k = 0; k < s.length; k++) {
    const u = s.charCodeAt(k);
    if (u >= 0xd800 && u <= 0xdbff) {
      const n = s.charCodeAt(k + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        k++;
        continue;
      }
      return true;
    }
    if (u >= 0xdc00 && u <= 0xdfff) return true;
  }
  return false;
}

function hasEquivalentPair(v: Json): boolean {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some(hasEquivalentPair);
  const names = Object.keys(v);
  for (let a = 0; a < names.length; a++)
    for (let b = a + 1; b < names.length; b++)
      if (names[a]!.normalize("NFC") === names[b]!.normalize("NFC"))
        return true;
  return names.some((n) => hasEquivalentPair(v[n]!));
}

export function buildConfigMatrix(): unknown {
  const resolve = resolveCases();
  const envValues = envValueCases();
  const list = listCases();
  const file = {
    configMatrixVersion: 1,
    description:
      'Config resolution (WIRE-CONTRACT-V3 §2.2.1). Precedence: enforced | hidden (remote) > local override > environment > remote default > fallback, reported as source enforced, hidden, local, env, remote-default or fallback; a layer holding JSON null answers null, and only fallback means no layer answered. A layer answers only for a key it holds itself (own properties), so `constructor` and `toString` are ordinary keys. `remote: null` means no document yet (a host without that state passes an empty map). Rule 1: the variable name is `envPrefix` plus the key with every `.` replaced by `__`, nothing else changed; a set variable counts even when empty. Rule 2: the value is the parsed value when the raw string is one RFC 8259 JSON text with no duplicate member names (compared by Unicode scalar value after unescaping, never normalized), no member name holding U+0000, no lone surrogate, every number zero or of magnitude at least 10^-307 and below 10^308 (judged from its digits, its exponent part at most six significant digits), and at most 64 arrays and objects open at once; otherwise it is the raw string, and reading never fails. Noncharacters are ordinary characters. Rule 3: a host without an environment layer resolves as though no variable were set, and checks `expectNoEnv` where present, else `expect`. Rule 4 (`listCases`): every document entry except hidden ones, each with its resolved value; `enforced` is true exactly when the state is enforced; keys only a local override or the environment supplies are not listed; each `expect` is sorted by key and runners sort their output the same way. An `envValueCase` expands to the resolve case { remote: null, localOverrides: {}, env: { "PKEY_CONFIG_value": raw }, envPrefix: "PKEY_CONFIG_", key: "value", fallback: "(fallback)" }, expecting { value, source: "env" }, and { "(fallback)", "fallback" } without an environment. `anyNumber: true` in place of `value` pins only the verdict: source env and a finite number in the SDK\'s own type. A resolveValue answer of undefined (nothing matched) reads as the row\'s fallback. Compare with canonical JSON: keys unordered, arrays ordered, numbers by value, an integral float equal to its integer, -0 equal to 0. Append-only: a new row keeps `configMatrixVersion`; a changed row or rule bumps it.',
    resolveCases: resolve,
    envValueCases: envValues,
    listCases: list,
  };
  checkConfigMatrix(resolve, envValues, list, JSON.parse(JSON.stringify(file)));
  return file;
}
