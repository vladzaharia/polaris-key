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
import { DROP, type RailRow } from "../../src/cli/term/layout.js";
import { fitScreen, inlineHints } from "../../src/cli/term/screen.js";
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
      waitForSignIn: (_p: unknown, o: { signal?: AbortSignal } = {}) =>
        new Promise((resolve, reject) => {
          void gate.then(resolve, reject);
          o.signal?.addEventListener("abort", () =>
            reject(new Error("cancelled")),
          );
        }),
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
  want: {
    code?: string;
    url?: string;
    hints?: boolean;
    /** After a resize the terminal reflows what was already drawn, and the rows it pushed into its
     * scrollback keep the old width: only what is on the screen is held to the window's width. */
    viewportOnly?: boolean;
  },
): void {
  const all = screen.all();
  expect(
    (want.viewportOnly ? screen.viewport() : all)
      .filter((r) => r.wrapped)
      .map((r) => r.text),
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
  it("starts a URL that does not fit on a line of its own, each piece keeping the link, the lead-in with it", () => {
    const lines = wrapSpans(
      [
        { text: "On any phone or computer, go to " },
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
    // The short lead-in "go to" moves onto the URL's line.
    expect(lines[0]!.map((s) => s.text).join("")).toBe(
      "On any phone or computer,",
    );
    expect(lines[1]!.map((s) => s.text).join("")).toMatch(/^go to /);
    const pieces = lines.flatMap((l) => l.filter((s) => s.link));
    expect(pieces.map((s) => s.text).join("")).toBe(shown(LONG.url));
    expect(pieces.every((s) => s.link === LONG.url)).toBe(true);
    expect(lines.flat().some((s) => s.text.includes("…"))).toBe(false);
  });
  it("moves a keep-unit to the next line whole and drops the separator before it", () => {
    const line = (spans: unknown[]) =>
      wrapSpans(spans as never, 37).map((l) => l.map((s) => s.text).join(""));
    expect(
      line([
        { text: "License   " },
        { text: "Pro license" },
        { text: " · ", style: ["muted"] },
        { text: "mara@fennick.studio", unit: true },
      ]),
    ).toEqual(["License   Pro license", "mara@fennick.studio"]);
    // A keep-unit never splits when it fits a line of its own.
    expect(
      line([
        { text: "Signed in as " },
        { text: "Mara Fennick", unit: true },
        { text: " · ", style: ["muted"] },
        { text: "mara@fennick.studio", unit: true },
      ]),
    ).toEqual(["Signed in as Mara Fennick", "mara@fennick.studio"]);
  });
  it("does not open an empty line before a code that follows an indent", () => {
    const lines = wrapSpans(
      [{ text: "   " }, { text: " WDJB-MJHT-QXRP-LMNV ", break: "code" }],
      12,
    ).map((l) => l.map((s) => s.text).join(""));
    expect(lines[0]!.trim()).not.toBe("");
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

describe("a live screen taller than the terminal", () => {
  const text = (rows: readonly RailRow[]) =>
    rows.map((r) => r.spans.map((x) => x.text).join(""));
  const row = (t: string, drop?: number): RailRow => ({
    mark: "none",
    spans: [{ text: t }],
    ...(drop === undefined ? {} : { drop }),
  });
  const fit = (rows: RailRow[], max: number) =>
    fitScreen(rows, {
      maxRows: max,
      columns: 40,
      separator: "·",
      render: text,
    }).lines;

  it("is laid out spaced when it fits, and compacts in tier order when it does not", () => {
    const rows = [
      row("header"),
      row("", DROP.blankProse),
      row("go to url"),
      row("", DROP.blankCode),
      row("CODE"),
      row("", DROP.blankCode),
      row("check", DROP.checkLine),
      row("expires", DROP.countdown),
      row("hints"),
    ];
    expect(fit(rows, 9)).toHaveLength(9);
    // Blank rows between prose go first, then the check line, then the blanks around the code.
    expect(fit(rows, 8)).toHaveLength(8);
    expect(fit(rows, 8)).toEqual([
      "header",
      "go to url",
      "",
      "CODE",
      "",
      "check",
      "expires",
      "hints",
    ]);
    expect(fit(rows, 6)).not.toContain("check");
    expect(fit(rows, 6)).toContain("expires");
    expect(fit(rows, 5)).toEqual(
      ["header", "go to url", "CODE", "expires", "hints"].slice(0, 5),
    );
    // Never the URL line, the code or the hints; the top lines leave the view last.
    expect(fit(rows, 3)).toEqual(["go to url", "CODE", "hints"]);
  });

  it("puts the key hints on the spinner line when the joined line fits", () => {
    const spinner: RailRow = {
      mark: "rail",
      spans: [{ text: "Waiting" }],
      role: "spinner",
    };
    const hints: RailRow = {
      mark: "rail",
      spans: [{ text: "Esc cancel" }],
      role: "hints",
    };
    const joined = inlineHints([row("a"), spinner, hints], 80, "·");
    expect(joined).toHaveLength(2);
    expect(joined[1]!.spans.map((x) => x.text).join("")).toBe(
      "Waiting · Esc cancel",
    );
    // Too narrow: left as two rows.
    expect(inlineHints([row("a"), spinner, hints], 12, "·")).toHaveLength(3);
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
          // The screen is laid out spaced when it fits; it compacts only when it does not.
          if (rows >= 24 && columns >= 60 && values === SHORT)
            expect(
              snaps[0]!.filter((r) => r.text === "│").length,
            ).toBeGreaterThan(0);
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
          // The finished block replaces the bar: ready, the size, then what to do next.
          expect(text).toContain("2.5.0 is ready · 61 MB");
          expect(text).toContain("Restart to finish updating.");
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

describe("a window dragged through several sizes mid-flow", () => {
  const drags: Array<[string, Array<[number, number]>]> = [
    ["80x24 → 40x12", [[40, 12]]],
    ["120x40 → 40x12", [[40, 12]]],
    ["60x24 → 60x10", [[60, 10]]],
    ["80x24 → 80x12", [[80, 12]]],
    ["40x12 → 120x40", [[120, 40]]],
    [
      "80x24 → 32x10 → 110x30",
      [
        [32, 10],
        [110, 30],
      ],
    ],
  ];
  const start = (name: string): [number, number] => {
    const [c, r] = name.split(" → ")[0]!.split("x").map(Number);
    return [c!, r!];
  };
  for (const [name, steps] of drags)
    for (const values of [SHORT, LONG])
      it(`${name}, ${values === LONG ? "long" : "short"} values: one screen, nothing wider than the window, the URL and the code whole`, async () => {
        const [columns, rows] = start(name);
        const gate = deferred<unknown>();
        const { screen, snaps } = await run(
          { columns, rows, values, interactive: true },
          async (h) => {
            const done = loginFlow(h.ctx, signInClient(values, gate.promise), {
              deviceCode: true,
            });
            await settle();
            for (const [c, r] of steps) {
              await h.screen.resize(c, r);
              await settle();
            }
            await h.snap();
            gate.resolve({ status: "expired" });
            await done;
          },
        );
        const last = steps.at(-1)!;
        // Fits the final window: only as many rows as it has, nothing soft-wrapped anywhere.
        expect(snaps[0]!.length).toBeLessThanOrEqual(last[1]);
        check(
          `${name} ${values === LONG ? "long" : "short"}`,
          screen,
          snaps[0]!,
          {
            code: values.code,
            url: values.url,
            hints: true,
            viewportOnly: true,
          },
        );
        // One header at most while it is up; and after the outcome exactly one, no fragment left.
        expect(
          snaps[0]!.filter((r) => r.text.startsWith("┌")).length,
        ).toBeLessThanOrEqual(1);
        const end = screen.all().map((r) => r.text);
        expect(end.filter((t) => t.startsWith("┌"))).toHaveLength(1);
        // Rows the terminal itself pushed into its scrollback while reflowing cannot be erased;
        // what is on the screen is only the result.
        expect(
          screen
            .viewport()
            .map((r) => r.text)
            .join("\n"),
        ).not.toContain("Waiting for you to sign in");
      });
});

describe("a flow's end states leave one result block under one header", () => {
  const outcomes: Array<[string, unknown, string]> = [
    ["expired", { status: "expired" }, "Code expired"],
    [
      "declined",
      { status: "error", message: "access_denied" },
      "Sign-in declined",
    ],
    [
      "signed in",
      {
        status: "ready",
        identity: { name: "Mara Fennick", email: "mara@fennick.studio" },
      },
      "Signed in as Mara Fennick",
    ],
  ];
  for (const [columns, rows] of [
    [40, 12],
    [32, 12],
    [40, 8],
    [80, 24],
  ] as const)
    for (const [label, result, title] of outcomes)
      it(`${label} at ${columns}×${rows}`, async () => {
        const gate = deferred<unknown>();
        const { screen } = await run(
          { columns, rows, values: LONG, interactive: true },
          async (h) => {
            const done = loginFlow(h.ctx, signInClient(LONG, gate.promise), {
              deviceCode: true,
            });
            await settle();
            gate.resolve(result);
            await done;
          },
        );
        const all = screen.all().map((r) => r.text);
        check(`${label} ${columns}x${rows}`, screen, screen.viewport(), {});
        expect(all.filter((t) => t.startsWith("┌")).length).toBeLessThanOrEqual(
          1,
        );
        expect(all.join("")).toContain(title.split(" ")[0]!);
        expect(all.join("\n")).not.toContain("Check the code there");
      });
  it("cancelling with Esc replaces the code view with the result and the verb that was run", async () => {
    const gate = deferred<unknown>();
    const { screen } = await run(
      { columns: 40, rows: 12, values: SHORT, interactive: true },
      async (h) => {
        const done = loginFlow(h.ctx, signInClient(SHORT, gate.promise), {
          deviceCode: true,
        });
        await settle();
        h.stdin.press("escape", { sequence: "\x1b" });
        await done;
      },
    );
    const text = screen
      .all()
      .map((r) => r.text)
      .join("\n");
    expect(text).toContain("Sign-in cancelled");
    expect(text).toMatch(/tidewater login\n└\s+Sign in again/);
    expect(text).not.toContain("WDJB-MJHT");
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
    // One header, still on one line: the verb suffix gives way first, then the name's end.
    const headers = screen.all().filter((r) => r.text.startsWith("┌"));
    expect(headers).toHaveLength(1);
    expect(headers[0]!.text).toMatch(/^┌ {3}Tidewater Studio .*… ?$/);
  });

  it("redraws the progress bar in place: one bar, never a stack", async () => {
    const step = deferred<void>();
    const resized = deferred<void>();
    const { screen, snaps } = await run(
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
        await settle();
        await h.snap();
        resized.resolve();
        await done;
      },
    );
    // Mid-download, after the resize: one bar, one header, nothing wider than the terminal.
    const mid = snaps[0]!.map((r) => r.text);
    expect(mid.filter((t) => t.includes("%"))).toHaveLength(1);
    expect(mid.filter((t) => t.includes("· update apply"))).toHaveLength(1);
    check("resize update", screen, snaps[0]!, {});
    // At the end the finished block replaced the bar, under the one header.
    const all = screen.all().map((r) => r.text);
    expect(all.filter((t) => t.includes("%"))).toHaveLength(0);
    expect(all.filter((t) => t.includes("· update apply"))).toHaveLength(1);
  });
});
