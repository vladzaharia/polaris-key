/**
 * UK-14 — server text is data, never terminal control and never a workflow command. A hostile
 * Worker (or a hostile proxy in front of one) answers with OSC 52 clipboard writes, screen
 * clears, 8-bit CSI, line breaks and GitHub Actions workflow commands in every field it can; what
 * pkey and the Action print must carry none of it as control, and inside Actions no line may read
 * as a command but pkey's own `::add-mask::` and `::error` annotation.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAction, writeOutputs } from "../src/action.js";
import { mask } from "../src/oidc.js";
import {
  COMMAND_BREAK,
  guardLine,
  guardOutput,
  renderRefusal,
  runPkey,
  underActions,
  untrusted,
  untrustedJson,
  untrustedLines,
} from "../src/index.js";
import {
  actionsEnv,
  BASE,
  capture,
  CI_TOKEN,
  cleanup,
  fakeServer,
  instant,
  json,
  OIDC_URL,
  repo,
  SLUG,
  tempDir,
} from "./publishFixture.js";

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanup();
});

const OSC52 = "\x1b]52;c;cGF5bG9hZA==\x07";
const CLEAR = "\x1b[2J";
const CSI8 = "\u009b31m";
const MASK_INJECT = "x\n::add-mask::secret";
const ERROR_SPOOF = "::error::spoofed";
const WARN_INDENTED = "  ::warning::x";
const LEGACY = "a ##[set-output name=outcome]pwned";
const HOSTILE = [
  OSC52,
  CLEAR,
  CSI8,
  MASK_INJECT,
  ERROR_SPOOF,
  WARN_INDENTED,
  LEGACY,
  "cr\rnul\u0000del\u007f",
];

/** A field that carries every hostile payload at once. */
const ALL = HOSTILE.join(" | ");

/** Any control character but TAB and LF: ESC, BEL, CR, NUL, DEL and every C1. */
const FOREIGN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const ACTIONS = { GITHUB_ACTIONS: "true" } as const;

/**
 * What a hostile answer may never achieve: a control character in the output, a line break of
 * its own (the `::add-mask::secret` half of `x\n::add-mask::secret` never starts a line), and,
 * inside Actions, any line the runner reads as a command but pkey's own.
 */
function expectInert(text: string, actions: boolean): void {
  expect(text).not.toMatch(FOREIGN);
  const lines = text.split("\n");
  for (const line of lines) {
    expect(line.startsWith("::add-mask::secret")).toBe(false);
    if (!actions) continue;
    expect(line).not.toContain("##[");
    if (line.trimStart().startsWith("::"))
      expect(
        line.startsWith("::add-mask::") ||
          line.startsWith("::error title=pkey release publish::"),
        `a workflow command that is not pkey's: ${JSON.stringify(line)}`,
      ).toBe(true);
  }
}

// ── untrusted() ──────────────────────────────────────────────────────────────────────────────

