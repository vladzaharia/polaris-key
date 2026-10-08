// @pkey-feature ui.cli
// The Node terminal kit at every size a person may run it in (the owner's bar, 2026-10-08): 40,
// 60, 80 and 120 columns, each at 12 rows (a short "landscape" window) and 24, with long values
// (a 60-character product name, a 19-character code, a 110-character URL, a 60-character device
// label), in German and Japanese at 40 and 60, and a terminal narrowed from 80 to 50 columns in
// the middle of a live region. The terminal is a real emulator (@xterm/headless): it soft-wraps,
// scrolls and reflows, so a line wider than the screen, a cropped URL or a duplicated header is
// a failure here.
//
// Every screen must keep: no line wider than the terminal (no soft-wrapped row); no "…" inside a
// URL or a user code (each appears whole, wrapped at its own break points); no "..." crop; the
// code, the URL and the key hints within the rows; one blank rail row between blocks, never two.
// The Python kit's tests/cli/test_responsive.py runs the same matrix through pyte.

import { describe, expect, it } from "vitest";
import { createKitContext, type KitContext } from "../../src/cli/context.js";
import {
  activateFlow,
  devicesListFlow,
  loginFlow,
  offlineRequestFlow,
  statusFlow,
  updateApplyFlow,
} from "../../src/cli/flows.js";
import { renderHelp } from "../../src/cli/help.js";
import { CLI_VERBS } from "../../src/cli/kit.js";
import { LiveRegion } from "../../src/cli/term/live.js";
import { breakPieces, wrapSpans } from "../../src/cli/term/width.js";
import {
  deferred,
  FakeStdin,
  frozenTicker,
  KEY,
  NOW,
  settle,
  stubClient,
  TIDEWATER,
} from "./harness.js";
import { XtermScreen, type Row } from "./xterm.js";

/** The long-values fixture. */
const LONG = {
  name: "Tidewater Studio Professional Mastering Suite for Podcasters",
  code: "WDJB-MJHT-QXRP-LMNV",
  url: "https://licensing.tidewater-studio-professional.example.com/activate/device?region=eu-west-2&channel=stable-26",
  device: "Mara Fennick's 16-inch MacBook Pro (Studio B2, second floor)",
};
const SHORT = {
  name: "Tidewater Studio",
  code: "WDJB-MJHT",
  url: "https://key.plrs.im/device",
  device: "Work laptop",
};
type Values = typeof LONG;

