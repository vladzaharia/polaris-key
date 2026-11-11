#!/usr/bin/env node
// The live pairing matrix (CC-29X): two SDK drivers, A and B, pair and talk over real TCP on
// 127.0.0.1. The drivers speak JSON lines on stdin and stdout (README.md is the contract). The
// harness is also the mDNS broker: a driver sends its adverts here and gets the other's back, so no
// multicast is needed. Every timeout below is a hang guard; no step asserts on elapsed time.
//
//   node tools/live-peer/run.mjs --pair node:python     one ordered pair (A shows, B joins)
//   node tools/live-peer/run.mjs --matrix linux         every ordered pair of two different Linux drivers
//   node tools/live-peer/run.mjs --matrix macos         Swift against Node and Python, both ways
//   node tools/live-peer/run.mjs --list                 the drivers, and which can run here
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const repo = (p) => here(`../../${p}`);

// ── The driver table: the extension point (CC-29X.2, .3 add rows) ──────────────────────────────
// `command()` returns [exe, ...args, env]. `matrices` names the matrices the driver is part of.
const pythonExe = () =>
  process.env.PKEY_LIVE_PYTHON ??
  (existsSync(repo("sdks/python/.venv/bin/python"))
    ? repo("sdks/python/.venv/bin/python")
    : "python3");

const kotlinBin = here("drivers/kotlin/build/install/live-peer/bin/live-peer");
// `swift build -c release --package-path tools/live-peer/drivers/swift` puts the binary here.
const swiftBin = () =>
  process.env.PKEY_LIVE_SWIFT ??
  here("drivers/swift/.build/release/live-peer-swift");

// A matrix whose pairs all include one driver: the other SDKs are already paired in `linux`.
const MATRIX_ANCHORS = { macos: "swift" };

export const DRIVERS = {
  node: {
    matrices: ["linux", "macos"],
    available: () => existsSync(repo("packages/sdk-node/dist/index.js")),
    command: () => ({
      exe: process.execPath,
      args: [here("drivers/node.mjs")],
      env: {},
    }),
  },
  python: {
    matrices: ["linux", "macos"],
    available: () =>
      existsSync(repo("sdks/python/src/polaris_key/__init__.py")),
    command: () => ({
      exe: pythonExe(),
      args: [here("drivers/python.py")],
      env: { PYTHONPATH: repo("sdks/python/src") },
    }),
  },
  // The Kotlin JVM driver: `./gradlew :live-peer:installDist` (sdks/kotlin) builds it once; it needs a
  // JDK 17 on PATH or in JAVA_HOME.
  kotlin: {
    matrices: ["linux"],
    available: () => existsSync(kotlinBin),
    command: () => ({ exe: kotlinBin, args: [], env: {} }),
  },
  // The Swift driver: a SwiftPM executable over sdks/swift (macOS only: the SDK's local links use Network.framework).
  swift: {
    matrices: ["macos"],
    available: () => process.platform === "darwin" && existsSync(swiftBin()),
    command: () => ({ exe: swiftBin(), args: [], env: {} }),
  },
};

// The platform a driver reports for itself is the host's, in the SDKs' X-PKey-Platform spelling.
const HOST_PLATFORM =
  { darwin: "macos", linux: "linux", win32: "windows" }[process.platform] ??
  null;

const STEP_MS = Number(process.env.PKEY_LIVE_STEP_MS ?? 60_000);
const TRANSFER_BYTES = 4 * 1024 * 1024;

const pattern = (n) =>
  Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + 13) & 0xff));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── One driver process ─────────────────────────────────────────────────────────────────────────
class Driver {
  #pending = new Map();
  #next = 1;
  #onMdns;
  stderr = [];
  exited = null;

  constructor(name, onMdns) {
    this.name = name;
    this.#onMdns = onMdns;
  }

  async start() {
    const { exe, args, env } = DRIVERS[this.name].command();
    this.proc = spawn(exe, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.proc.stdin.on("error", () => {});
    this.proc.stderr.on("data", (d) => {
      this.stderr.push(String(d));
      if (process.env.PKEY_LIVE_VERBOSE)
        process.stderr.write(`[${this.name}] ${d}`);
    });
    this.proc.on("exit", (code, sig) => {
      this.exited = { code, sig };
      for (const p of this.#pending.values())
        p.reject(new Error(`${this.name} driver exited (${code ?? sig})`));
      this.#pending.clear();
    });
    const ready = new Promise((resolve, reject) => {
      this.#pending.set("ready", { resolve, reject });
    });
    createInterface({ input: this.proc.stdout }).on("line", (l) =>
      this.#line(l),
    );
    await this.#guard(ready, "ready", STEP_MS);
  }

  #line(l) {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      this.stderr.push(`non-JSON stdout: ${l}\n`);
      return;
    }
    if (m.ready) return this.#pending.get("ready")?.resolve(m);
    if (m.mdns) return this.#onMdns(this, m);
    this.#pending.get(m.seq)?.resolve(m);
  }

