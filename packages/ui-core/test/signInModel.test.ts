// @pkey-feature ui.signin
//
// SignInModel drives the SDK primitives of plans/I-04.md §G.9 through the one form
// (SIGN-IN.md §3.17): methods → handoff | code → finishing → choose ↔ replace | key → done, and
// back to methods on Cancel. A fake SDK stands in for I-10a's primitives.

import { describe, expect, it } from "vitest";

import {
  SignInModel,
  type ChoiceComplete,
  type LicenseChoiceInput,
  type LicenseChoiceView,
  type ReplaceView,
  type SignInPrimitives,
  type SignInWait,
} from "../src/index.js";

const MAC = { os: "macos", formFactor: "mac" } as const;
const PRESENTATION = {
  name: "Tidewater Studio",
  developerName: "Harbor Audio",
  icon: true,
};

const VIEW: LicenseChoiceView = {
  state: "choose",
  choices: [
    {
      id: "lic_pro",
      tierName: "Pro",
      name: null,
      origin: "purchase",
      access: "seats",
      seats: { used: 1, limit: 3 },
      current: false,
      expiresAt: null,
      state: "free",
      replace: null,
      freeDeviceUrl: null,
    },
    {
      id: "lic_edu",
      tierName: "Edu",
      name: "Fennick Studio Edu",
      origin: "developer",
      access: "seats",
      seats: { used: 3, limit: 3 },
      current: false,
      expiresAt: 1798761600,
      state: "full",
      replace: { allowed: true, retryAfter: null },
      freeDeviceUrl:
        "https://key.plrs.im/#/p/tidewater/free-device?license=lic_edu",
    },
  ],
  keep: false,
  preselected: "lic_pro",
  create: null,
  getLicense: null,
};

const REPLACE: ReplaceView = {
  licenseId: "lic_edu",
  seats: { used: 3, limit: 3 },
  devices: [
    {
      id: "dev_work",
      label: "Work laptop",
      platform: "windows",
      deviceType: "computer",
      lastSeen: 1758240000,
      leastRecent: true,
      activeNow: false,
      thisBrowser: false,
    },
  ],
  replace: { allowed: true, retryAfter: null },
};

