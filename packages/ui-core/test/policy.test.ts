// The model-side policies: DL14's link opener and QR rule, DL7's loading delay as a model timer,
// the store with its UI-thread delivery hook, and the copy formatter's edges.

import { describe, expect, it } from "vitest";

import {
  Copy,
  DELAYED_LOADING_STATES,
  LOADING_DELAY_MS,
  LOADING_DELAY_WINDOW,
  codeExpired,
  countdown,
  createStore,
  displayLink,
  formatMessage,
  linkVerdict,
  loadingVisible,
  parseMessage,
  qrAllowed,
  resolveLocale,
  startLoadingTimer,
  validLink,
  viewOf,
  ViewModel,
  type Platform,
} from "../src/index.js";
import { readMatrix } from "./matrix.js";

const MAC: Platform = { os: "macos", formFactor: "mac" };
const PHONE: Platform = { os: "ios", formFactor: "iphone" };
const TV: Platform = { os: "android", formFactor: "tv" };
const CONSOLE: Platform = { os: "linux", formFactor: "tv" };

describe("DL14: links fail closed", () => {
  it.each([
    ["https://key.plrs.im/device", "https://key.plrs.im/device"],
    ["http://localhost:8787/signin", "http://localhost:8787/signin"],
    ["http://127.0.0.1/x", "http://127.0.0.1/x"],
    ["driftkart.gg/tv", "https://driftkart.gg/tv"],
    ["http://key.plrs.im/device", null],
    ["javascript:alert(1)", null],
    ["https://user:pass@key.plrs.im/", null],
    ["https://key.plrs.im/ device", null],
    ["https://key.plrs.im\\@evil.example/", null],
    ["ftp://key.plrs.im/", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("%s → %s", (raw, want) => {
    expect(validLink(raw)).toBe(want);
  });

  it("shows a link without its scheme", () => {
    expect(displayLink("https://key.plrs.im/device/")).toBe(
      "key.plrs.im/device",
    );
  });

  it("draws a QR only where the device cannot browse, or for an offline request", () => {
    for (const purpose of ["sign-in", "replace-device", "manage"] as const) {
      expect(qrAllowed(MAC, purpose)).toBe(false);
      expect(qrAllowed(PHONE, purpose)).toBe(false);
      expect(qrAllowed({ os: "android", formFactor: "tablet" }, purpose)).toBe(
        false,
      );
      expect(qrAllowed({ os: "web", formFactor: "computer" }, purpose)).toBe(
        false,
      );
      expect(qrAllowed(TV, purpose)).toBe(true);
      expect(qrAllowed(CONSOLE, purpose)).toBe(true);
    }
    expect(qrAllowed(PHONE, "offline-request")).toBe(true);
    expect(qrAllowed(TV, "purchase")).toBe(false);
  });

  it("opens a valid link only where the device browses, and hides an invalid one entirely", () => {
    expect(linkVerdict("https://key.plrs.im/tv", TV, "sign-in")).toEqual({
      purpose: "sign-in",
      url: "https://key.plrs.im/tv",
      display: "key.plrs.im/tv",
      open: false,
      qr: true,
    });
    expect(linkVerdict("https://key.plrs.im/device", MAC, "sign-in").open).toBe(
      true,
    );
    expect(linkVerdict("http://evil.example/", MAC, "sign-in")).toEqual({
      purpose: "sign-in",
      url: null,
      display: null,
      open: false,
      qr: false,
    });
  });

  it("an invalid manageUrl hides Replace a device and names the fix in words", () => {
    const view = viewOf("Activate", {
      activation: {
        result: "device-limit",
        limit: 3,
        deviceCount: 3,
        manageUrl: "http://evil.example/free",
      },
    });
    expect(view.copy).toContain("deviceLimit.noManage");
    expect(view.decisions.primary).toBeNull();
    expect(view.decisions.link?.url).toBeNull();
  });

  it("the code view switches to expired at 0:00 while any poll finishes", () => {
    expect(codeExpired(undefined)).toBe(false);
    expect(codeExpired(1)).toBe(false);
    expect(codeExpired(0)).toBe(true);
    const signIn = {
      presentation: "inline",
      replace: "inline",
      channel: "device-code",
    } as const;
    expect(
      viewOf("SignInHandoff", {
        platform: MAC,
        signIn,
        deviceCode: { phase: "waiting", secondsLeft: 0 },
      }).state,
    ).toBe("expired");
    expect(
      viewOf("SignInHandoff", {
        platform: MAC,
        signIn,
        deviceCode: { phase: "waiting", secondsLeft: 1 },
      }).state,
    ).toBe("code");
    expect(countdown(252)).toBe("4:12");
    expect(countdown(-3)).toBe("0:00");
  });

  it("the QR, Copy and the text carry the same link", () => {
    const view = viewOf("SignInHandoff", {
      platform: TV,
      integrator: { deviceCodeUrl: "driftkart.gg/tv" },
      signIn: {
        presentation: "inline",
        replace: "inline",
        channel: "device-code",
      },
      deviceCode: { phase: "waiting", secondsLeft: 200, userCode: "WDJB-MJHT" },
    });
    expect(view.decisions.link?.url).toBe("https://driftkart.gg/tv");
    expect(view.args.url).toBe("driftkart.gg/tv");
    expect(view.args.code).toBe("WDJB-MJHT");
  });
});

describe("DL7: the loading delay is a model timer", () => {
  it("sits inside the 250-300 ms window ui-matrix.json pins", () => {
    const window = readMatrix().vocabulary.loadingDelay as {
      min: number;
      max: number;
    };
    expect(LOADING_DELAY_WINDOW).toEqual({ min: window.min, max: window.max });
    expect(LOADING_DELAY_MS).toBeGreaterThanOrEqual(window.min);
    expect(LOADING_DELAY_MS).toBeLessThanOrEqual(window.max);
  });

  it("delays the loading states ui-matrix.json names", () => {
    const window = readMatrix().vocabulary.loadingDelay as { states: string[] };
    expect([...DELAYED_LOADING_STATES]).toEqual(window.states);
  });

  it("shows nothing before the delay, the label after it", () => {
    expect(loadingVisible(0)).toBe(false);
    expect(loadingVisible(LOADING_DELAY_MS - 1)).toBe(false);
    expect(loadingVisible(LOADING_DELAY_MS)).toBe(true);
    expect(loadingVisible(undefined)).toBe(true);
    expect(viewOf("Devices", { loading: true, elapsedMs: 10 }).copy).toEqual(
      [],
    );
    expect(viewOf("Devices", { loading: true, elapsedMs: 300 }).copy).toEqual([
      "common.loading",
      "devices.title",
    ]);
  });

  it("fires once, at the delay, and never after stop()", () => {
    let t = 0;
    const pending: { fn: () => void; at: number }[] = [];
    const schedule = (fn: () => void, ms: number) => {
      const job = { fn, at: t + ms };
      pending.push(job);
      return () => pending.splice(pending.indexOf(job), 1);
    };
    const advance = (ms: number) => {
      t += ms;
      for (const j of [...pending])
        if (j.at <= t) {
          pending.splice(pending.indexOf(j), 1);
          j.fn();
        }
    };
    let shown = 0;
    const timer = startLoadingTimer(() => shown++, { schedule, now: () => t });
    advance(100);
    expect(timer.visible).toBe(false);
    expect(loadingVisible(timer.elapsed())).toBe(false);
    advance(150);
    expect(timer.visible).toBe(true);
    expect(shown).toBe(1);
    expect(loadingVisible(timer.elapsed())).toBe(true);

    const stopped = startLoadingTimer(() => shown++, {
      schedule,
      now: () => t,
    });
    stopped.stop();
    advance(1000);
    expect(shown).toBe(1);
  });

  it("refuses a delay outside DL7's window", () => {
    expect(() => startLoadingTimer(() => {}, { delayMs: 100 })).toThrow(
      RangeError,
    );
    expect(() => startLoadingTimer(() => {}, { delayMs: 400 })).toThrow(
      RangeError,
    );
  });
});

describe("the store and its UI-thread hook", () => {
  it("delivers each change through the hook, and nothing for an equal snapshot", () => {
    const queued: (() => void)[] = [];
    const store = createStore({ n: 0 }, { deliver: (fn) => queued.push(fn) });
    const seen: number[] = [];
    const off = store.subscribe((s) => seen.push(s.n));
    store.set({ n: 1 });
    store.set((s) => s);
    expect(seen).toEqual([]);
    expect(queued).toHaveLength(1);
    queued.shift()!();
    expect(seen).toEqual([1]);
    off();
    store.set({ n: 2 });
    queued.shift()!();
    expect(seen).toEqual([1]);
    expect(store.get()).toEqual({ n: 2 });
  });
});

describe("the copy formatter", () => {
  const tables = {
    en: {
      "devices.count": "{count, plural, one {# device} other {# devices}}",
      "part.thisDeviceTitle":
        "{formFactor, select, iphone {This iPhone} mac {This Mac} other {This device}}",
      "welcome.title": "Welcome to {product}",
      "core.fallback.title": "Something went wrong",
      "core.fallback.message": "Error code: {code}",
    },
    de: { "welcome.title": "Willkommen bei {product}" },
  };

  it("formats the ICU subset: plain arguments, one plural, the formFactor select", () => {
    expect(formatMessage(tables.en["devices.count"], { count: 1 })).toBe(
      "1 device",
    );
    expect(formatMessage(tables.en["devices.count"], { count: 1000000 })).toBe(
      "1000000 devices",
    );
    expect(
      formatMessage(tables.en["part.thisDeviceTitle"], { formFactor: "mac" }),
    ).toBe("This Mac");
    expect(
      formatMessage(tables.en["part.thisDeviceTitle"], { formFactor: "watch" }),
    ).toBe("This device");
    expect(formatMessage("Hello {name}", {})).toBe("Hello {name}");
  });

  it("refuses anything outside the subset", () => {
    expect(() =>
      parseMessage("{a, plural, one {{b, select, x {y}}}}"),
    ).toThrow();
    expect(() => parseMessage("{1abc}")).toThrow();
  });

  it("looks a key up in the locale, then English, and names an unknown code's fallback", () => {
    const de = new Copy({ tables, locale: "de-AT" });
    expect(de.locale).toBe("de");
    expect(de.format("welcome.title", { product: "Tidewater" })).toBe(
      "Willkommen bei Tidewater",
    );
    expect(de.format("devices.count", { count: 2 })).toBe("2 devices");
    expect(de.format("core.codes.never_heard_of_it.title")).toBe(
      "Something went wrong",
    );
    expect(de.format("core.codes.never_heard_of_it.message")).toBe(
      "Error code: never_heard_of_it",
    );
    expect(() => de.format("welcome.nope")).toThrow(/no catalog string/);
    expect(new Copy({ tables, locale: "sv" }).locale).toBe("en");
  });

  it("maps POSIX and BCP 47 locales onto the launch locales", () => {
    expect(resolveLocale("pt_PT.UTF-8")).toBe("pt-BR");
    expect(resolveLocale("zh-TW")).toBe("en");
    expect(resolveLocale("zh-CN")).toBe("zh-Hans");
    expect(resolveLocale("ja_JP")).toBe("ja");
    expect(resolveLocale(undefined)).toBe("en");
  });

  it("turns a view into its strings, the plain renderer's {key, args} made text", () => {
    const view = viewOf("Devices", {
      devices: [
        {
          name: "Work laptop",
          platform: "windows",
          formFactor: "computer",
          lastSeenDays: 2,
          current: false,
        },
      ],
    });
    const copy = new Copy({
      tables: {
        en: {
          ...tables.en,
          ...Object.fromEntries(
            view.copy.map((k) => [
              k,
              k === "devices.count" ? tables.en["devices.count"] : k,
            ]),
          ),
        },
      },
    });
    expect(copy.strings(view)["devices.count"]).toBe("1 device");
  });
});

describe("ViewModel: a component's view as a live value", () => {
  it("runs DL7's delay itself: nothing before it, the label after, the list when loaded", () => {
    let t = 0;
    const fired: (() => void)[] = [];
    const delivered: string[] = [];
    const m = new ViewModel(
      "Devices",
      { loading: true },
      {
        now: () => t,
        schedule: (fn) => {
          fired.push(fn);
          return () => {};
        },
      },
    );
    m.subscribe((v) => delivered.push(`${v.state}:${v.copy.length}`));
    expect(m.view.state).toBe("loading");
    expect(m.view.copy).toEqual([]);
    t = 260;
    fired.splice(0).forEach((f) => f());
    expect(m.view.copy).toEqual(["common.loading", "devices.title"]);
    m.update({ loading: false, devices: [] });
    expect(m.view.state).toBe("empty");
    expect(delivered).toEqual(["loading:2", "empty:1"]);
    m.dispose();
  });

  it("marks the arguments that are someone's own text for an isolated run", () => {
    const v = viewOf("Welcome", {
      presentation: { name: "‮Tidewater", developerName: "Harbor", icon: true },
    });
    expect(v.isolate).toEqual(["developer", "product"]);
    expect(v.args.product).toBe("‮Tidewater");
  });
});
