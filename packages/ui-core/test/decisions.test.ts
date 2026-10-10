// The design language as data (UI-KITS.md design language v2; the brief's "Minimum check"):
// over every row of ui-matrix.json, each state names its one primary (DL4), its refusal tone
// (DL6: `neutral` for a refusal the person can resolve), the slot its message sits in (DL7), its
// initial focus (DL9) and its link verdict (DL14). The expectations below are written from the
// rules, state by state, not read back from the models.

import { describe, expect, it } from "vitest";

import {
  coarsePointer,
  platformClass,
  type Platform,
  type UiInput,
  type View,
} from "../src/index.js";
import { readMatrix, run, withDefaults, type Row } from "./matrix.js";

const matrix = readMatrix();
const defaults = matrix.vocabulary.defaults;

type Expect = {
  primary: string | null;
  tone: "neutral" | "danger" | null;
  errorSlot: string | null;
  /** Leave out to expect DL9's default: the primary, else the heading. `null`: never focuses. */
  focus?: string | null;
};

const none: Expect = { primary: null, tone: null, errorSlot: null };
const quiet: Expect = { ...none, focus: null };
const refusal = (primary: string | null): Expect => ({
  primary,
  tone: "neutral",
  errorSlot: null,
});
const failed = (primary: string, errorSlot: string): Expect => ({
  primary,
  tone: "danger",
  errorSlot,
});

const desktop = (i: UiInput) => platformClass(i.platform ?? null) === "desktop";
const tvLike = (i: UiInput) => {
  const c = platformClass(i.platform ?? null);
  return c === "tv" || c === "console";
};
const KEY = "part.keyField.label";
const SUBMIT = "activate.submit";