describe("untrusted()", () => {
  it("removes every C0 (LF included), DEL and C1 control, in and out of Actions", () => {
    for (const env of [{}, ACTIONS]) {
      expect(untrusted(OSC52, env)).toBe("]52;c;cGF5bG9hZA==");
      expect(untrusted(CLEAR, env)).toBe("[2J");
      expect(untrusted(CSI8, env)).toBe("31m");
      expect(untrusted("a\r\nb\u0000c\u007fd\u0085e", env)).toBe("abcde");
      expect(untrusted(ALL, env)).not.toMatch(FOREIGN);
      expect(untrusted(ALL, env)).not.toContain("\n");
    }
    expect(untrusted(42, {})).toBe("42");
    expect(untrusted(undefined, {})).toBe("undefined");
  });

  it("keeps a value from reading as a workflow command inside Actions only", () => {
    expect(untrusted(ERROR_SPOOF, ACTIONS)).toBe(
      `${COMMAND_BREAK}${ERROR_SPOOF}`,
    );
    expect(untrusted(WARN_INDENTED, ACTIONS)).toBe(
      `${COMMAND_BREAK}${WARN_INDENTED}`,
    );
    // The line break goes first, so the mask lands mid-line and needs no break.
    expect(untrusted(MASK_INJECT, ACTIONS)).toBe("x::add-mask::secret");
    expect(untrusted(LEGACY, ACTIONS)).toBe(
      `a ##${COMMAND_BREAK}[set-output name=outcome]pwned`,
    );
    for (const s of [ERROR_SPOOF, WARN_INDENTED, LEGACY])
      expect(untrusted(s, ACTIONS).trimStart().startsWith("::")).toBe(false);
    // Outside Actions nothing parses commands: only the controls go.
    expect(untrusted(ERROR_SPOOF, {})).toBe(ERROR_SPOOF);
    expect(untrusted(LEGACY, {})).toBe(LEGACY);
    // U+200B is not whitespace to trimStart().
    expect(COMMAND_BREAK.trimStart()).toBe(COMMAND_BREAK);
  });

  it("reads GITHUB_ACTIONS as the terminal kit reads a flag", () => {
    expect(underActions({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(underActions({ GITHUB_ACTIONS: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "false", "FALSE"])
      expect(underActions({ GITHUB_ACTIONS: v })).toBe(false);
  });

  it("untrustedLines keeps pkey's line breaks and treats each line", () => {
    const message = `Publishing failed\n${ERROR_SPOOF}\n  detail ${OSC52}\n${WARN_INDENTED}`;
    expect(untrustedLines(message, ACTIONS)).toBe(
      [
        "Publishing failed",
        `${COMMAND_BREAK}${ERROR_SPOOF}`,
        "  detail ]52;c;cGF5bG9hZA==",
        `${COMMAND_BREAK}${WARN_INDENTED}`,
      ].join("\n"),
    );
    expect(untrustedLines(message, {}).split("\n")).toHaveLength(4);
    expectInert(untrustedLines(message, ACTIONS), true);
  });

  it("untrustedJson is lossless and inert", () => {
    const value = { a: ALL, [CSI8]: ["\u2028", "##[x]"] };
    for (const space of [undefined, 2]) {
      const text = untrustedJson(value, space);
      expect(JSON.parse(text)).toEqual(value);
      expect(text).not.toMatch(FOREIGN);
      expect(text).not.toMatch(/[\u2028\u2029]/);
      expect(text).not.toContain("##[");
    }
  });
});

// ── renderRefusal ────────────────────────────────────────────────────────────────────────────

describe("renderRefusal", () => {
  const body = {
    error: OSC52,
    reason: CLEAR,
    message: MASK_INJECT,
    claim: ERROR_SPOOF,
    key: WARN_INDENTED,
    fields: [CSI8, LEGACY],
    errors: [
      { path: ERROR_SPOOF, code: OSC52, message: MASK_INJECT },
      { path: WARN_INDENTED, code: CSI8, message: CLEAR },
      null,
    ],
  };

  it("cleans every field on its own; the line breaks are pkey's", () => {
    for (const env of [{}, ACTIONS]) {
      const text = renderRefusal(
        "Submitting the release",
        `${BASE}/${SLUG}/release/publish/submit`,
        403,
        body,
        env,
      );
      expectInert(text, env === ACTIONS);
      const lines = text.split("\n");
      // Head, message, claim, key, fields, three errors (no hint for this status and reason):
      // eight lines, none of them the server's.
      expect(lines).toHaveLength(8);
      expect(lines[0]).toBe(
        `Submitting the release failed (403 [2J) at ${BASE}/${SLUG}/release/publish/submit`,
      );
      expect(lines[1]).toBe("  x::add-mask::secret");
      expect(lines[3]?.endsWith("::warning::x")).toBe(true);
    }
  });

  it("inside Actions, a field at the start of its line is led by U+200B", () => {
    const text = renderRefusal("Pushing", "https://x.test", 400, body, ACTIONS);
    expect(text).toContain(`  failing claim: ${COMMAND_BREAK}${ERROR_SPOOF}`);
    expect(text).toContain(
      `  ${COMMAND_BREAK}${ERROR_SPOOF} ]52;c;cGF5bG9hZA==:`,
    );
    expect(text).toContain(`##${COMMAND_BREAK}[set-output`);
  });

  it("without an env it still removes every control (a library caller's default)", () => {
    const text = renderRefusal("Pushing", "https://x.test", 400, body);
    expectInert(text, false);
  });
});

// ── the output guard ─────────────────────────────────────────────────────────────────────────

describe("the output guard", () => {
  it("passes pkey's own commands and defuses every other", () => {
    expect(guardLine("::add-mask::abc")).toBe("::add-mask::abc");
    expect(guardLine("::error title=pkey release publish::no")).toBe(
      "::error title=pkey release publish::no",
    );
    expect(guardLine("::error::spoofed")).toBe(
      `${COMMAND_BREAK}::error::spoofed`,
    );
    expect(guardLine("  ::add-mask::x")).toBe(
      `${COMMAND_BREAK}  ::add-mask::x`,
    );
    expect(guardLine("::stop-commands::tok")).toBe(
      `${COMMAND_BREAK}::stop-commands::tok`,
    );
    expect(guardLine("see ##[group]x")).toBe(`see ##${COMMAND_BREAK}[group]x`);
  });

  it("strips foreign controls, keeping TAB and pkey's colour", () => {
    expect(guardLine(`a\t${OSC52}${CLEAR}${CSI8}\r\u0000`)).toBe(
      "a\t]52;c;cGF5bG9hZA==[2J31m",
    );
    expect(guardLine("\x1b[1mbold\x1b[22m")).toBe("\x1b[1mbold\x1b[22m");
  });

  it("guards whole lines, holds a partial one, and reads the stream's fields through", () => {
    const io = capture();
    const tty = Object.assign(io.stdout, { isTTY: false, columns: 91 });
    const g = guardOutput(tty, ACTIONS);
    expect(g.stream).not.toBe(tty);
    expect(g.stream.isTTY).toBe(false);
    expect(g.stream.columns).toBe(91);
    g.stream.write("::error::sp");
    expect(io.out()).toBe("");
    g.stream.write("oofed\n::add-mask::ok\n  ::warn");
    expect(io.out()).toBe(`${COMMAND_BREAK}::error::spoofed\n::add-mask::ok\n`);
    // Bytes too, as Node's streams take them.
    (g.stream.write as unknown as (chunk: Uint8Array) => boolean)(
      new TextEncoder().encode("ing::x\x1b]52;c;x\x07"),
    );
    g.flush();
    expect(io.out()).toBe(
      `${COMMAND_BREAK}::error::spoofed\n::add-mask::ok\n${COMMAND_BREAK}  ::warning::x]52;c;x`,
    );
  });

  it("is not there outside Actions", () => {
    const io = capture();
    for (const env of [{}, { GITHUB_ACTIONS: "false" }])
      expect(guardOutput(io.stdout, env).stream).toBe(io.stdout);
  });
});

// ── the mask and $GITHUB_OUTPUT ──────────────────────────────────────────────────────────────

describe("workflow files and commands pkey writes", () => {
  it("a masked value with a line break stays one ::add-mask:: line", () => {
    const io = capture();
    mask(ACTIONS, io.stdout, "secret\n::set-env name=X::1\r%");
    expect(io.out()).toBe("::add-mask::secret%0A::set-env name=X::1%0D%25\n");
  });

  it("writes release-id and outcome only in the shape the Worker gives them", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "gh_output");
    const env = { GITHUB_OUTPUT: file };
    await writeFile(file, "");
    await writeOutputs({ env }, "v0.3.0", { outcome: "created" });
    await writeOutputs({ env }, "app@1.2.3+build.5", { outcome: "unchanged" });
    await writeOutputs({ env }, "v1\nevil=1", {
      outcome: "created\nrelease-id=pwned",
    });
    await writeOutputs({ env }, "v1 2", { outcome: ERROR_SPOOF });
    await writeOutputs({ env }, `v1${CSI8}`, { outcome: 7 });
    await writeOutputs({ env }, "v1\u2028x", { outcome: "Created" });
    expect(await readFile(file, "utf8")).toBe(
      [
        "release-id=v0.3.0",
        "outcome=created",
        "release-id=app@1.2.3+build.5",
        "outcome=unchanged",
        ...Array.from({ length: 4 }, () => ["release-id=", "outcome="]).flat(),
        "",
      ].join("\n"),
    );
  });
});

// ── pkey, end to end ─────────────────────────────────────────────────────────────────────────

/** A Worker that answers the token exchange with `answer`, behind a working Actions OIDC. */
function hostileExchange(answer: () => Response) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(OIDC_URL.split("?")[0]!))
      return json({ value: "h.p.s" });
    return answer();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const hostileRefusal = (status = 403, extra: Record<string, unknown> = {}) =>
  json(
    {
      error: OSC52,
      reason: CLEAR,
      message: ALL,
      claim: ERROR_SPOOF,
      key: WARN_INDENTED,
      fields: HOSTILE,
      errors: HOSTILE.map((h) => ({ path: h, code: h, message: h })),
      ...extra,
    },
    status,
  );

describe("pkey auth github-oidc against a hostile Worker", () => {
  for (const actions of [true, false])
    it(`prints the refusal inert (${actions ? "inside" : "outside"} Actions)`, async () => {
      const dir = await tempDir();
      const env = actionsEnv({ GITHUB_ENV: path.join(dir, "github_env") });
      if (!actions) delete env.GITHUB_ACTIONS;
      const w = hostileExchange(() => hostileRefusal());
      const io = capture();
      const code = await runPkey(
        ["auth", "github-oidc", "--product", SLUG, "--base-url", BASE],
        { cwd: dir, ...io, env, fetchImpl: w.fetchImpl, sleep: instant },
      );
      expect(code).toBe(1);
      const all = `${io.out()}${io.err()}`;
      expectInert(all, actions);
      expect(io.err()).toContain("Exchanging the GitHub OIDC token failed");
      expect(io.err()).toContain("]52;c;cGF5bG9hZA==");
      if (actions)
        expect(io.err()).toContain(`failing claim: ${COMMAND_BREAK}::error`);
    });

  it("a retryable refusal's reason is announced inert", async () => {
    const dir = await tempDir();
    const env = actionsEnv({ GITHUB_ENV: path.join(dir, "github_env") });
    const w = hostileExchange(() =>
      hostileRefusal(409, { retryable: true, reason: `${ALL}` }),
    );
    const io = capture();
    const code = await runPkey(
      ["auth", "github-oidc", "--product", SLUG, "--base-url", BASE],
      { cwd: dir, ...io, env, fetchImpl: w.fetchImpl, sleep: instant },
    );
    expect(code).toBe(1);
    expect(io.err()).toContain("is retryable; attempt 2 of 4");
    expectInert(`${io.out()}${io.err()}`, true);
  });

  it("an issued token's scopes are printed inert", async () => {
    const dir = await tempDir();
    const githubEnv = path.join(dir, "github_env");
    await writeFile(githubEnv, "");
    const w = hostileExchange(() =>
      json({ token: CI_TOKEN, expiresAt: 1, scopes: HOSTILE }),
    );
    const io = capture();
    const code = await runPkey(
      ["auth", "github-oidc", "--product", SLUG, "--base-url", BASE],
      {
        cwd: dir,
        ...io,
        env: actionsEnv({ GITHUB_ENV: githubEnv }),
        fetchImpl: w.fetchImpl,
        sleep: instant,
      },
    );
    expect(code).toBe(0);
    expect(io.out().startsWith(`::add-mask::${CI_TOKEN}\n`)).toBe(true);
    expectInert(`${io.out()}${io.err()}`, true);
  });
});

describe("pkey doctor against a hostile discovery document", () => {
  for (const actions of [true, false])
    it(`prints the services and keys inert (${actions ? "inside" : "outside"} Actions)`, async () => {
      const cwd = await repo();
      vi.stubGlobal("fetch", (async () =>
        json({
          services: Object.fromEntries(
            [...HOSTILE, "release"].map((k) => [k, { enabled: true }]),
          ),
          signing: { [CSI8]: ALL, kid: "\u0085::error::x" },
        })) as typeof fetch);
      const io = capture();
      const code = await runPkey(
        ["doctor", "--base-url", BASE, "--product", SLUG],
        { cwd, ...io, env: actions ? { ...ACTIONS } : {} },
      );
      expect(code).toBe(0);
      expect(io.out()).toContain("Remote discovery: ok");
      expect(io.out()).toMatch(/Services enabled: .*release/);
      expectInert(`${io.out()}${io.err()}`, actions);
    });

  it("a non-JSON discovery answer fails inert through the catch-all", async () => {
    const cwd = await repo();
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(`${OSC52}\n${ERROR_SPOOF}`, {
          status: 200,
        })) as typeof fetch,
    );
    const io = capture();
    const code = await runPkey(
      ["doctor", "--base-url", BASE, "--product", SLUG],
      { cwd, ...io, env: { ...ACTIONS } },
    );
    expect(code).toBe(1);
    expectInert(`${io.out()}${io.err()}`, true);
  });
});

