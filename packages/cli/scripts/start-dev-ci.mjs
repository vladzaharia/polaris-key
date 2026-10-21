#!/usr/bin/env node
/**
 * The CI harness for the SDK live lanes (SP-41): one fresh `pkey dev` per lane, the generated
 * quickstart config, and the three variables every SDK's live test reads.
 *
 *   node packages/cli/scripts/start-dev-ci.mjs start --lang <node|react|python|swift|kotlin|godot>
 *   node packages/cli/scripts/start-dev-ci.mjs check
 *   node packages/cli/scripts/start-dev-ci.mjs stop  --lang <lang>
 *
 * `start` runs the BUILT CLI (`dist/bin/pkey.js dev --builtin --auto-approve --port 0`), so it needs
 * Node 22.13+ and `pnpm exec turbo run build --filter=@polaris-key/worker^...` (or any build that
 * leaves `dist/dev/server.mjs`) first. The server listens on loopback only, on a port the OS picks
 * (the lanes of one job never share a server, and two jobs on one machine never share a port), and
 * seeds the built-in Tidewater product with its seven test keys; nothing is widened for CI. It is
 * detached, so it outlives this process and later steps use it. Once the CLI has printed its
 * facts and `/__dev/info` plus the product's discovery document answer, `start`:
 *
 *   1. runs `pkey sdk --lang <lang> --dev --url <base> --write` in `<dir>/config`, the file the
 *      SDK's own quickstart would write (default name for the language), and checks it carries the
 *      server's base URL and every trust and release pin;
 *   2. exports, to the rest of the job, via `$GITHUB_ENV` (or as `export` lines on stdout when run
 *      by hand, for `eval "$(...)"`):
 *        PKEY_DEV_BASE_URL  http://127.0.0.1:<port>, no trailing slash
 *        PKEY_DEV_CONFIG    absolute path of the file step 1 wrote
 *        PKEY_DEV_APPROVE   absolute path of dev-approve.mjs, the host-side device-code approver:
 *                           `node "$PKEY_DEV_APPROVE" <verificationUri> <userCode>`, exit 0 = approved
 *
 * Everything lives in `<dir>`, `$RUNNER_TEMP/pkey-dev-<lang>` by default (`$TMPDIR` by hand):
 * outside the repository, so the Godot lane's "the tree is as committed" step stays true, and
 * never under a path a runner script wipes. `start` first stops whatever a previous run left in
 * `<dir>` and starts empty, and if anything fails after the server is up, stops it again.
 *
 * `check` is the gate a lane runs before its tests. It fails, naming every problem, unless the
 * three variables are set and non-empty in THIS step's environment (what the tests will see), the
 * config and approver files are there, the config carries the live server's pins, `node` on PATH
 * is new enough to run the approver, and the server answers. A lane that lost its variables then
 * fails loudly, instead of its tests skipping as they do on a developer's machine.
 *
 * A lane whose tests run under turbo (the React suite, in `pnpm test`) also needs the three names
 * under that task's `env` in turbo.json: turbo's strict env mode drops every variable it was not
 * told about, and a suite that sees none of them skips itself.
 *
 * `stop` ends the server (SIGTERM, then SIGKILL) and prints the tail of its log in a collapsed
 * group. It is idempotent and refuses to signal a process that is not a `pkey ... dev`. With
 * `--job-status success` (CI passes the job's status: every step before it passed) it then also
 * fails unless the server's request log shows what SP-41's B1-B5 ask of it: the seven seeded keys
 * (two activate, three are unauthorized, two are forbidden), a config change, a device-code
 * sign-in begun, approved and collected, a published release and a read of the update feed. A lane
 * whose suite skipped itself, or never saw its variables, cannot go green.
 *
 * Exit 0: done. Exit 1: failed (a `::error::` annotation under Actions, details on stderr). Exit 2:
 * usage. POSIX only: the lanes are Linux and macOS.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(HERE, "..");
const PKEY = path.join(CLI_DIR, "dist", "bin", "pkey.js");
const DEV_BUNDLE = path.join(CLI_DIR, "dist", "dev", "server.mjs");
const APPROVE = path.join(HERE, "dev-approve.mjs");

const ENV_NAMES = ["PKEY_DEV_BASE_URL", "PKEY_DEV_CONFIG", "PKEY_DEV_APPROVE"];
const MIN_NODE = [22, 13];
const BASE_URL = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;
const MARKER = ".pkey-dev-ci";
const LOG_TAIL_LINES = 300;
/** One request line of the server's log, `HH:MM:SS METHOD /path -> status 12ms` (worker/dev/server.ts). */
const LOG_LINE = /^\d{2}:\d{2}:\d{2} ([A-Z]+) (\S+) -> (\d+) \d+ms$/;