const COLUMNS = [40, 60, 80, 120] as const;
const ROWS = [12, 24] as const;
const shown = (url: string) => url.replace(/^https?:\/\//, "");

interface Run {
  columns: number;
  rows: number;
  values?: Values;
  locale?: string;
  interactive?: boolean;
  headless?: boolean;
}

interface Harness {
  ctx: KitContext;
  screen: XtermScreen;
  stdin: FakeStdin;
  /** The viewport now, for the checks (the screen a person is looking at mid-flow). */
  snap(): Promise<Row[]>;
}

async function run(
  o: Run,
  scenario: (h: Harness) => Promise<unknown>,
): Promise<{ screen: XtermScreen; snaps: Row[][] }> {
  const screen = new XtermScreen(o.columns, o.rows);
  const stdin = new FakeStdin(o.interactive === true);
  if (!o.interactive) stdin.end();
  const v = o.values ?? SHORT;
  let clock = NOW;
  const ctx = await createKitContext({
    slug: "tidewater",
    bin: "tidewater",
    io: {
      stdout: screen,
      stderr: new XtermScreen(o.columns, o.rows),
      stdin,
      env: {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        PKEY_THEME: "dark",
        LANG: "en_US.UTF-8",
        DISPLAY: ":0",
        ...(o.headless ? { SSH_CONNECTION: "10.0.0.2 51234 10.0.0.9 22" } : {}),
      },
      platform: "linux",
      ticker: frozenTicker,
      // Each reading is 150 ms after the last, so a progress bar redraws on every event.
      now: () => (clock += 150),
      openUrl: () => true,
    },
    theme: o.locale ? { copy: { locale: o.locale } } : {},
    presentation: { presentation: () => ({ ...TIDEWATER, name: v.name }) },
    bundle: {},
    queryScheme: false,
  });
  const snaps: Row[][] = [];
  try {
    await scenario({
      ctx,
      screen,
      stdin,
      snap: async () => {
        await screen.flush();
        const rows = screen.viewport();
        snaps.push(rows);
        return rows;
      },
    });
  } finally {
    ctx.close();
  }
  await screen.flush();
  return { screen, snaps };
}

/** A stub whose sign-in waits until the test lets it finish. */
function signInClient(v: Values, gate: Promise<unknown>) {
  return stubClient({
    identity: {
      beginSignIn: async () => ({
        deviceCode: "dc_secret",
        userCode: v.code,
        verificationUri: v.url,
        verificationUriComplete: `${v.url}${v.url.includes("?") ? "&" : "?"}code=${v.code}`,
        expiresIn: 600,
        interval: 5,
        expiresAt: NOW / 1000 + 252,
      }),
      waitForSignIn: () => gate,
    },
  });
}

/** The text of the content column, rows joined: a URL or a code wrapped over rows reads whole. */
const joined = (rows: Row[]) =>
  rows.map((r) => [...r.text].slice(3).join("").trimEnd()).join("");

/** The checks every screen passes. */
function check(
  label: string,
  screen: XtermScreen,
  view: Row[],
  want: { code?: string; url?: string; hints?: boolean },
): void {
  const all = screen.all();
  expect(
    all.filter((r) => r.wrapped).map((r) => r.text),
    `${label}: a line wider than the terminal`,
  ).toEqual([]);
  const text = all.map((r) => r.text).join("\n");
  expect(text, `${label}: a "..." crop`).not.toContain("...");
  const body = joined(view);
  if (want.code)
    expect(body, `${label}: the code is cut or off the screen`).toContain(
      want.code,
    );
  if (want.url)
    expect(body, `${label}: the URL is cut or off the screen`).toContain(
      shown(want.url),
    );
  if (want.hints)
    expect(
      view.some((r) => /\bEsc\b/.test(r.text)),
      `${label}: the key hints are off the screen`,
    ).toBe(true);
  for (let i = 1; i < all.length; i++)
    expect(
      all[i]!.text === "│" && all[i - 1]!.text === "│",
      `${label}: two blank rail rows at ${i}:\n${text}`,
    ).toBe(false);
}

describe("URLs and codes wrap and are never cut", () => {
  it("breaks a URL after / and before ? and &, then at - and ., and keeps every character", () => {
    const url = shown(LONG.url);
    for (const w of [8, 20, 37, 57]) {
      const pieces = breakPieces(url, "url", w);
      expect(pieces.join("")).toBe(url);
      for (const p of pieces) expect([...p].length).toBeLessThanOrEqual(w);
    }
    expect(breakPieces("key.plrs.im/device?a=1&b=2", "url", 12)).toEqual([
      "key.plrs.im/",
      "device",
      "?a=1",
      "&b=2",
    ]);
  });
  it("starts a URL that does not fit on a line of its own, each piece keeping the link", () => {
    const lines = wrapSpans(
      [
        { text: "go to " },
        {
          text: shown(LONG.url),
          link: LONG.url,
          style: ["link"],
          break: "url",
        },
        { text: " and enter this code." },
      ],
      37,
    );
    expect(lines[0]!.map((s) => s.text).join("")).toBe("go to");
    const pieces = lines.flatMap((l) => l.filter((s) => s.link));
    expect(pieces.map((s) => s.text).join("")).toBe(shown(LONG.url));
    expect(pieces.every((s) => s.link === LONG.url)).toBe(true);
    expect(lines.flat().some((s) => s.text.includes("…"))).toBe(false);
  });
  it("wraps a code after its hyphens, and only where the line is too narrow for it", () => {
    const lines = wrapSpans([{ text: LONG.code, break: "code" }], 40);
    expect(lines.map((l) => l.map((s) => s.text).join(""))).toEqual([
      LONG.code,
    ]);
    expect(breakPieces(LONG.code, "code", 10)).toEqual([
      "WDJB-",
      "MJHT-",
      "QXRP-",
      "LMNV",
    ]);
  });
  it("never ends a wrapped line on a separator", () => {
    const lines = wrapSpans(
      [
        { text: "Enter", style: ["strong"], keep: true },
        { text: " open again", style: ["muted"] },
        { text: " · ", style: ["muted"] },
        { text: "c", style: ["strong"], keep: true },
        { text: " use a code", style: ["muted"] },
        { text: " · ", style: ["muted"] },
        { text: "Esc", style: ["strong"], keep: true },
        { text: " cancel", style: ["muted"] },
      ],
      37,
    ).map((l) => l.map((s) => s.text).join(""));
    expect(lines).toEqual(["Enter open again · c use a code", "Esc cancel"]);
  });
  it("has the long-values fixture the owner asked for", () => {
    expect([...LONG.name]).toHaveLength(60);
    expect([...LONG.code]).toHaveLength(19);
    expect([...LONG.url]).toHaveLength(110);
    expect([...LONG.device]).toHaveLength(60);
  });
});

describe("a live region taller than the screen", () => {
  it("drops its blank rows first, then lets the top lines scroll away", async () => {
    const screen = new XtermScreen(40, 5);
    const live = new LiveRegion(screen, { animate: true, rows: 5 });
    live.draw(["┌  Header", "│", "│  one", "│", "│  two", "└  Esc cancel"]);
    await screen.flush();
    expect(screen.viewport().map((r) => r.text)).toEqual([
      "┌  Header",
      "│  one",
      "│  two",
      "└  Esc cancel",
      "",
    ]);
    live.draw([
      "┌  Header",
      "│",
      "│  one",
      "│  two",
      "│  three",
      "│  four",
      "└  Esc cancel",
    ]);
    await screen.flush();
    const rows = screen.all().map((r) => r.text);
    expect(rows.slice(-5)).toEqual([
      "│  one",
      "│  two",
      "│  three",
      "│  four",
      "└  Esc cancel",
    ]);
    expect(rows.filter((r) => r === "┌  Header")).toHaveLength(1);
    live.close();
  });
});

describe("the resolution matrix (40/60/80/120 × 12/24, long values)", () => {
  for (const columns of COLUMNS)
    for (const rows of ROWS)
      for (const values of [LONG, SHORT]) {
        const size = `${columns}×${rows}${values === LONG ? " long" : ""}`;

        it(`login --device-code at ${size}: the code, the URL and the keys stay in view`, async () => {
          const gate = deferred<unknown>();
          const { screen, snaps } = await run(
            { columns, rows, values, interactive: true },
            async (h) => {
              const done = loginFlow(
                h.ctx,
                signInClient(values, gate.promise),
                {
                  deviceCode: true,
                },
              );
              await settle();
              await h.snap();
              gate.resolve({ status: "expired" });
              await done;
            },
          );
          check(`login code ${size}`, screen, snaps[0]!, {
            code: values.code,
            url: values.url,
            hints: true,
          });
          // A short terminal has no blank rows at all.
          if (rows <= 16)
            expect(snaps[0]!.filter((r) => r.text === "│")).toEqual([]);
        });

        it(`login in the browser at ${size}: the fallback URL and the keys stay in view`, async () => {
          const gate = deferred<unknown>();
          const { screen, snaps } = await run(
            { columns, rows, values, interactive: true },
            async (h) => {
              const done = loginFlow(h.ctx, signInClient(values, gate.promise));
              await settle();
              await h.snap();
              gate.resolve({ status: "expired" });
              await done;
            },
          );
          check(`login ${size}`, screen, snaps[0]!, {
            url: `${values.url}${values.url.includes("?") ? "&" : "?"}code=${values.code}`,
            hints: true,
          });
        });

        it(`the device limit at ${size}: the manage URL and the keys stay in view`, async () => {
          const manageUrl =
            values === LONG
              ? LONG.url.replace("activate/device", "portal/devices")
              : "https://key.plrs.im/portal/tidewater/devices";
          const { screen, snaps } = await run(
            { columns, rows, values, interactive: true },
            async (h) => {
              const done = activateFlow(
                h.ctx,
                stubClient({
                  license: {
                    activateWithKey: async () => ({
                      kind: "device-limit",
                      code: "device_limit",
                      limit: 3,
                      deviceCount: 3,
                      manageUrl,
                    }),
                  },
                }),
                { key: KEY },
              );
              await settle();
              await h.snap();
              h.stdin.press("escape", { sequence: "\x1b" });
              await done;
            },
          );
          check(`device limit ${size}`, screen, snaps[0]!, {
            url: manageUrl,
            hints: true,
          });
        });

        it(`offline-request at ${size}: the request code, and a QR only where the screen fits it`, async () => {
          const { screen } = await run({ columns, rows, values }, async (h) =>
            offlineRequestFlow(h.ctx, stubClient()),
          );
          const all = screen.all();
          check(`offline ${size}`, screen, all.slice(-rows), {
            code: "dev_9fK2Lw7QmZ",
          });
          const qr = all.some((r) => r.text.includes("█"));
          // The QR never pushes the header off the screen (the cursor's line after it included).
          if (qr) expect(all.length).toBeLessThan(rows);
          if (rows === 12) expect(qr).toBe(false);
          if (columns >= 80 && rows === 24 && values === SHORT)
            expect(qr).toBe(true);
        });

        it(`status, devices and update at ${size}: nothing wider than the terminal`, async () => {
          const { screen } = await run({ columns, rows, values }, async (h) => {
            await statusFlow(
              h.ctx,
              stubClient({ status: () => ({ status: "revoked" }) }),
            );
            await devicesListFlow(
              h.ctx,
              stubClient({
                listDevices: async () => [
                  {
                    id: "dev_9fK2Lw7QmZ",
                    current: true,
                    status: "ok",
                    label: values.device,
                    platform: "macOS",
                    arch: "arm64",
                  },
                ],
              }),
            );
            await updateApplyFlow(
              h.ctx,
              stubClient({
                update: {
                  decide: async () => ({
                    decision: {
                      action: "binary",
                      release: { version: "2.5.0" },
                      mandatory: false,
                    },
                    channel: "stable",
                  }),
                  install: async (
                    _d: unknown,
                    o: { onProgress(d: number, t: number): void },
                  ) => {
                    for (const d of [10, 40, 80, 100])
                      o.onProgress(d * 610_000, 61_000_000);
                    return { kind: "restartRequired", version: "2.5.0" };
                  },
                },
              }),
            );
          });
          check(`status/devices/update ${size}`, screen, [], {});
          const text = screen
            .all()
            .map((r) => r.text)
            .join("\n");
          // Below 50 columns a command row stacks: the command, then its label under it.
          if (columns < 50) expect(text).toMatch(/│ {2}tidewater activate\n/);
          // A finished download never reads "Up to date" above "Restart to finish updating".
          expect(text).not.toContain("Up to date");
          expect(text).toContain("100%");
        });
      }
});

describe("help", () => {
  for (const columns of COLUMNS)
    it(`never runs past ${columns} columns; below 50 each verb stacks above its description`, async () => {
      const { screen } = await run({ columns, rows: 24 }, async (h) => {
        h.screen.write(renderHelp(h.ctx, CLI_VERBS));
      });
      // (Usage syntax has its own "..." — `[label...]` — so only the width is checked here.)
      expect(
        screen
          .all()
          .filter((r) => r.wrapped)
          .map((r) => r.text),
        `help ${columns}: a line wider than the terminal`,
      ).toEqual([]);
      const text = screen
        .all()
        .map((r) => r.text)
        .join("\n");
      if (columns < 50) expect(text).toMatch(/\n {2}status\n {4}\S/);
    });
});

describe("German and Japanese at 40 and 60 columns", () => {
  for (const locale of ["de", "ja"])
    for (const columns of [40, 60])
      for (const rows of ROWS)
        it(`${locale} at ${columns}×${rows}: login code and the device limit`, async () => {
          const gate = deferred<unknown>();
          const { screen, snaps } = await run(
            { columns, rows, values: LONG, locale, interactive: true },
            async (h) => {
              const done = loginFlow(h.ctx, signInClient(LONG, gate.promise), {
                deviceCode: true,
              });
              await settle();
              await h.snap();
              gate.resolve({ status: "expired" });
              await done;
            },
          );
          check(`${locale} login ${columns}×${rows}`, screen, snaps[0]!, {
            code: LONG.code,
            url: LONG.url,
            hints: true,
          });
        });
});

describe("a terminal resized in the middle of a live region (80 → 50)", () => {
  it("lays the sign-in code out again: one header, nothing wider than the terminal", async () => {
    const gate = deferred<unknown>();
    const { screen, snaps } = await run(
      { columns: 80, rows: 24, values: LONG, interactive: true },
      async (h) => {
        const done = loginFlow(h.ctx, signInClient(LONG, gate.promise), {
          deviceCode: true,
        });
        await settle();
        await h.screen.resize(50, 24);
        await settle();
        await h.snap();
        gate.resolve({ status: "expired" });
        await done;
      },
    );
    check("resize login", screen, snaps[0]!, {
      code: LONG.code,
      url: LONG.url,
      hints: true,
    });
    // One header, still on one line: the chip's name gives way with an ellipsis at the new width.
    const headers = screen.all().filter((r) => r.text.includes("· login"));
    expect(headers).toHaveLength(1);
    expect(headers[0]!.text).toMatch(/^┌ {3}Tidewater Studio .*… {2}· login$/);
  });

  it("redraws the progress bar in place: one bar, never a stack", async () => {
    const step = deferred<void>();
    const resized = deferred<void>();
    const { screen } = await run(
      { columns: 80, rows: 24, interactive: true },
      async (h) => {
        const done = updateApplyFlow(
          h.ctx,
          stubClient({
            update: {
              decide: async () => ({
                decision: {
                  action: "binary",
                  release: { version: "2.5.0" },
                  mandatory: false,
                },
                channel: "stable",
              }),
              install: async (
                _d: unknown,
                o: { onProgress(d: number, t: number): void },
              ) => {
                for (const d of [10, 20, 30]) o.onProgress(d, 100);
                step.resolve();
                await resized.promise;
                for (const d of [60, 80, 100]) o.onProgress(d, 100);
                return { kind: "restartRequired", version: "2.5.0" };
              },
            },
          }),
        );
        await step.promise;
        await settle();
        await h.screen.resize(50, 24);
        resized.resolve();
        await done;
      },
    );
    check("resize update", screen, [], {});
    const all = screen.all().map((r) => r.text);
    expect(all.filter((t) => t.includes("%"))).toHaveLength(1);
    expect(all.filter((t) => t.includes("· update apply"))).toHaveLength(1);
  });
});