  #guard(p, what, ms) {
    let t;
    return Promise.race([
      p,
      new Promise((_, rej) => {
        t = setTimeout(
          () => rej(new Error(`${this.name}: ${what} hung (${ms} ms guard)`)),
          ms,
        );
      }),
    ]).finally(() => clearTimeout(t));
  }

  /** Send a command; resolves with the driver's answer (ok or not), rejects only on a hang or a crash. */
  call(cmd, args = {}, ms = STEP_MS) {
    const id = this.#next++;
    const answer = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.proc.stdin.write(`${JSON.stringify({ ...args, seq: id, cmd })}\n`);
    return this.#guard(answer, cmd, ms).finally(() => this.#pending.delete(id));
  }

  /** Like `call`, but a refusal throws. */
  async ok(cmd, args, ms) {
    const r = await this.call(cmd, args, ms);
    if (!r.ok)
      throw new Error(`${this.name} ${cmd} failed: ${JSON.stringify(r.error)}`);
    return r;
  }

  push(m) {
    if (!this.exited) this.proc.stdin.write(`${JSON.stringify(m)}\n`);
  }

  async stop() {
    if (this.exited === null) {
      this.push({ seq: 0, cmd: "quit" });
      this.proc.stdin.end();
      for (let i = 0; i < 100 && this.exited === null; i++) await sleep(50);
      if (this.exited === null) this.proc.kill("SIGKILL");
    }
  }
}

// ── The scenarios ──────────────────────────────────────────────────────────────────────────────
class Failure extends Error {}
const check = (cond, msg) => {
  if (!cond) throw new Failure(msg);
};