const USAGE = `Usage:
  node start-dev-ci.mjs start --lang <lang> [--dir <state dir>] [--timeout <seconds>]
  node start-dev-ci.mjs check
  node start-dev-ci.mjs stop  --lang <lang> | --dir <state dir> [--job-status <status>]
<lang> is any \`pkey sdk --lang\` value: node, react, python, swift, kotlin, godot.`;

class HarnessError extends Error {}
/** A wrong invocation, not a failed lane: exit 2 with the usage text. */
class UsageError extends Error {}

const fail = (message) => {
  throw new HarnessError(message);
};
const usage = (message) => {
  throw new UsageError(message);
};
const log = (message) => console.error(`start-dev-ci: ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inActions = () => process.env.GITHUB_ACTIONS === "true";

function nodeIsNewEnough(version) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

function tail(file, lines) {
  try {
    return readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .slice(-lines)
      .join("\n");
  } catch {
    return "";
  }
}

// ── the state directory ──────────────────────────────────────────────────────────────────────

function stateDir({ lang, dir }) {
  if (dir) return path.resolve(dir);
  if (!lang)
    usage(
      "name the lane with --lang <lang> (or its state directory with --dir)",
    );
  if (!/^[a-z][a-z0-9-]*$/.test(lang))
    usage(`--lang ${lang} is not a lane name`);
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), `pkey-dev-${lang}`);
}

/** An empty directory of ours: made if missing, emptied if it is a previous run's, else refused. */
function freshDir(dir) {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory())
      fail(`${dir} exists and is not a directory`);
    if (readdirSync(dir).length > 0) {
      if (!existsSync(path.join(dir, MARKER)))
        fail(
          `${dir} is not empty and was not made by start-dev-ci; use another --dir`,
        );
      rmSync(dir, { recursive: true, force: true });
    }
  }
  mkdirSync(path.join(dir, "config"), { recursive: true });
  writeFileSync(
    path.join(dir, MARKER),
    "state of a start-dev-ci lane; safe to delete\n",
  );
}

// ── the server process ───────────────────────────────────────────────────────────────────────

/** The full command line of `pid` (`-ww`: no width limit, which would cut a long checkout path short). */
function commandOf(pid) {
  const ps = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return ps.status === 0 ? ps.stdout.trim() : null;
}

/** True only for a live `... pkey.js dev ...` (a recycled pid, or a zombie, is not ours to signal). */
function isPkeyDev(pid) {
  const command = commandOf(pid);
  return command !== null && /pkey\.js\s+dev(\s|$)/.test(command);
}

function signal(pid, sig) {
  try {
    process.kill(-pid, sig); // the server is its own process group (spawned detached)
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }
}

/** Ends the server recorded in `dir`. Returns what happened: none, gone, stopped, killed. */
async function stopServer(dir) {
  const pidFile = path.join(dir, "server.pid");
  if (!existsSync(pidFile)) return "none";
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 1 || !isPkeyDev(pid)) return "gone";
  signal(pid, "SIGTERM");
  for (let i = 0; i < 100 && isPkeyDev(pid); i++) await sleep(100);
  if (!isPkeyDev(pid)) return "stopped";
  signal(pid, "SIGKILL");
  for (let i = 0; i < 50 && isPkeyDev(pid); i++) await sleep(100);
  if (isPkeyDev(pid)) fail(`pkey dev (pid ${pid}) did not stop`);
  return "killed";
}

/** Spawns the server and waits for the facts the CLI prints once it is listening. */
async function launch(dir, timeoutMs) {
  const stdout = path.join(dir, "server.out.log");
  const stderr = path.join(dir, "server.err.log");
  const outFd = openSync(stdout, "w");
  const errFd = openSync(stderr, "w");
  // `--builtin`: Tidewater and its seven test keys, never a `.pkey/` found on the way up from here.
  const child = spawn(
    process.execPath,
    [
      PKEY,
      "dev",
      "--builtin",
      "--auto-approve",
      "--port",
      "0",
      "--no-write",
      "--json",
    ],
    { cwd: dir, detached: true, stdio: ["ignore", outFd, errFd] },
  );
  closeSync(outFd);
  closeSync(errFd);
  let spawnError;
  let exited;
  child.once("error", (e) => (spawnError = e));
  child.once(
    "exit",
    (code, sig) => (exited = `${sig ? `signal ${sig}` : `code ${code}`}`),
  );
  child.unref();
  if (child.pid === undefined) {
    // `spawn` reports a failure asynchronously; the error event has fired by the next tick.
    await sleep(0);
    fail(
      `could not run ${process.execPath}: ${spawnError?.message ?? "unknown error"}`,
    );
  }
  writeFileSync(path.join(dir, "server.pid"), `${child.pid}\n`);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = readFileSync(stdout, "utf8");
    const end = text.indexOf("\n");
    if (end >= 0) {
      let info;
      try {
        info = JSON.parse(text.slice(0, end));
      } catch {
        return fail(
          `pkey dev printed something other than its facts:\n${text.slice(0, 400)}`,
        );
      }
      if (typeof info?.baseUrl !== "string" || !BASE_URL.test(info.baseUrl))
        fail(
          `pkey dev is not on loopback IPv4: baseUrl ${JSON.stringify(info?.baseUrl)}`,
        );
      if (
        typeof info.product !== "string" ||
        typeof info.trust?.pinnedKeys !== "object"
      )
        fail("pkey dev's facts have no product or trust pins");
      return { pid: child.pid, info, stdout, stderr };
    }
    if (exited !== undefined)
      fail(
        `pkey dev exited (${exited}) before it was ready:\n${tail(stderr, 40) || "(no output)"}`,
      );
    if (Date.now() > deadline)
      fail(
        `pkey dev was not ready after ${timeoutMs / 1000}s:\n${tail(stderr, 40) || "(no output)"}`,
      );
    await sleep(50);
  }
}

// ── health, config ───────────────────────────────────────────────────────────────────────────

async function getOk(url, label) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch (e) {
    const why =
      e?.cause?.code ??
      e?.cause?.errors?.[0]?.code ??
      e?.cause?.message ??
      e?.name ??
      "error";
    return fail(`${label}: ${url} did not answer (${why})`);
  }
  if (!res.ok) fail(`${label}: ${url} answered ${res.status}`);
  return res;
}

/** The live server's facts, after proving it answers: `/__dev/info` and the discovery document. */
async function liveInfo(baseUrl) {
  const info = await (
    await getOk(`${baseUrl}/__dev/info`, "pkey dev info")
  ).json();
  if (info?.baseUrl !== baseUrl)
    fail(`/__dev/info names ${info?.baseUrl}, not ${baseUrl}`);
  await getOk(
    `${baseUrl}/${info.product}/.well-known/polaris.json`,
    "product discovery",
  );
  return info;
}

async function waitHealthy(baseUrl) {
  let last;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await liveInfo(baseUrl);
    } catch (e) {
      last = e;
      await sleep(250);
    }
  }
  throw last;
}

/** What the generated module is missing of the server's facts; empty when it carries them all. */
function configGaps(text, info) {
  const gaps = [];
  if (!text.includes(info.baseUrl)) gaps.push(`the base URL ${info.baseUrl}`);
  if (!text.includes(`"${info.product}"`))
    gaps.push(`the product slug ${info.product}`);
  const pins = Object.entries(info.trust?.pinnedKeys ?? {});
  if (pins.length === 0)
    gaps.push("any trust pin (the server pins no signing key)");
  for (const [kid, key] of pins)
    if (!text.includes(`"${kid}"`) || !text.includes(key))
      gaps.push(`trust pin ${kid}`);
  for (const [kid, key] of Object.entries(info.releaseKeys ?? {}))
    if (!text.includes(`"${kid}"`) || !text.includes(key))
      gaps.push(`release key ${kid}`);
  return gaps;
}

/** `pkey sdk --lang <lang> --dev --url <base> --write`, in an empty directory; the file it wrote. */
function writeConfig(lang, info, dir) {
  const cwd = path.join(dir, "config");
  const run = spawnSync(
    process.execPath,
    [
      PKEY,
      "sdk",
      "--lang",
      lang,
      "--dev",
      "--url",
      info.baseUrl,
      "--write",
      // Godot's file is polaris_key.tres beside project.godot; this directory has no project.
      ...(lang === "godot" ? ["--out", "polaris_key.tres"] : []),
    ],
    { cwd, encoding: "utf8", timeout: 60_000 },
  );
  if (run.error || run.status !== 0)
    fail(
      `pkey sdk --lang ${lang} --dev --write failed (${run.error?.message ?? `exit ${run.status}`}):\n${(run.stderr || run.stdout || "").trim()}`,
    );
  const wrote = /^Wrote (.+)$/m.exec(run.stdout)?.[1];
  if (!wrote)
    return fail(`pkey sdk --lang ${lang} wrote no file:\n${run.stdout.trim()}`);
  // `pkey sdk` prints the physical path (`/tmp` is `/private/tmp` on macOS), so compare those.
  const file = path.resolve(cwd, wrote);
  if (path.relative(realpathSync(cwd), realpathSync(file)).startsWith(".."))
    fail(`pkey sdk wrote ${file}, outside ${cwd}`);
  const gaps = configGaps(readFileSync(file, "utf8"), info);
  if (gaps.length)
    fail(`${file} does not carry the server's facts: ${gaps.join(", ")}`);
  return file;
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function exportEnv(env) {
  const entries = Object.entries(env);
  if (entries.some(([, v]) => v === "" || /[\r\n]/.test(v)))
    fail("refusing to export an empty or multi-line value");
  if (process.env.GITHUB_ENV) {
    appendFileSync(
      process.env.GITHUB_ENV,
      entries.map(([k, v]) => `${k}=${v}\n`).join(""),
    );
    log(
      `exported ${entries.map(([k]) => k).join(", ")} to the rest of the job`,
    );
  } else {
    for (const [k, v] of entries) console.log(`export ${k}=${shellQuote(v)}`);
  }
}

async function start(values) {
  if (!values.lang) usage("start needs --lang <lang>");
  if (process.platform === "win32")
    fail("POSIX only: the live lanes run on Linux and macOS");
  if (!nodeIsNewEnough(process.versions.node))
    fail(
      `node ${process.version}: pkey dev needs Node ${MIN_NODE.join(".")} or newer (its built-in SQLite)`,
    );
  for (const file of [PKEY, DEV_BUNDLE])
    if (!existsSync(file))
      fail(
        `packages/cli/${path.relative(CLI_DIR, file)} is missing: build the CLI first (pnpm exec turbo run build --filter=@polaris-key/worker^...)`,
      );
  const timeout = values.timeout === undefined ? 60 : Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0)
    usage(`--timeout ${values.timeout} is not a number of seconds`);

  const dir = stateDir(values);
  const previous = await stopServer(dir);
  if (previous === "stopped" || previous === "killed")
    log(`stopped a pkey dev left in ${dir} (${previous})`);
  freshDir(dir);

  try {
    const server = await launch(dir, timeout * 1000);
    const info = await waitHealthy(server.info.baseUrl);
    const config = writeConfig(values.lang, info, dir);
    writeFileSync(
      path.join(dir, "state.json"),
      `${JSON.stringify({ lang: values.lang, pid: server.pid, baseUrl: info.baseUrl, product: info.product, config, node: process.version }, null, 2)}\n`,
    );
    log(
      `pkey dev (${values.lang}) on ${info.baseUrl}, pid ${server.pid}, product ${info.product}`,
    );
    log(`config ${config}`);
    log(`logs ${server.stderr}`);
    exportEnv({
      PKEY_DEV_BASE_URL: info.baseUrl,
      PKEY_DEV_CONFIG: config,
      PKEY_DEV_APPROVE: APPROVE,
    });
  } catch (e) {
    printLog(dir, "pkey dev log before the failure");
    await stopServer(dir);
    throw e;
  }
}