describe("pkey release publish and distribution against a hostile Worker", () => {
  const publishArgs = () => [
    "release",
    "publish",
    "--product",
    SLUG,
    "--tag",
    "v0.3.0",
    "--dir",
    "dist",
    "--base-url",
    BASE,
  ];

  for (const actions of [true, false])
    it(`a submit's outcome and release id are printed inert (${actions ? "inside" : "outside"} Actions)`, async () => {
      const cwd = await repo();
      const server = fakeServer();
      server.script("/submit", () =>
        json({ ok: true, releaseId: ERROR_SPOOF, outcome: ALL }),
      );
      const io = capture();
      const code = await runPkey(publishArgs(), {
        cwd,
        ...io,
        env: actions
          ? actionsEnv({ PKEY_CI_TOKEN: CI_TOKEN })
          : { PKEY_CI_TOKEN: CI_TOKEN },
        fetchImpl: server.fetchImpl,
        sleep: instant,
      });
      expect(code).toBe(0);
      expect(io.out()).toContain("Published ");
      expectInert(`${io.out()}${io.err()}`, actions);
    });

  it("a rollout answer that starts its line is printed inert", async () => {
    const fetchImpl = (async () =>
      json({
        rollout: {
          deliverableId: ERROR_SPOOF,
          releaseId: OSC52,
          outletId: MASK_INJECT,
          channel: CSI8,
          state: LEGACY,
          rolloutBp: 2500,
        },
      })) as typeof fetch;
    for (const actions of [true, false]) {
      const io = capture();
      const code = await runPkey(
        [
          "distribution",
          "rollout",
          "--product",
          SLUG,
          "--outlet",
          "direct",
          "--channel",
          "stable",
          "--release",
          "v1",
          "--bp",
          "2500",
          "--base-url",
          BASE,
        ],
        {
          ...io,
          env: actions
            ? { ...ACTIONS, PKEY_CI_TOKEN: CI_TOKEN }
            : { PKEY_CI_TOKEN: CI_TOKEN },
          fetchImpl,
          sleep: instant,
        },
      );
      expect(code).toBe(0);
      expect(io.out()).toContain("at 25%");
      expectInert(`${io.out()}${io.err()}`, actions);
      // pkey masks the CI token first; the rollout line starts with the server's id.
      const line = io
        .out()
        .split("\n")
        .find((l) => l.includes("at 25%"))!;
      expect(line.startsWith(actions ? COMMAND_BREAK : "::error")).toBe(true);
    }
  });
});

