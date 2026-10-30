/**
 * `pkey feeds setup --write` (F-37.3): sign in with the device flow for a `packages:read` token,
 * then apply F-37.2's `userConfigPlan` to the user's own configuration. The print form of
 * `pkey feeds setup` (feedSetup.ts) is untouched and is what CI uses.
 *
 * Safety properties (each has a test in test/feedsWrite.test.ts):
 *   guards    CI, no terminal, an unset or unusable HOME and a HOME under the working directory are
 *             refused BEFORE any network call.
 *   identity  the credential store is never opened and `PKEY_ADMIN_TOKEN` never read: the device
 *             flow asks for scope `packages:read` only, and the answer must say exactly that, carry
 *             a `pkeyp_` token, an https registry origin and a `__token__` username.
 *   input     every feed from the answer goes through `userConfigPlan`, which validates the owner
 *             and each namespace value against the ecosystem's own pattern; nothing is written
 *             when any feed fails.
 *   files     only under HOME, merged line-for-line (our entry updated in place, every other line
 *             kept, a rerun changes nothing), written to a temp file in the same directory at
 *             0600 and renamed over the target; a first change keeps `<file>.pkey-backup` (0600).
 *             A target that resolves outside HOME (a symlink out of it), is not a regular file or
 *             cannot be merged without guessing is refused and left as it was.
 *   commands  the token reaches `docker` and `cargo` on stdin and `swift` as a 0600 file deleted
 *             afterwards. It is never in argv, the child's environment is the CLI's without
 *             `PKEY_*`, the child runs in HOME and its output is not shown.
 *   output    one line per tool; never an edit's content, never the token (its last four
 *             characters, as `pkey login` shows).
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isCi, wrapSpans, type Line } from "@polaris-key/node/terminal";
import {
  FEEDS_SETUP_WRITE_COMMAND,
  isPackageEcosystem,
} from "@polaris-key/manifest";
import {
  isExecStep,
  userConfigPlan,
  type CombinedFeed,
  type FeedEdit,
  type FileStep,
  type PlanStep,
} from "@polaris-key/manifest/integration";
import {
  block,
  envelope,
  Failure,
  hostOf,
  originFor,
  plain,
  rowsText,
  shown,
  text,
  day,
} from "./account.js";
import { isCredentialShape, Refusal } from "./credentials.js";
import {
  resolveSeams,
  runDeviceFlow,
  type DeviceMode,
  type LoginIo,
} from "./login.js";

const FEEDS_WRITE_USAGE = `${FEEDS_SETUP_WRITE_COMMAND} [--owner slug] [--base-url url] [--json]`;

const MAX_FEEDS = 64;
const EXEC_TIMEOUT_MS = 60_000;
const BACKUP_SUFFIX = ".pkey-backup";

// ── seams ─────────────────────────────────────────────────────────────────────

export interface RunResult {
  code: number | null;
  /** Standard output and error together, only for the capability probe. */
  out: string;
}

/** What `--write` does outside the filesystem under HOME, as seams (tests pass fakes). */
export interface FeedWriteSeams {
  /** Run `argv` (no shell) in `cwd` with `stdin` piped in. */
  run?: (
    argv: readonly string[],
    opts: { stdin?: string; cwd: string; env: Record<string, string> },
  ) => Promise<RunResult>;
  /** Is this executable on PATH? */
  onPath?: (name: string, pathVar: string) => boolean;
  /** Where the 0600 token file for `swift` is made. */
  tmpdir?: () => string;
}

function defaultOnPath(name: string, pathVar: string): boolean {
  const exts =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const st = statSync(path.join(dir, name + ext));
        if (st.isFile() && (process.platform === "win32" || st.mode & 0o111))
          return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

function defaultRun(
  argv: readonly string[],
  opts: { stdin?: string; cwd: string; env: Record<string, string> },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ code: null, out: "" });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), EXEC_TIMEOUT_MS);
    const keep = (b: Buffer) => {
      if (out.length < 16_384) out += b.toString("utf8");
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? "");
  });
}

// ── merging one file's text (pure) ────────────────────────────────────────────

/** A file the edit cannot be merged into without guessing at its structure. */
export class Unmergeable extends Error {}