/** A scripted fake SDK: `wait()` answers the queued outcomes in order, then stays pending. */
function fakeSdk(waits: SignInWait[], complete: ChoiceComplete[] = []) {
  const calls: string[] = [];
  const queue = [...waits];
  let release: (() => void) | null = null;
  const primitives: SignInPrimitives = {
    async start(o) {
      calls.push(`start ${o.channel} ${o.licenseChoice}`);
      return {
        browserOpened: true,
        ...(o.channel === "device-code"
          ? {
              deviceCode: {
                phase: "waiting" as const,
                secondsLeft: 600,
                userCode: "WDJB-MJHT",
              },
            }
          : {}),
        async wait() {
          const next = queue.shift();
          if (next) return next;
          await new Promise<void>((r) => (release = r));
          return { outcome: "cancelled" };
        },
        reopen() {
          calls.push("reopen");
          return true;
        },
        cancel() {
          calls.push("cancel");
          release?.();
        },
      };
    },
    choice: {
      async licenses() {
        calls.push("licenses");
        return VIEW;
      },
      async devices(_g, licenseId) {
        calls.push(`devices ${licenseId}`);
        return REPLACE;
      },
      async complete(grant, choice: LicenseChoiceInput) {
        calls.push(`complete ${grant} ${JSON.stringify(choice)}`);
        return complete.shift() ?? { outcome: "signedIn", issuedNow: false };
      },
      async cancel(grant) {
        calls.push(`choice.cancel ${grant}`);
      },
    },
    async activate(key) {
      calls.push(`activate ${key.slice(0, 5)}`);
      return { result: "ok" };
    },
  };
  return { primitives, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const states = (m: SignInModel) => {
  const v = m.views();
  return [v.signIn.state, v.handoff.state, v.licenseChoice.state];
};

describe("SignInModel: the one form over the SDK primitives", () => {
  it("starts on methods, and an inline form chooses the license in the app", async () => {
    const sdk = fakeSdk([
      { outcome: "pending" },
      { outcome: "choose", grant: "sg_1", choices: VIEW },
    ]);
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC, presentation: PRESENTATION },
    });
    expect(states(m)).toEqual(["methods", "starting", "hidden"]);
    const started = m.start();
    expect(m.views().signIn.state).toBe("handoff");
    await started;
    await tick();
    expect(sdk.calls[0]).toBe("start browser app");
    expect(states(m)).toEqual(["choose", "starting", "many"]);
    m.select("lic_pro");
    await m.continue();
    expect(sdk.calls).toContain(
      'complete sg_1 {"kind":"license","licenseId":"lic_pro"}',
    );
    // An existing license: the form closes and the app opens with the toast.
    expect(m.views().signIn.state).toBe("done");
    expect(m.views().signIn.copy).toEqual(["signin.desktop.toast"]);
  });

  it("a browser presentation leaves the choice to the card", async () => {
    const sdk = fakeSdk([{ outcome: "signedIn", issuedNow: true }]);
    const m = new SignInModel({
      primitives: sdk.primitives,
      presentation: "browser",
      base: { platform: MAC },
    });
    await m.start();
    await tick();
    expect(sdk.calls[0]).toBe("start browser card");
    expect(m.views().signIn.copy).toEqual([
      "signin.done.start",
      "signin.return.signedInShort",
    ]);
  });

  it("Replace a device opens in place, confirms, and recovers from a race", async () => {
    const sdk = fakeSdk(
      [{ outcome: "choose", grant: "sg_2", choices: VIEW }],
      [{ outcome: "raced" }, { outcome: "signedIn", issuedNow: false }],
    );
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    await m.start();
    await tick();
    await m.openReplace("lic_edu");
    expect(states(m)).toEqual(["replace", "starting", "replace-open"]);
    await m.confirmReplace("dev_work");
    expect(sdk.calls).toContain(
      'complete sg_2 {"kind":"license","licenseId":"lic_edu","replaceDeviceId":"dev_work"}',
    );
    // Someone took the seat: the view re-reads and says so.
    expect(m.views().licenseChoice.state).toBe("raced");
    expect(m.views().licenseChoice.copy).toEqual(["signin.replace.raced"]);
    m.back();
    await m.continue();
    expect(m.views().signIn.state).toBe("done");
  });

  it("replace: browser opens the card's Replace instead of the list", async () => {
    const sdk = fakeSdk([{ outcome: "choose", grant: "sg_3", choices: VIEW }]);
    const m = new SignInModel({
      primitives: sdk.primitives,
      replace: "browser",
      base: { platform: MAC },
    });
    await m.start();
    await tick();
    await m.openReplace("lic_edu");
    expect(sdk.calls.some((c) => c.startsWith("devices"))).toBe(false);
    expect(m.views().signIn.actions).toEqual(["replace-in-browser"]);
  });

  it("Use a license key instead keeps the account, and a key activated now is Done", async () => {
    const sdk = fakeSdk([{ outcome: "choose", grant: "sg_4", choices: VIEW }]);
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    await m.start();
    await tick();
    m.haveKey();
    expect(m.views().signIn.state).toBe("key");
    await m.submitKey("pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpbG");
    expect(m.views().signIn.copy).toEqual([
      "signin.done.start",
      "signin.return.signedInShort",
    ]);
  });

  it("a device-code sign-in shows the code, finishes on the card and never chooses here", async () => {
    const sdk = fakeSdk([
      {
        outcome: "pending",
        deviceCode: { phase: "slow-down", secondsLeft: 500 },
      },
      { outcome: "signedIn", issuedNow: false },
    ]);
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: { os: "android", formFactor: "tv" } },
    });
    const started = m.start({ channel: "device-code" });
    expect(m.views().handoff.state).toBe("starting");
    await started;
    expect(sdk.calls[0]).toBe("start device-code card");
    expect(m.views().handoff.state).toBe("code");
    expect(m.views().handoff.args.code).toBe("WDJB-MJHT");
    await tick();
    expect(m.views().signIn.state).toBe("done");
    expect(m.views().licenseChoice.state).toBe("hidden");
  });

  it("Cancel goes back to step 1 with no error, and drops a late answer", async () => {
    const sdk = fakeSdk([{ outcome: "pending" }]);
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    await m.start();
    await tick();
    expect(m.views().handoff.state).toBe("waiting");
    await m.reopen();
    expect(sdk.calls).toContain("reopen");
    await m.cancel();
    await tick();
    expect(states(m)).toEqual(["methods", "cancelled", "hidden"]);
    expect(m.views().signIn.decisions.tone).toBeNull();
  });

  it("a lapsed grant shows Sign in again", async () => {
    const timers: (() => void)[] = [];
    const sdk = fakeSdk([
      { outcome: "choose", grant: "sg_5", choices: VIEW, expiresIn: 300 },
    ]);
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
      schedule: (fn) => {
        timers.push(fn);
        return () => {};
      },
    });
    await m.start();
    await tick();
    timers.forEach((t) => t());
    expect(m.views().licenseChoice.state).toBe("grant-expired");
    expect(m.views().licenseChoice.actions).toEqual(["retry"]);
  });

  it("a failed Continue never leaves the form redeeming", async () => {
    const sdk = fakeSdk([{ outcome: "choose", grant: "sg_6", choices: VIEW }]);
    sdk.primitives.choice!.complete = async () => {
      throw new Error("network");
    };
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    await m.start();
    await tick();
    await m.continue();
    expect(m.snapshot.session.redeeming).toBe(false);
    expect(m.views().signIn.state).toBe("error");
  });

  it("a second start ends the first request, and Use a code never flashes cancelled", async () => {
    const sdk = fakeSdk([]);
    const seen: string[] = [];
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    await m.start();
    await m.start();
    await tick();
    expect(sdk.calls.filter((c) => c === "cancel")).toHaveLength(1);
    m.subscribe(() => seen.push(m.views().handoff.state));
    await m.useCode();
    await tick();
    expect(seen).not.toContain("cancelled");
    expect(m.views().handoff.state).toBe("code");
  });

  it("delivers each snapshot through the UI-thread hook, as plain data", async () => {
    const delivered: unknown[] = [];
    const queue: (() => void)[] = [];
    const sdk = fakeSdk([{ outcome: "pending" }]);
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
      deliver: (fn) => queue.push(fn),
    });
    m.subscribe((s) => delivered.push(s));
    await m.start();
    expect(delivered).toEqual([]);
    queue.splice(0).forEach((f) => f());
    expect(delivered.length).toBeGreaterThan(0);
    // A Node main process sends views over a bridge: they survive JSON as they are.
    const views = m.views();
    expect(JSON.parse(JSON.stringify(views))).toEqual(views);
  });
});