/** DL4, DL6, DL7 and DL9, state by state. */
const EXPECT: Record<string, (input: UiInput) => Expect> = {
  // The gate routes: the screens it hands to own the controls; it never takes focus itself.
  "PolarisKeyGate.booting": () => quiet,
  "PolarisKeyGate.needs-activation": () => quiet,
  "PolarisKeyGate.licensed": () => quiet,
  "PolarisKeyGate.grace": () => quiet,
  "PolarisKeyGate.blocked": () => ({ ...quiet, tone: "neutral" }),
  "PolarisKeyGate.error": () => failed("common.tryAgain", "screen"),
  // Boot: no invented progress; the consent's download is the accent's one use.
  "Boot.progress": () => quiet,
  "Boot.fetching": () => quiet,
  "Boot.rolled-back": () => quiet,
  "Boot.consent": () => ({ ...none, primary: "boot.consent.download" }),
  "Boot.offline": (i) => ({
    ...none,
    primary:
      i.stage?.emit?.canPlayOffline === true
        ? "boot.continueOffline"
        : "common.tryAgain",
  }),
  "Boot.blocked": () => refusal("status.update"),
  "Boot.declined": () => refusal("common.tryAgain"),
  "Boot.error": () => failed("common.tryAgain", "screen"),
  // DL6: each blocking state is a neutral refusal whose fix is the primary.
  "StatusScreen.revoked": () => refusal("signin.key.differentKey"),
  "StatusScreen.expired": () => refusal("status.renew"),
  "StatusScreen.version-too-old": () => refusal("status.update"),
  // A fix the kit cannot reach is named in words: no primary, the heading takes focus.
  "StatusScreen.version-too-new": () => refusal(null),
  "StatusScreen.channel-not-entitled": () => refusal("status.switchChannel"),
  // A banner never takes focus.
  "GraceBanner.days-left": () => ({ ...quiet, primary: "common.reconnect" }),
  "GraceBanner.last-day": () => ({ ...quiet, primary: "common.reconnect" }),
  "GraceBanner.expired": () => ({ ...quiet, tone: "neutral" }),
  "Toast.info": () => quiet,
  "Toast.success": () => quiet,
  "Toast.warning": () => quiet,
  "Toast.error": () => ({ ...quiet, tone: "danger" }),
  "Toast.with-progress": () => quiet,
  // Welcome: Sign in on an empty Welcome; the only path when the build has one (DL4).
  "Welcome.default": () => ({ ...none, primary: "welcome.signIn" }),
  "Welcome.busy": () => ({ ...none, primary: "welcome.signIn" }),
  "Welcome.capability-limited": (i) => ({
    ...none,
    primary:
      i.capabilities?.signIn === false ||
      i.services?.includes("identity") === false
        ? "welcome.useKey"
        : "welcome.signIn",
  }),
  // Activate: Activate is the primary once there is a key; the field takes focus, never on a
  // coarse pointer; an input that is itself wrong is danger, a refused valid key is not.
  "Activate.empty": () => ({ ...none, primary: SUBMIT, focus: KEY }),
  "Activate.typing": () => ({ ...none, primary: SUBMIT, focus: KEY }),
  "Activate.parsed": () => ({ ...none, primary: SUBMIT, focus: KEY }),
  "Activate.cut-short": () => ({ ...failed(SUBMIT, KEY), focus: KEY }),
  "Activate.busy": () => ({ ...none, primary: SUBMIT }),
  "Activate.rejected": (i) => ({
    primary: SUBMIT,
    tone: i.activation ? "neutral" : "danger",
    errorSlot: KEY,
    focus: KEY,
  }),
  "Activate.device-limit": (i) => ({
    primary: i.activation?.manageUrl ? "deviceLimit.title" : null,
    tone: "neutral",
    errorSlot: KEY,
  }),
  "Activate.done": () => none,
  "OfflineActivation.default": () => ({
    ...none,
    primary: "offlineActivation.copyCode",
  }),
  "OfflineActivation.loaded": (i) =>
    i.offline?.submitted && !i.offline.file
      ? failed("offlineActivation.submit", "offlineActivation.submit")
      : { ...none, primary: "offlineActivation.submit" },
  "OfflineActivation.rejected-signature": () =>
    failed("offlineActivation.loadFile", "offlineActivation.loadFile"),
  "OfflineActivation.done": () => none,
  // SignIn: the first sign-in method; Open browser again while waiting; errors under Sign in.
  "SignIn.methods": (i) => ({
    ...none,
    primary: desktop(i)
      ? "signin.desktop.continue"
      : "signin.provider.continue",
  }),
  "SignIn.error": (i) => {
    const m = desktop(i)
      ? "signin.desktop.continue"
      : "signin.provider.continue";
    return failed(m, m);
  },
  "SignIn.handoff": () => ({ ...none, primary: "signin.handoff.again" }),
  "SignIn.code": () => quiet,
  "SignIn.finishing": () => quiet,
  "SignIn.choose": () => quiet,
  "SignIn.replace": (i) => ({
    ...none,
    primary:
      i.platform?.os === "web"
        ? "signin.replace.open"
        : "signin.replace.openSystem",
  }),
  "SignIn.key": (i) => ({
    primary: SUBMIT,
    tone: i.activation ? "neutral" : null,
    errorSlot: i.activation ? KEY : null,
    focus: KEY,
  }),
  "SignIn.done": (i) =>
    i.signIn?.issuedNow === true && i.services?.includes("license") !== false
      ? { ...none, primary: "signin.done.start" }
      : quiet,
  "SignIn.expired": () => refusal("signin.again"),
  "SignInHandoff.starting": () => quiet,
  "SignInHandoff.waiting": () => ({ ...none, primary: "signin.handoff.again" }),
  "SignInHandoff.no-browser": () => refusal("signin.handoff.copyLink"),
  "SignInHandoff.link-copied": () => quiet,
  // A TV or a console never focuses a control that opens a browser: it has none.
  "SignInHandoff.code": (i) =>
    tvLike(i) ? none : { ...none, primary: "signin.handoff.openBrowser" },
  "SignInHandoff.finishing": () => quiet,
  // Denied, expired and failed keep a result with the action that starts again (DL7).
  "SignInHandoff.denied": () => failed("signInHandoff.newCode", "screen"),
  "SignInHandoff.expired": () => refusal("signInHandoff.newCode"),
  "SignInHandoff.cancelled": () => ({
    ...none,
    primary: "signInHandoff.newCode",
  }),
  // LicenseChoice: Continue; a full list is a neutral limit whose fix is the primary.
  "LicenseChoice.loading": () => quiet,
  "LicenseChoice.many": () => ({ ...none, primary: "signin.choice.continue" }),
  "LicenseChoice.one": () => ({ ...none, primary: "signin.choice.continue" }),
  "LicenseChoice.current": () => ({
    ...none,
    primary: "signin.choice.continue",
  }),
  "LicenseChoice.keep": () => ({ ...none, primary: "signin.choice.continue" }),
  "LicenseChoice.new": () => ({ ...none, primary: "signin.choice.continue" }),
  "LicenseChoice.create": () => ({
    ...none,
    primary: "signin.choice.continue",
  }),
  "LicenseChoice.mixed": () => ({ ...none, primary: "signin.choice.continue" }),
  "LicenseChoice.all-full": (i) =>
    refusal(
      i.choices?.create
        ? "signin.choice.create"
        : i.choices?.choices.some((r) => r.replace?.allowed)
          ? "signin.replace.open"
          : null,
    ),
  "LicenseChoice.replace-open": () => ({
    ...none,
    primary: "signin.replace.confirm",
  }),
  "LicenseChoice.raced": () => refusal("signin.choice.continue"),
  "LicenseChoice.none-keys": () => ({
    ...none,
    primary: "signin.choice.keyInstead",
  }),
  "LicenseChoice.none-no-keys": (i) => ({
    ...none,
    primary: i.choices?.getLicense?.purchaseUrl
      ? "signin.none.get"
      : "signin.none.otherAccount",
  }),
  "LicenseChoice.grant-expired": () => refusal("signin.again"),
  // DeviceLimit: Replace and continue is the fix of a neutral limit.
  "DeviceLimit.default": () => refusal("deviceLimit.primary"),
  "DeviceLimit.busy": () => ({ ...none, primary: "deviceLimit.primary" }),
  "DeviceLimit.removed": () => none,
  "DeviceLimit.failed": () => failed("common.tryAgain", "deviceLimit.primary"),
  "DeviceLimit.browser-mode": (i) =>
    refusal(tvLike(i) ? null : "deviceLimit.openBrowser"),
  // Devices: an embedded pane with row actions only; a failed load is a screen of its own.
  "Devices.loading": () => quiet,
  "Devices.list": () => none,
  "Devices.empty": () => none,
  "Devices.renaming": () => ({
    ...none,
    primary: "common.save",
    focus: "devices.renameLabel",
  }),
  "Devices.confirming": () => ({ ...none, primary: "devices.remove" }),
  "Devices.browser-mode": () => ({ ...none, primary: "devices.manage" }),
  "Devices.error": (i) =>
    failed(
      "common.tryAgain",
      i.edit?.kind === "rename"
        ? "devices.renameLabel"
        : i.edit?.kind === "remove"
          ? "devices.remove"
          : "screen",
    ),
  // Updates: the verb the outlet allows; a mandatory update has no dismissal.
  "UpdatePrompt.available": () => ({ ...none, primary: "update.install" }),
  "UpdatePrompt.downloading": () => ({
    ...none,
    primary: "update.restartWhenReady",
  }),
  "UpdatePrompt.ready": () => ({ ...none, primary: "update.restartNow" }),
  "UpdatePrompt.mandatory": () => ({ ...none, primary: "update.install" }),
  "UpdatePrompt.blocked": () => refusal(null),
  "UpdatePrompt.store": (i) => ({
    ...none,
    primary:
      {
        "app-store": "update.appStore",
        play: "update.googlePlay",
        testflight: "update.testflight",
        altstore: "update.altstore",
        steam: "update.steam",
      }[i.update?.outlet ?? ""] ?? "update.openStore",
  }),
  "UpdatePrompt.platform": () => none,
  "UpdatePrompt.revoked-required-content": () => refusal("update.install"),
  "UpdatePrompt.up-to-date": () => none,
  // Progress never takes focus.
  "UpdateProgress.queued": () => quiet,
  "UpdateProgress.downloading": () => quiet,
  "UpdateProgress.installing": () => quiet,
  "UpdateProgress.paused": () => ({
    ...quiet,
    primary: "updateProgress.resume",
  }),
  "UpdateProgress.failed": () => ({
    ...failed("common.tryAgain", "updateProgress.failed"),
    focus: null,
  }),
  "UpdateProgress.done": () => quiet,
  "ReleaseNotes.loading": () => quiet,
  "ReleaseNotes.list": () => none,
  "ReleaseNotes.empty": () => none,
  "ReleaseNotes.error": () => failed("common.tryAgain", "screen"),
  // Settings panes: no filled control until there is something to save.
  "AccountAndLicense.loading": () => quiet,
  "AccountAndLicense.signed-in": () => none,
  "AccountAndLicense.key-only": () => none,
  "AccountAndLicense.offline": () => none,
  "Settings.loading": () => quiet,
  "Settings.list": () => none,
  "Settings.locked": () => none,
  "Settings.dirty": () => ({ ...none, primary: "common.save", focus: null }),
  "Settings.saving": (i) => ({
    ...none,
    primary: "common.save",
    focus: i.pending === "save" ? "common.save" : null,
  }),
  "Settings.error": (i) =>
    failed(
      "common.tryAgain",
      i.edit?.kind === "value" ? "common.save" : "screen",
    ),
  // The paywall: the platform's store, else the portal; never invented checkout.
  "Paywall.loading": () => quiet,
  "Paywall.offers": (i) => ({
    ...none,
    primary:
      i.capabilities?.purchase &&
      (i.platform?.os === "ios" || i.platform?.os === "android")
        ? "paywall.upgrade"
        : "paywall.portal",
  }),
  "Paywall.purchasing": (i) => ({
    ...none,
    primary:
      i.capabilities?.purchase &&
      (i.platform?.os === "ios" || i.platform?.os === "android")
        ? "paywall.upgrade"
        : "paywall.portal",
  }),
  "Paywall.purchased": () => ({ ...none, primary: "common.done" }),
  "Paywall.restore": () => quiet,
  "Paywall.not-available": () => refusal(null),
  "EntitlementGate.entitled": () => quiet,
  "EntitlementGate.loading": () => quiet,
  "EntitlementGate.not-entitled": (i) => ({
    ...quiet,
    primary:
      i.services?.includes("license") === false ? null : "entitlement.unlock",
  }),
};