// ── the Action ───────────────────────────────────────────────────────────────────────────────

function actionInputs(over: Record<string, string> = {}) {
  const raw: Record<string, string> = {
    product: SLUG,
    deliverable: "app",
    version: "",
    tag: "v0.3.0",
    channel: "",
    dir: "dist",
    source: "r2",
    meta: "",
    "base-url": BASE,
    "dry-run": "false",
    ...over,
  };
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]),
  );
}

describe("the Action against a hostile Worker", () => {
  it("a hostile refusal is one clean ::error:: annotation, and nothing else commands", async () => {
    const cwd = await repo();
    const server = fakeServer();
    server.script("/token", () => hostileRefusal());
    const io = capture();
    const code = await runAction({
      env: { ...actionsEnv(), ...actionInputs() },
      cwd,
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
    });
    expect(code).toBe(1);
    const out = io.out();
    expectInert(`${out}${io.err()}`, true);
    const annotations = out.split("\n").filter((l) => l.startsWith("::error"));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatch(
      /^::error title=pkey release publish::Exchanging the GitHub OIDC token failed \(403 \[2J\).*%0A {2}failing claim: \u200B::error::spoofed/,
    );
    // The annotation is one line: the server's line breaks never reach it.
    expect(annotations[0]).not.toMatch(/[\r\n]/);
    expect(io.err()).toContain("failing claim");
  });

  it("a hostile outcome is never written to $GITHUB_OUTPUT, and the summary is inert", async () => {
    const cwd = await repo();
    const output = path.join(cwd, "gh_output");
    await writeFile(output, "");
    const server = fakeServer();
    server.script("/submit", () =>
      json({
        ok: true,
        releaseId: `v0.3.0\n${ERROR_SPOOF}`,
        outcome: "created\nrelease-id=pwned",
      }),
    );
    const io = capture();
    const code = await runAction({
      env: { ...actionsEnv({ GITHUB_OUTPUT: output }), ...actionInputs() },
      cwd,
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
    });
    expect(code).toBe(0);
    expect(await readFile(output, "utf8")).toBe(
      "release-id=v0.3.0\noutcome=\n",
    );
    expectInert(`${io.out()}${io.err()}`, true);
  });
});