const blank = (l: string) => /^\s*(#.*)?$/.test(l);
const indentOf = (l: string) => l.length - l.trimStart().length;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mergeLine(lines: string[], prefix: string, line: string): void {
  const at = lines.findIndex((l) => l.trimStart().startsWith(prefix));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
}

function mergeProperty(lines: string[], key: string, value: string): void {
  const re = new RegExp(`^\\s*${esc(key)}\\s*[=:]`);
  const at = lines.findIndex((l) => re.test(l));
  const line = `${key}=${value}`;
  if (at >= 0) lines[at] = line;
  else lines.push(line);
}

function yamlValue(v: string | boolean): string {
  return typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

function mergeYaml(
  lines: string[],
  keys: readonly string[],
  value: string | boolean,
): void {
  let start = 0;
  let end = lines.length;
  let parent = -1;
  for (let depth = 0; depth < keys.length; depth++) {
    const key = keys[depth]!;
    const last = depth === keys.length - 1;
    let child = -1;
    let found = -1;
    let regionEnd = end;
    for (let i = start; i < end; i++) {
      const l = lines[i]!;
      if (blank(l)) continue;
      if (/^\t/.test(l) || /^ *\t/.test(l)) throw new Unmergeable("tabs");
      const ind = indentOf(l);
      if (ind <= parent) {
        regionEnd = i;
        break;
      }
      if (child < 0) child = ind;
      if (ind !== child) continue;
      if (
        new RegExp(`^(["']?)${esc(key)}\\1\\s*:(\\s|$)`).test(l.trimStart())
      ) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      // Insert the rest of the path at the end of this region, after its last content line.
      let at = regionEnd;
      while (at > start && /^\s*$/.test(lines[at - 1]!)) at--;
      const base = child >= 0 ? child : parent < 0 ? 0 : parent + 2;
      const add: string[] = [];
      keys.slice(depth).forEach((k, n) => {
        const pad = " ".repeat(base + 2 * n);
        const isLast = depth + n === keys.length - 1;
        add.push(isLast ? `${pad}${k}: ${yamlValue(value)}` : `${pad}${k}:`);
      });
      lines.splice(at, 0, ...add);
      return;
    }
    const ind = indentOf(lines[found]!);
    // The key's children: the lines indented deeper than it.
    let childEnd = found + 1;
    for (let i = found + 1; i < lines.length; i++) {
      if (blank(lines[i]!)) continue;
      if (indentOf(lines[i]!) <= ind) break;
      childEnd = i + 1;
    }
    if (last) {
      if (childEnd > found + 1)
        throw new Unmergeable("a block value at the key");
      lines[found] = `${" ".repeat(ind)}${key}: ${yamlValue(value)}`;
      return;
    }
    if (!/^[^:]*:\s*(#.*)?$/.test(lines[found]!.trimStart()))
      throw new Unmergeable("an inline value where a mapping is needed");
    start = found + 1;
    end = childEnd;
    parent = ind;
  }
}

function tomlBalanced(s: string): boolean {
  let n = 0;
  let quote = "";
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") n++;
    else if (c === "}" || c === "]") n--;
  }
  return n === 0 && !quote;
}

function tomlKeyOf(line: string): string | null {
  const m = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(line);
  return m ? m[1]!.replace(/^["']|["']$/g, "") : null;
}

/** A dotted TOML key as its unquoted segments (`registries."x".y` -> registries, x, y). */
function tomlPath(src: string): string[] | null {
  const out: string[] = [];
  const re = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(\.|$)/y;
  let at = 0;
  while (at < src.length) {
    re.lastIndex = at;
    const m = re.exec(src);
    if (!m) return null;
    out.push(m[1]!.replace(/^["']|["']$/g, ""));
    at = re.lastIndex;
    if (m[2] === "") break;
  }
  return out.length ? out : null;
}

/** The table a `[a."b"]` header line names, or null for any other line. */
function tomlHeader(line: string): string[] | null {
  const m = /^\s*\[(?!\[)\s*(.+?)\s*\]\s*(#.*)?$/.exec(line);
  return m ? tomlPath(m[1]!) : null;
}

function mergeToml(
  lines: string[],
  table: string,
  key: string,
  value: string,
): void {
  const regionOf = (t: string): [number, number] | null => {
    const want = tomlPath(t);
    const h = lines.findIndex((l) => {
      const got = tomlHeader(l);
      return (
        got !== null &&
        want !== null &&
        got.length === want.length &&
        got.every((g, n) => g === want[n])
      );
    });
    if (h < 0) return null;
    let e = lines.length;
    for (let i = h + 1; i < lines.length; i++)
      if (/^\s*\[/.test(lines[i]!)) {
        e = i;
        break;
      }
    return [h + 1, e];
  };
  const bare = key.replace(/^["']|["']$/g, "");
  const region = regionOf(table);
  if (!region) {
    // `[a.b]` cannot be added when `[a]` already defines `b` as a value.
    const dot = table.lastIndexOf(".");
    if (dot > 0) {
      const outer = regionOf(table.slice(0, dot));
      const leaf = table.slice(dot + 1);
      if (outer)
        for (let i = outer[0]; i < outer[1]; i++)
          if (tomlKeyOf(lines[i]!) === leaf)
            throw new Unmergeable(`${leaf} is already a value`);
    }
    if (lines.length && !blank(lines[lines.length - 1]!)) lines.push("");
    lines.push(`[${table}]`, `${key} = ${value}`);
    return;
  }
  const [from, to] = region;
  for (let i = from; i < to; i++)
    if (tomlKeyOf(lines[i]!) === bare) {
      if (!tomlBalanced(lines[i]!.slice(lines[i]!.indexOf("=") + 1)))
        throw new Unmergeable("a multi-line value");
      lines[i] = `${key} = ${value}`;
      return;
    }
  let at = to;
  while (at > from && blank(lines[at - 1]!)) at--;
  lines.splice(at, 0, `${key} = ${value}`);
}

function mergeNetrc(
  lines: string[],
  machine: string,
  login: string,
  password: string,
): void {
  const startsEntry = (l: string) => /^\s*(machine|default)\b/.test(l);
  const mine = new RegExp(`^\\s*machine\\s+${esc(machine)}(\\s|$)`);
  const at = lines.findIndex((l) => mine.test(l));
  if (at < 0) {
    const block = [
      `machine ${machine}`,
      `  login ${login}`,
      `  password ${password}`,
    ];
    // `default` must stay the last entry: ours goes before it.
    const dflt = lines.findIndex((l) => /^\s*default\b/.test(l));
    if (dflt >= 0) {
      lines.splice(dflt, 0, ...block, "");
      return;
    }
    if (lines.length && !blank(lines[lines.length - 1]!)) lines.push("");
    lines.push(...block);
    return;
  }
  let to = lines.length;
  for (let i = at + 1; i < lines.length; i++)
    if (startsEntry(lines[i]!)) {
      to = i;
      break;
    }
  let hasLogin = false;
  let hasPassword = false;
  for (let i = at; i < to; i++) {
    lines[i] = lines[i]!.replace(
      /\blogin\s+\S+/,
      () => ((hasLogin = true), `login ${login}`),
    ).replace(
      /\bpassword\s+\S+/,
      () => ((hasPassword = true), `password ${password}`),
    );
  }
  let tail = to;
  while (tail > at + 1 && blank(lines[tail - 1]!)) tail--;
  const add: string[] = [];
  if (!hasLogin) add.push(`  login ${login}`);
  if (!hasPassword) add.push(`  password ${password}`);
  lines.splice(tail, 0, ...add);
}

/** `content` with `edits` merged in; every line they do not name is kept as it was. */
export function mergeEdits(
  content: string,
  edits: readonly FeedEdit[],
): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content === "" ? [] : content.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const e of edits) {
    switch (e.kind) {
      case "line":
        mergeLine(lines, e.prefix, e.line);
        break;
      case "property":
        mergeProperty(lines, e.key, e.value);
        break;
      case "yaml":
        mergeYaml(lines, e.path, e.value);
        break;
      case "toml":
        mergeToml(lines, e.table, e.key, e.value);
        break;
      case "netrc":
        mergeNetrc(lines, e.machine, e.login, e.password);
        break;
    }
  }
  return lines.length ? lines.join(eol) + eol : "";
}

// ── writing one file ──────────────────────────────────────────────────────────

/** A target that must not be written: why. */
export class Unsafe extends Error {}

const within = (root: string, p: string) =>
  p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Where `rel` (under HOME) really is. A symlink along the way is followed and must land inside
 * HOME; the answer is the real path, so the rename replaces the file the link points at and keeps
 * the link (a dotfile manager's) intact.
 */
export function safeTarget(realHome: string, rel: string): string {
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".."))
    throw new Unsafe("a path that is not inside the home directory");
  let cur = realHome;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(cur, parts[i]!);
    let st;
    try {
      st = lstatSync(next);
    } catch {
      // Nothing here yet: the rest is new, below a directory already checked.
      return path.join(cur, ...parts.slice(i));
    }
    let real = next;
    if (st.isSymbolicLink()) {
      try {
        real = realpathSync(next);
      } catch {
        throw new Unsafe("a symbolic link that goes nowhere");
      }
      if (!within(realHome, real))
        throw new Unsafe("links outside your home directory");
    }
    cur = real;
  }
  if (!statSync(cur).isFile()) throw new Unsafe("not a regular file");
  return cur;
}

export type FileState = "created" | "updated" | "unchanged";

/** Merge `edits` into `target` (from `safeTarget`): temp file at 0600 beside it, then rename. */
export function writeMerged(
  target: string,
  edits: readonly FeedEdit[],
  secret: boolean,
): { state: FileState; backup: boolean } {
  const exists = existsSync(target);
  const before = exists ? readFileSync(target, "utf8") : "";
  const after = mergeEdits(before, edits);
  let mode = 0o600;
  if (exists) {
    const m = statSync(target).mode & 0o777;
    if (after === before && (!secret || (m & 0o077) === 0))
      return { state: "unchanged", backup: false };
    // A secret file is never loosened: 0400 stays 0400.
    mode = secret ? m & 0o600 || 0o600 : m;
  }
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let backup = false;
  if (exists && after !== before) {
    const bak = target + BACKUP_SUFFIX;
    if (!existsSync(bak)) {
      writeFileSync(bak, before, { mode: 0o600, flag: "wx" });
      backup = true;
    }
  }
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.pkey-${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeSync(fd, after);
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  return { state: exists ? "updated" : "created", backup };
}

// ── the command ───────────────────────────────────────────────────────────────

export interface FeedsWriteOptions {
  cwd: string;
  /** Narrow the feeds to one product's. */
  owner?: string;
  seams: FeedWriteSeams;
}

type StepState =
  | "created"
  | "updated"
  | "unchanged"
  | "ran"
  | "missing"
  | "skipped"
  | "refused"
  | "failed";

interface Outcome {
  /** The row's label: the tool, or the ecosystem of a skipped feed. */
  tool: string;
  state: StepState;
  /** What the row says first: `~/.npmrc`, `signed in to pkg.plrs.im`, a product slug. */
  text: string;
  /** The file's `~/` path, and its real one when a link leads elsewhere. */
  file?: string;
  link?: string;
  backup?: string;
  /** The command, as far as it names no secret. */
  command?: string;
  product?: string;
  note?: string;
  /** The git work tree the written file sits in. */
  git?: string;
}

function readFeeds(raw: unknown, owner: string | undefined): CombinedFeed[] {
  if (!Array.isArray(raw) || raw.length > MAX_FEEDS) throw new Error("feeds");
  const feeds: CombinedFeed[] = [];
  for (const f of raw as Record<string, unknown>[]) {
    if (
      !f ||
      typeof f !== "object" ||
      typeof f["ecosystem"] !== "string" ||
      !isPackageEcosystem(f["ecosystem"]) ||
      typeof f["product"] !== "string" ||
      typeof f["namespace"] !== "object" ||
      f["namespace"] === null ||
      Array.isArray(f["namespace"])
    )
      throw new Error("feed");
    if (owner !== undefined && f["product"] !== owner) continue;
    feeds.push({
      ecosystem: f["ecosystem"],
      owner: f["product"],
      namespace: f["namespace"] as Record<string, unknown>,
    });
  }
  return feeds;
}

/** The registry origin the answer names: https, nothing but an origin. */
function registryOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.origin !== v || u.username || u.password)
      return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The clients a plan can set up, by the name a row gives them and the programs that stand for them. */
const CLIENTS: readonly (readonly [string, readonly string[]])[] = [
  ["npm", ["npm", "pnpm"]],
  ["yarn", ["yarn"]],
  ["bun", ["bun"]],
  ["pip/uv", ["pip", "pip3", "uv", "poetry"]],
  ["go", ["go"]],
  ["gradle", ["gradle"]],
  ["cargo", ["cargo"]],
  ["swift", ["swift"]],
  ["docker", ["docker"]],
];

const list = (items: readonly string[]): string =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** A refusal whose lines keep the command whole, wrapping only between its flags. */
class PrintRefusal extends Refusal {
  readonly lines: Line[];
  constructor(message: string, lead: string, code: string) {
    const units = [
      "pkey feeds setup",
      "--ecosystem npm",
      "--owner slug",
      "--token-env NAME",
    ];
    super(message, `${lead} ${units.join(" ")}`, code);
    this.lines = [
      [text(message)],
      [text(lead)],
      units.flatMap(
        (u, n): Line => [...(n ? [text(" ")] : []), text(u, { unit: true })],
      ),
    ];
  }
}

/** The clients on PATH, by row label. */
function installed(io: LoginIo, o: FeedsWriteOptions): string[] {
  const onPath = o.seams.onPath ?? defaultOnPath;
  const pathVar = io.env["PATH"] ?? "";
  return CLIENTS.filter(([, names]) =>
    names.some((n) => onPath(n, pathVar)),
  ).map(([label]) => label);
}

export function cmdFeedsWrite(
  io: LoginIo,
  o: FeedsWriteOptions,
): Promise<number> {
  const mode: DeviceMode = {
    command: "feeds setup",
    rerun: FEEDS_SETUP_WRITE_COMMAND,
    scope: "packages:read",
    title: "Polaris Key packages",
    copy: {
      opening: "Opening Polaris Locker in your browser",
      rateLimited: {
        message: "Too many sign-in attempts from this network.",
        fix: "Wait a few minutes, then run pkey feeds setup --write again.",
      },
      unsupportedFix: "Check that this is your Polaris Key server.",
      unavailable: [
        "This Polaris Key server has no package registry.",
        "Check --base-url.",
      ],
      tokenLimit: () => [
        [text("You already have the most personal tokens.")],
        [
          text(
            "Revoke one in Polaris Locker, under Packages, then run pkey feeds setup --write again.",
          ),
        ],
      ],
      forbidden: [
        "This Polaris Locker account can't get a token.",
        "Sign in to Polaris Locker to check it.",
      ],
      denied: (code) => `Code ${code} was denied in Polaris Locker.`,
      maybeApproved:
        "If you approved it, a token may exist: check Polaris Locker, under Packages.",
    },
    // The Polaris Locker page that approves it, built from the origin pkey resolved.
    approvePath: (code) => `/approve?code=${code}`,
    useServedApproveUrl: true,
    warnAdminEnv: false,
    // The refusals come first: before the origin is resolved, so before any request.
    guard: () => guards(io, o),
    begin: async () => ({
      replaces: false,
      note: `Sets up ${list(installed(io, o))}.`,
      approved: (body, gap) => apply(io, o, body, gap),
    }),
  };
  return runDeviceFlow(io, mode);
}

/** CI, no terminal, no usable HOME, nothing to set up: all before the network. */
function guards(io: LoginIo, o: FeedsWriteOptions): void {
  if (isCi(io.env))
    throw new PrintRefusal(
      "pkey feeds setup --write needs a person at a terminal.",
      "In CI, print the setup instead:",
      "ci",
    );
  const seams = resolveSeams(io);
  if (!seams.stdin?.isTTY || !io.stdout.isTTY)
    throw new PrintRefusal(
      "pkey feeds setup --write needs a person at a terminal.",
      "Without one, print the setup instead:",
      "no-tty",
    );
  home(io, o.cwd);
  if (!installed(io, o).length)
    throw new Refusal(
      "None of the tools pkey sets up are installed.",
      "Install npm, pip, go, cargo, docker or swift, or print the setup with pkey feeds setup.",
      "no-tools",
    );
}

/** HOME, real: set, absolute, a directory, and not inside the working directory. */
function home(io: LoginIo, cwd: string): string {
  const raw = io.env["HOME"] ?? io.env["USERPROFILE"];
  if (!raw || !path.isAbsolute(raw))
    throw new Refusal(
      "HOME is not set, so there is nowhere safe to write.",
      "Set HOME to your home directory, or print the setup instead.",
      "no-home",
    );
  let real: string;
  try {
    real = realpathSync(raw);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Refusal(
      "HOME is not a directory pkey can use.",
      "Set HOME to your home directory.",
      "no-home",
    );
  }
  let here = cwd;
  try {
    here = realpathSync(cwd);
  } catch {
    /* a missing cwd cannot contain it */
  }
  if (real !== here && within(here, real))
    throw new Refusal(
      "Your home directory is inside the current directory.",
      "Run pkey from another directory.",
      "home-in-cwd",
    );
  return real;
}

/** The nearest directory from `file` up to HOME that holds a `.git`, as a `~/` path. */
function gitTree(realHome: string, file: string): string | undefined {
  let dir = path.dirname(file);
  while (within(realHome, dir)) {
    if (existsSync(path.join(dir, ".git"))) return display(realHome, dir);
    if (dir === realHome) break;
    dir = path.dirname(dir);
  }
  return undefined;
}

const display = (realHome: string, p: string): string =>
  p === realHome
    ? "~"
    : `~/${path.relative(realHome, p).split(path.sep).join("/")}`;

/** The row label of a step: the tool, or the clients a shared .netrc serves. */
function toolLabel(s: PlanStep): string {
  if (s.tool !== "netrc") return s.tool;
  const names = CLIENTS.filter(([, n]) => n.some((x) => s.onPath.includes(x)))
    .map(([label]) => label)
    .join("/");
  return names || "netrc";
}

async function apply(
  io: LoginIo,
  o: FeedsWriteOptions,
  body: Record<string, unknown>,
  gap: string,
): Promise<number> {
  const origin = originFor(io, "feeds setup");
  const host = hostOf(origin);
  const label =
    typeof body["label"] === "string" && body["label"].trim()
      ? shown(body["label"], io.env).slice(0, 200)
      : null;
  const t = io.term(io.stdout);
  const quote = t.caps.unicode ? ["“", "”"] : ['"', '"'];
  // A refusal after the approval leaves a token that nothing uses: say where it ends.
  const revoke = `Revoke ${quote[0]}${label ?? `pkey on ${host}`}${quote[1]} in Polaris Locker, under Packages.`;
  const odd = (): Failure =>
    new Failure(
      `${host} answered the sign-in unexpectedly. Nothing was written.`,
      `Check --base-url. ${revoke}`,
      "unexpected-answer",
      { host },
    );

  // The scope first, before anything else about the answer is looked at.
  if (body["scope"] !== "packages:read")
    throw new Refusal(
      `${host} issued a token for a different scope than the one pkey asked for. Nothing was written.`,
      `Check that ${host} is your Polaris Key server. ${revoke}`,
      "wrong-scope",
    );
  const token = body["token"];
  const expiresAt = body["expiresAt"];
  if (
    typeof token !== "string" ||
    !token.startsWith("pkeyp_") ||
    !isCredentialShape(token) ||
    typeof expiresAt !== "number" ||
    !Number.isInteger(expiresAt) ||
    expiresAt <= 0 ||
    body["username"] !== "__token__"
  )
    throw odd();
  const registry = registryOf(body["registryOrigin"]);
  if (body["registryOrigin"] === null || body["registryOrigin"] === undefined)
    throw new Refusal(
      `${host} has no package registry. Nothing was written.`,
      `Check that ${host} is your Polaris Key server. ${revoke}`,
      "no-registry",
    );
  if (!registry) throw odd();
  let feeds: CombinedFeed[];
  try {
    feeds = readFeeds(body["feeds"], o.owner);
  } catch {
    throw odd();
  }
  const hint = token.slice(-4);
  // The last four characters of the token this one replaced, when the server ended one.
  const replaced =
    typeof body["replaced"] === "string" &&
    /^[A-Za-z0-9_-]{4}$/.test(body["replaced"])
      ? body["replaced"]
      : null;
  let plan;
  try {
    plan = userConfigPlan(feeds, { origin: registry, token });
  } catch {
    throw odd();
  }

  const realHome = home(io, o.cwd);
  const registryHost = new URL(registry).host;
  const pathVar = io.env["PATH"] ?? "";
  const onPath = o.seams.onPath ?? defaultOnPath;
  const runner = o.seams.run ?? defaultRun;
  const have = (s: PlanStep) => s.onPath.some((n) => onPath(n, pathVar));
  const outcomes: Outcome[] = [];

  // Files: one write per file, with every step that names it.
  const byFile = new Map<string, FileStep[]>();
  for (const s of plan.steps) {
    if (isExecStep(s)) continue;
    if (!have(s)) {
      const tool = toolLabel(s);
      if (!outcomes.some((x) => x.tool === tool && x.state === "missing"))
        outcomes.push({
          tool,
          state: "missing",
          text: `~/${s.file}`,
          file: `~/${s.file}`,
        });
      continue;
    }
    byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  }
  for (const [file, steps] of byFile) {
    const tool = [...new Set(steps.map(toolLabel))].join(" ");
    const shownFile = `~/${file}`;
    try {
      const real = safeTarget(realHome, file);
      const r = writeMerged(
        real,
        steps.map((s) => s.edit),
        steps.some((s) => s.secret),
      );
      const where = display(realHome, real);
      const git = r.state === "unchanged" ? undefined : gitTree(realHome, real);
      outcomes.push({
        tool,
        state: r.state,
        text: shownFile,
        file: where,
        ...(where !== shownFile ? { link: shownFile } : {}),
        ...(r.backup ? { backup: `${where}${BACKUP_SUFFIX}` } : {}),
        ...(git ? { git } : {}),
      });
    } catch (e) {
      const known = e instanceof Unsafe || e instanceof Unmergeable;
      outcomes.push({
        tool,
        state: known ? "refused" : "failed",
        text: shownFile,
        file: shownFile,
        note: known ? e.message : "could not be written",
      });
    }
  }

  // Commands, after the files they may read.
  for (const s of plan.steps) {
    if (!isExecStep(s)) continue;
    // A command line without any secret: the argv never holds the token.
    const command = s.exec.argv.slice(0, 3).join(" ");
    if (!have(s)) {
      outcomes.push({ tool: s.tool, state: "missing", text: command, command });
      continue;
    }
    outcomes.push(
      await runStep(io, o, s, command, realHome, token, runner, {
        host: registryHost,
      }),
    );
  }
  for (const k of plan.skipped)
    outcomes.push({
      tool: k.ecosystem,
      state: "skipped",
      text: k.owner,
      product: k.owner,
      note: k.reason,
    });

  const bad = outcomes.filter((x) => x.state === "failed");
  const refused = outcomes.filter((x) => x.state === "refused");
  const exit = bad.length ? 1 : refused.length ? 4 : 0;
  const warnings = [
    ...new Set(
      outcomes.flatMap((x) =>
        x.git
          ? [
              `${x.git} is a git repository: the token is now in a tracked file.`,
            ]
          : [],
      ),
    ),
  ];

  if (io.json) {
    io.stdout.write(
      envelope("feeds setup", exit, {
        host,
        registry,
        token: {
          type: "personal",
          scope: "packages:read",
          ...(label ? { label } : {}),
          hint,
          ...(replaced ? { replaced } : {}),
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        },
        steps: outcomes.map((x) => ({
          tool: x.tool,
          state: x.state,
          ...(x.file ? { file: x.file } : {}),
          ...(x.link ? { link: x.link } : {}),
          ...(x.backup ? { backup: x.backup } : {}),
          ...(x.command ? { command: x.command } : {}),
          ...(x.product ? { product: x.product } : {}),
          ...(x.note ? { note: x.note } : {}),
        })),
        ...(warnings.length ? { warnings } : {}),
      }),
    );
    return exit;
  }

  const ok = outcomes.filter((x) =>
    ["created", "updated", "unchanged", "ran"].includes(x.state),
  ).length;
  const tried = ok + bad.length + refused.length;
  const missing = outcomes.filter((x) => x.state === "missing");
  const shownRows = outcomes.filter((x) => x.state !== "missing");
  const sep = t.symbols.separator;
  const columns = t.caps.columns;
  /** One wrapped sentence under the rows, aligned with their text. */
  const sentence = (line: string): string =>
    wrapSpans([text(line)], Math.max(1, columns - (columns < 32 ? 0 : 3)))
      .map((l) => `${columns < 32 ? "" : "   "}${t.painter.line(l)}\n`)
      .join("");

  if (!feeds.length) {
    io.stdout.write(
      `${gap}${block(
        t,
        "warn",
        plain(
          o.owner
            ? `This account has no private feeds for ${o.owner}.`
            : "This account has no private package feeds.",
        ),
      )}\n`,
    );
  } else {
    const headline =
      bad.length || refused.length
        ? `Set up ${ok} of ${tried} ${tried === 1 ? "tool" : "tools"}.`
        : ok
          ? `Set up ${ok} ${ok === 1 ? "tool" : "tools"}.`
          : "Nothing to set up.";
    io.stdout.write(
      `${gap}${block(t, ok && !bad.length && !refused.length ? "ok" : "warn", plain(headline))}\n`,
    );
  }
  const word: Record<StepState, string> = {
    created: " created",
    updated: " updated",
    unchanged: " already set",
    ran: "",
    missing: "",
    skipped: "",
    refused: " refused",
    failed: " failed",
  };
  const rows: [string, Line][] = shownRows.map((x) => [
    x.tool,
    [
      text(x.text, { unit: true }),
      ...(x.link || (x.file && x.file !== x.text && x.state !== "refused")
        ? [text(` → ${x.file}`, { unit: true })]
        : []),
      text(word[x.state]),
      ...(x.backup ? [text(` ${sep} backup ${x.backup}`)] : []),
      ...(x.note ? [text(` ${sep} ${x.note}`)] : []),
    ],
  ]);
  if (missing.length)
    rows.push([
      "Not installed",
      [
        text([...new Set(missing.map((x) => x.tool))].join(", "), {
          unit: true,
        }),
      ],
    ]);
  if (rows.length) io.stdout.write(rowsText(t, rows, { indent: 3, label: 15 }));
  for (const w of warnings) io.stdout.write(`\n${block(t, "warn", plain(w))}`);
  io.stdout.write(
    `\n${rowsText(
      t,
      [
        [
          "Token",
          [
            text(
              label
                ? `${quote[0]}${label}${quote[1]} (pkeyp_${t.symbols.ellipsis}${hint})`
                : `pkeyp_${t.symbols.ellipsis}${hint}`,
              { unit: true },
            ),
            ...(replaced
              ? [
                  text(` replaces ${t.symbols.ellipsis}${replaced}`, {
                    unit: true,
                  }),
                ]
              : []),
          ],
        ],
        ["Expires", [text(day(expiresAt, io.env), { unit: true })]],
      ],
      { indent: 3, label: 15 },
    )}`,
  );
  io.stdout.write("\n");
  if (bad.length || refused.length)
    io.stdout.write(
      sentence(
        `Fix ${list([...new Set([...bad, ...refused].map((x) => x.tool))])}, then run pkey feeds setup --write again.`,
      ),
    );
  io.stdout.write(
    sentence("Revoke it any time in Polaris Locker, under Packages."),
  );
  return exit;
}

/** The last line a failed command printed, with the token and any pkeyp_ value taken out. */
function lastLine(out: string, token: string, env: LoginIo["env"]): string {
  const line =
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
  return shown(
    line
      .split(token)
      .join("…")
      .replace(/pkeyp_[A-Za-z0-9_-]+/g, "…"),
    env,
  ).slice(0, 120);
}

/** Run one command step; the token goes by stdin or a 0600 file, never argv. */
async function runStep(
  io: LoginIo,
  o: FeedsWriteOptions,
  s: Extract<PlanStep, { exec: unknown }>,
  command: string,
  cwd: string,
  token: string,
  run: NonNullable<FeedWriteSeams["run"]>,
  at: { host: string },
): Promise<Outcome> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(io.env))
    if (typeof v === "string" && !k.startsWith("PKEY_")) env[k] = v;
  env["HOME"] = cwd;
  const argv = [...s.exec.argv];
  const base = { tool: s.tool, command, product: s.owner };
  let dir: string | undefined;
  try {
    const tf = s.exec.tokenFile;
    if (tf) {
      // Does this installed tool take the flag at all?
      const probe = await run([...argv, "--help"], { cwd, env });
      if (!probe.out.includes(tf.flag))
        return {
          ...base,
          state: "skipped",
          text: command,
          note: `this ${s.tool} has no ${tf.flag}; set it up by hand`,
        };
      dir = mkdtempSync(path.join((o.seams.tmpdir ?? tmpdir)(), "pkey-"));
      const file = path.join(dir, "token");
      writeFileSync(file, tf.content, { mode: 0o600, flag: "wx" });
      argv.push(tf.flag, file);
    }
    const r = await run(argv, { cwd, env, stdin: s.exec.stdin });
    return r.code === 0
      ? {
          ...base,
          state: "ran",
          text:
            s.tool === "cargo"
              ? `signed in to registry ${s.owner}`
              : `signed in to ${at.host}`,
        }
      : {
          ...base,
          state: "failed",
          text: argv.slice(0, 2).join(" "),
          note:
            lastLine(r.out, token, io.env) ||
            (r.code === null ? "did not run" : `exit ${r.code}`),
        };
  } catch {
    return {
      ...base,
      state: "failed",
      text: argv.slice(0, 2).join(" "),
      note: "could not run",
    };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