/** DL9: the primary, else the heading; a field never under a coarse pointer, and a TV or a
 *  console never focuses a control that opens a browser. */
function expectedFocus(e: Expect, platform: Platform | null): string | null {
  if (e.focus === null) return null;
  const target = e.focus ?? e.primary ?? "heading";
  if (
    (target === KEY || target === "devices.renameLabel") &&
    coarsePointer(platform)
  )
    return "heading";
  return target;
}

const FAMILIES = [
  "gate",
  "activate",
  "signIn",
  "deviceLimit",
  "devices",
  "update",
  "settings",
  "paywall",
] as const;

const rows = FAMILIES.flatMap((f) =>
  (matrix[f] as Row[]).map((r) => [f, r] as const),
).filter(([, r]) => r.expect.state !== "hidden");

describe("the design language as data, over every ui-matrix.json row", () => {
  it.each(rows.map(([f, r]) => [`${f}: ${r.name}`, r] as const))(
    "%s",
    (_n, row) => {
      const input = withDefaults(row.input, defaults);
      const view: View = run(row, defaults);
      const key = `${view.component}.${view.state}`;
      const rule = EXPECT[key];
      expect(rule, `no DL expectation for ${key}`).toBeDefined();
      const e = rule!(input);
      expect({
        primary: view.decisions.primary,
        tone: view.decisions.tone,
        errorSlot: view.decisions.errorSlot,
        focus: view.decisions.focus,
      }).toEqual({
        primary: e.primary,
        tone: e.tone,
        errorSlot: e.errorSlot,
        focus: expectedFocus(e, input.platform ?? null),
      });
    },
  );

  it("states a DL expectation for every must state the matrix reaches", () => {
    const reached = new Set(
      rows.map(([, r]) => `${r.expect.component}.${r.expect.state}`),
    );
    for (const k of reached) expect(EXPECT[k], k).toBeDefined();
  });
});