async function check() {
  const problems = [];
  const value = (name) => process.env[name] ?? "";
  for (const name of ENV_NAMES)
    if (!value(name)) problems.push(`${name} is empty or not set`);
  if (!nodeIsNewEnough(process.versions.node))
    problems.push(
      `node ${process.version} is first on PATH; the approver and pkey dev need ${MIN_NODE.join(".")} or newer`,
    );
  const base = value("PKEY_DEV_BASE_URL");
  if (base && !BASE_URL.test(base))
    problems.push(
      `PKEY_DEV_BASE_URL (${base}) must be http://127.0.0.1:<port> with no trailing slash`,
    );
  const config = value("PKEY_DEV_CONFIG");
  if (
    config &&
    !(
      path.isAbsolute(config) &&
      existsSync(config) &&
      statSync(config).size > 0
    )
  )
    problems.push(
      `PKEY_DEV_CONFIG (${config}) is not an absolute path to a non-empty file`,
    );
  const approve = value("PKEY_DEV_APPROVE");
  if (approve) {
    let same = false;
    try {
      same = realpathSync(approve) === realpathSync(APPROVE);
    } catch {
      same = false;
    }
    if (!same)
      problems.push(
        `PKEY_DEV_APPROVE (${approve}) is not this checkout's ${APPROVE}`,
      );
  }
  let info;
  if (problems.length === 0) {
    try {
      info = await liveInfo(base);
      const gaps = configGaps(readFileSync(config, "utf8"), info);
      if (gaps.length)
        problems.push(
          `${config} does not carry the live server's facts: ${gaps.join(", ")}`,
        );
    } catch (e) {
      problems.push(e.message);
    }
  }
  if (problems.length)
    fail(
      `the pkey dev lane is not ready:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  log(
    `lane ok: ${info.product} at ${base}; config ${config}; approver ${approve}`,
  );
}

function printLog(dir, title) {
  const text = tail(path.join(dir, "server.err.log"), LOG_TAIL_LINES);
  if (!text) return;
  if (inActions()) console.log(`::group::${title}`);
  else console.error(`--- ${title} ---`);
  (inActions() ? console.log : console.error)(text);
  if (inActions()) console.log("::endgroup::");
}

/**
 * What a lane's tests must have asked of the server, as requests on the wire: SP-41's B1 (first
 * activation), B2 (the refusals), B3 (a config change), B4 (a device-code sign-in) and B5 (the
 * update decision). The seven seeded keys give two activations, three 401s and two 403s.
 */
function expectedTraffic(product) {
  const p = product ? product.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "[^/]+";
  const name = product ?? "<product>";
  return [
    [
      "B1 first activation (ok, floating)",
      "POST",
      `/${p}/license/activate`,
      `/${name}/license/activate`,
      200,
      2,
    ],
    [
      "B2 unauthorized (expired, disabled, revoked)",
      "POST",
      `/${p}/license/activate`,
      `/${name}/license/activate`,
      401,
      3,
    ],
    [
      "B2 forbidden (device-limit-full, key-entry-limit)",
      "POST",
      `/${p}/license/activate`,
      `/${name}/license/activate`,
      403,
      2,
    ],
    ["B3 config change", "POST", "/__dev/config", "/__dev/config", 200, 1],
    [
      "B4 sign-in begun",
      "POST",
      `/${p}/identity/auth/device/start`,
      `/${name}/identity/auth/device/start`,
      200,
      1,
    ],
    [
      // I-37: the IdP callback hands over (303) to the explicit approval page; the person's
      // "Sign in on <device>" POST is what approves the code.
      "B4 sign-in approved",
      "POST",
      `/${p}/identity/auth/device/approve`,
      `/${name}/identity/auth/device/approve`,
      200,
      1,
    ],
    [
      "B4 sign-in collected",
      "POST",
      `/${p}/identity/auth/device/poll`,
      `/${name}/identity/auth/device/poll`,
      200,
      1,
    ],
    [
      "B5 release published",
      "POST",
      "/__dev/release",
      "/__dev/release",
      200,
      1,
    ],
    [
      "B5 update feed read",
      "GET",
      `/${p}/update/[^/]+/feed\\.jws`,
      `/${name}/update/<channel>/feed.jws`,
      200,
      1,
    ],
  ].map(([label, method, route, shown, status, min]) => ({
    label,
    method,
    route: new RegExp(`^${route}$`),
    shown: `${method} ${shown} -> ${status}`,
    status,
    min,
  }));
}

/** The expectations the log does not meet, each as "what: saw n of m `request`". */
function trafficGaps(logText, product) {
  const seen = [];
  for (const line of logText.split("\n")) {
    const m = LOG_LINE.exec(line);
    if (m) seen.push({ method: m[1], path: m[2], status: Number(m[3]) });
  }
  return expectedTraffic(product).flatMap((want) => {
    const n = seen.filter(
      (r) =>
        r.method === want.method &&
        r.status === want.status &&
        want.route.test(r.path),
    ).length;
    return n >= want.min
      ? []
      : [`${want.label}: saw ${n} of ${want.min} \`${want.shown}\``];
  });
}