/** Drain `who`'s events until one matches (a hang guard bounds the wait). */
async function waitEvent(who, match, what) {
  const seen = [];
  for (let i = 0; i < STEP_MS / 50; i++) {
    const { events } = await who.ok("events");
    seen.push(...events);
    const hit = seen.find(match);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Failure(`${what}: no such event (saw ${JSON.stringify(seen)})`);
}

/** `who`'s links once there are `n` of them (a hang guard bounds the wait); the last list otherwise. */
async function listWhen(who, n) {
  let links = [];
  for (let i = 0; i < STEP_MS / 50; i++) {
    links = (await who.ok("list")).links;
    if (links.length === n) break;
    await sleep(50);
  }
  return links;
}

const scenarios = (a, b) => {
  const s = { codeLinks: {}, qrLinks: {} };
  return [
    [
      "pair by code",
      async () => {
        const shown = await a.ok("show");
        check(/^\d{4} ?\d{4}$/.test(shown.code), `code shape: ${shown.code}`);
        const digits = shown.code.replace(/\D/g, "");
        const wrong = digits.slice(0, -1) + (digits.endsWith("0") ? "1" : "0");
        const bad = await b.call("join", { code: wrong });
        check(!bad.ok, "a wrong code paired");
        check(
          bad.error.reason === "wrong",
          `wrong code reason: ${JSON.stringify(bad.error)}`,
        );
        // The window is still open, under a new code.
        const again = await a.ok("show");
        check(
          again.code !== shown.code,
          "the code did not change after a failed guess",
        );
        const good = await b.ok("join", { code: again.code });
        check(
          typeof bad.dialsLeft === "number" &&
            typeof good.dialsLeft === "number" &&
            good.dialsLeft < bad.dialsLeft,
          `dials left did not drop: ${bad.dialsLeft} then ${good.dialsLeft}`,
        );
        s.codeLinks.b = good.link;
        // The shower stores its side when the joiner's consent reaches it, a moment after the joiner returns.
        const la = await listWhen(a, 1);
        const lb = await listWhen(b, 1);
        check(
          la.length === 1 && lb.length === 1,
          `links: ${la.length} on A, ${lb.length} on B`,
        );
        s.codeLinks.a = la[0].id;
        check(lb[0].id === good.link, "B's join id is not B's listed link");
        check(
          la[0].platform === HOST_PLATFORM && lb[0].platform === HOST_PLATFORM,
          `platforms: A sees ${la[0].platform}, B sees ${lb[0].platform}, host ${HOST_PLATFORM}`,
        );
        return `wrong then right; dials left ${bad.dialsLeft} then ${good.dialsLeft}`;
      },
    ],

    [
      "pair by QR",
      async () => {
        const shown = await a.ok("show", { fresh: true });
        check(/^PKP1:/.test(shown.qr), `qr shape: ${shown.qr}`);
        const joined = await b.ok("join", { qr: shown.qr });
        check(
          joined.link !== s.codeLinks.b,
          "the QR pairing reused the first link",
        );
        for (const d of [a, b])
          check(
            (await listWhen(d, 2)).length === 2,
            `${d.name} does not hold two links`,
          );
        return "two links each";
      },
    ],

    [
      "open both ways",
      async () => {
        await b.ok("events");
        await a.ok("events");
        await b.ok("open", { id: s.codeLinks.b });
        await waitEvent(
          a,
          (e) => e.kind === "link" && e.id === s.codeLinks.a,
          "A hears B",
        );
        await a.ok("open", { id: s.codeLinks.a });
        await waitEvent(
          b,
          (e) => e.kind === "link" && e.id === s.codeLinks.b,
          "B hears A",
        );
        return "B to A, then A to B";
      },
    ],

    [
      `transfer ${TRANSFER_BYTES / 1024 / 1024} MiB`,
      async () => {
        const want = sha256(pattern(TRANSFER_BYTES));
        const [sent, got] = await Promise.all([
          a.ok(
            "send",
            { id: s.codeLinks.a, bytes: TRANSFER_BYTES, sha256: want },
            STEP_MS * 2,
          ),
          b.ok("recv", {}, STEP_MS * 2),
        ]);
        check(
          got.sha256 === want && got.bytes === TRANSFER_BYTES,
          `received ${got.bytes} bytes, ${got.sha256}`,
        );
        check(sent.sha256 === want, "the sender's hash differs");
        return `${got.bytes} bytes, sha256 ${want.slice(0, 12)}`;
      },
    ],

    [
      "forget",
      async () => {
        await b.ok("events");
        const r = await a.ok("forget", { id: s.codeLinks.a });
        check(r.removed === true, "forget removed nothing");
        const end = await waitEvent(
          b,
          (e) =>
            e.kind === "session-end" &&
            e.id === s.codeLinks.b &&
            e.code === "peer_revoked",
          "B's session ends peer_revoked",
        );
        check(
          (await a.ok("list")).links.length === 1,
          "A should hold only the QR link",
        );
        const next = await b.call("open", { id: s.codeLinks.b, wait: false });
        check(!next.ok, "B opened a forgotten link");
        return `B ended ${end.code}; next open: ${next.error.reason ?? next.error.code}`;
      },
    ],
  ];
};

async function runPair(an, bn) {
  const onMdns = (from, m) => {
    for (const to of drivers) {
      if (to === from) continue;
      if (m.mdns === "advertise") to.push({ mdns: "up", advert: m.advert });
      else if (m.mdns === "withdraw")
        to.push({ mdns: "down", instance: m.instance });
    }
  };
  const a = new Driver(an, onMdns);
  const b = new Driver(bn, onMdns);
  const drivers = [a, b];
  const rows = [];
  try {
    await Promise.all([a.start(), b.start()]);
    let broken = false;
    for (const [name, run] of scenarios(a, b)) {
      if (broken) {
        rows.push({ name, status: "skip", detail: "" });
        continue;
      }
      try {
        rows.push({ name, status: "pass", detail: await run() });
      } catch (e) {
        broken = true;
        rows.push({ name, status: "FAIL", detail: String(e.message ?? e) });
      }
    }
  } catch (e) {
    rows.push({
      name: "start",
      status: "FAIL",
      detail: String(e.message ?? e),
    });
  } finally {
    await Promise.all(drivers.map((d) => d.stop().catch(() => {})));
  }
  const failed = rows.some((r) => r.status === "FAIL");
  if (failed)
    for (const d of drivers)
      if (d.stderr.length)
        process.stderr.write(
          `--- ${d.name} stderr ---\n${d.stderr.join("")}\n`,
        );
  return rows;
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────
function pairsOf(argv) {
  const i = argv.indexOf("--pair");
  if (i >= 0) {
    const [x, y] = (argv[i + 1] ?? "").split(":");
    for (const n of [x, y])
      if (!DRIVERS[n])
        throw new Error(
          `unknown driver "${n}"; known: ${Object.keys(DRIVERS)}`,
        );
    return [[x, y]];
  }
  const j = argv.indexOf("--matrix");
  if (j >= 0) {
    const m = argv[j + 1];
    const names = Object.keys(DRIVERS).filter(
      (n) => DRIVERS[n].matrices.includes(m) && DRIVERS[n].available(),
    );
    if (names.length === 0)
      throw new Error(`no driver can run in matrix "${m}"`);
    // Distinct SDKs only; a same-SDK pair is `--pair node:node`. A matrix with an anchor keeps the pairs
    // that include it (macos: Swift against the others, both ways).
    const anchor = MATRIX_ANCHORS[m];
    return names.flatMap((x) =>
      names
        .filter((y) => y !== x && (!anchor || x === anchor || y === anchor))
        .map((y) => [x, y]),
    );
  }
  throw new Error(
    "usage: run.mjs --pair <a>:<b> | --matrix linux|macos | --list",
  );
}

async function main(argv) {
  if (argv.includes("--list")) {
    for (const [n, d] of Object.entries(DRIVERS))
      console.log(
        `${n}\t${d.matrices.join(",")}\t${d.available() ? "available" : "missing"}`,
      );
    return 0;
  }
  const out = [];
  let bad = false;
  for (const [x, y] of pairsOf(argv)) {
    const rows = await runPair(x, y);
    for (const r of rows) {
      out.push(
        `${`${x} -> ${y}`.padEnd(18)} ${r.name.padEnd(14)} ${r.status.padEnd(5)} ${r.detail}`,
      );
      bad ||= r.status === "FAIL";
    }
    console.log(out.splice(0).join("\n"));
  }
  console.log(bad ? "FAILED" : "all pairs passed");
  return bad ? 1 : 0;
}

process.exit(
  await main(process.argv.slice(2)).catch((e) => {
    console.error(String(e.message ?? e));
    return 2;
  }),
);