describe("DL6 and DL9 across the views", () => {
  it("a refusal the person can resolve is never drawn as an error, and its fix leads", () => {
    for (const [, row] of rows) {
      const view = run(row, defaults);
      if (view.decisions.tone !== "neutral") continue;
      expect(view.decisions.errorSlot, row.name).not.toBe("screen");
      // Its fix, when the kit can reach one, is the one primary and takes focus, or focus goes
      // to the field the refusal concerns (DL7).
      if (view.decisions.primary !== null)
        expect([
          view.decisions.primary,
          view.decisions.errorSlot,
          "heading",
          null,
        ]).toContain(view.decisions.focus);
    }
  });

  it("a TV or a console never focuses a control that opens a browser", () => {
    const openers = new Set([
      "signin.desktop.continue",
      "signin.email.continue",
      "signin.handoff.again",
      "signin.handoff.openBrowser",
      "deviceLimit.openBrowser",
      "devices.manage",
    ]);
    for (const [, row] of rows) {
      const input = withDefaults(row.input, defaults);
      if (!tvLike(input)) continue;
      const view = run(row, defaults);
      expect(openers.has(view.decisions.focus ?? ""), row.name).toBe(false);
    }
  });
});

describe("DL14: every link a state shows passed the one validating opener", () => {
  it("the code view's link, the replace link and the purchase link", () => {
    for (const [, row] of rows) {
      const input = withDefaults(row.input, defaults);
      const view = run(row, defaults);
      const link = view.decisions.link;
      if (!link) continue;
      expect(link.url === null || /^https:\/\//.test(link.url), row.name).toBe(
        true,
      );
      // A QR only where the device cannot browse (DL14 "Where").
      expect(link.qr, row.name).toBe(link.url !== null && tvLike(input));
      expect(link.open, row.name).toBe(link.url !== null && !tvLike(input));
    }
  });

  it("a QR is drawn only on a TV or a console, or for an offline request", () => {
    for (const [, row] of rows) {
      const input = withDefaults(row.input, defaults);
      const view = run(row, defaults);
      if (view.copy.includes("a11y.qr"))
        expect(tvLike(input), row.name).toBe(true);
      if (view.decisions.qr && view.component !== "OfflineActivation")
        expect(tvLike(input), row.name).toBe(true);
    }
  });
});