/** Fails unless the server's whole request log shows the traffic a passing live lane leaves. */
function verifyTraffic(dir) {
  let product;
  try {
    product = JSON.parse(
      readFileSync(path.join(dir, "state.json"), "utf8"),
    ).product;
  } catch {
    product = undefined;
  }
  let text;
  try {
    text = readFileSync(path.join(dir, "server.err.log"), "utf8");
  } catch {
    return fail(`no server log in ${dir}: this lane never started a pkey dev`);
  }
  const gaps = trafficGaps(text, product);
  if (gaps.length)
    fail(
      `the job passed, but this lane's tests never made the requests SP-41 needs of a live pkey dev (the suite skipped itself, or never saw its variables):\n${gaps.map((g) => `  - ${g}`).join("\n")}`,
    );
  log(
    "the server saw every request B1-B5 make: activations, refusals, config change, sign-in, release, update feed",
  );
}

async function stop(values) {
  const dir = stateDir(values);
  const status = values["job-status"];
  const result = await stopServer(dir);
  if (result === "none") {
    log(`no pkey dev recorded in ${dir}`);
    if (status === "success")
      fail(
        "the job passed but this lane never started a pkey dev: its start step did not run",
      );
    return;
  }
  log(`pkey dev in ${dir}: ${result === "gone" ? "already gone" : result}`);
  printLog(dir, "pkey dev server log");
  if (status === "success") verifyTraffic(dir);
  else if (status)
    log(`job status ${status}: the lane's traffic is not checked`);
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        lang: { type: "string" },
        dir: { type: "string" },
        timeout: { type: "string" },
        "job-status": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    console.error(`start-dev-ci: ${e.message}\n${USAGE}`);
    return 2;
  }
  const [command, ...extra] = parsed.positionals;
  if (parsed.values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!["start", "check", "stop"].includes(command) || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }
  try {
    if (command === "start") await start(parsed.values);
    else if (command === "check") await check();
    else await stop(parsed.values);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`start-dev-ci: ${e.message}\n${USAGE}`);
      return 2;
    }
    const message =
      e instanceof HarnessError ? e.message : (e?.stack ?? String(e));
    // The annotation carries the first two lines (what failed and why); the rest is on stderr.
    if (inActions())
      console.log(
        `::error title=pkey dev ${command}::${message.split("\n").slice(0, 2).join(" ").replaceAll("%", "%25")}`,
      );
    console.error(`start-dev-ci: ${message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
