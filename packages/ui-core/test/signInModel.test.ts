// @pkey-feature ui.signin
//
// SignInModel drives the SDK primitives of plans/I-04.md §G.9 through the one form
// (SIGN-IN.md §3.17): methods → handoff | code → finishing → choose ↔ replace | key → done, and
// back to methods on Cancel. A fake SDK stands in for I-10a's primitives.

import { describe, expect, it } from "vitest";

import {
  activationFromOutcome,
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
      async complete(grant, choice: LicenseChoiceInput | undefined, opts) {
        calls.push(
          `complete ${grant} ${JSON.stringify(choice)}${
            opts?.consent ? ` consent ${opts.consent.claims.join(",")}` : ""
          }`,
        );
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

describe("UK-02b D3: the SDK's activation outcomes in the views' vocabulary", () => {
  it("maps the typed refusals and the key entries of an ok", () => {
    expect(
      activationFromOutcome({
        activation: {
          kind: "keyEntryLimit",
          manageUrl: "https://key.plrs.im/add",
          keyEntries: { used: 3, limit: 3 },
        },
      }),
    ).toEqual({
      result: "key-entry-limit",
      code: "key_entry_limit",
      manageUrl: "https://key.plrs.im/add",
      keyEntries: { used: 3, limit: 3 },
    });
    expect(
      activationFromOutcome({
        activation: {
          kind: "licenseOwned",
          code: "license_owned",
          signInUrl: "https://key.plrs.im/signin?product=tidewater",
        },
      }),
    ).toEqual({
      result: "refused",
      code: "license_owned",
      signInUrl: "https://key.plrs.im/signin?product=tidewater",
    });
    expect(
      activationFromOutcome({ kind: "ok", keyEntries: { used: 1, limit: 3 } }),
    ).toEqual({ result: "ok", keyEntries: { used: 1, limit: 3 } });
    expect(
      activationFromOutcome({
        activation: { kind: "deviceLimit", limit: 3, deviceCount: 3 },
      }),
    ).toEqual({ result: "device-limit", limit: 3, deviceCount: 3 });
    expect(activationFromOutcome(new Error("offline"))).toEqual({
      result: "error",
    });
  });

  it("a thrown refusal stays in the key step; Use a different key clears it", async () => {
    const sdk = fakeSdk([{ outcome: "choose", grant: "sg_9", choices: VIEW }]);
    sdk.primitives.activate = async () => {
      throw Object.assign(new Error("sign-in-failed"), {
        activation: {
          kind: "keyEntryLimit",
          manageUrl: "https://key.plrs.im/add",
        },
      });
    };
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    await m.start();
    await tick();
    m.haveKey();
    await m.submitKey("pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpbG");
    expect(m.snapshot.activation).toMatchObject({
      result: "key-entry-limit",
      manageUrl: "https://key.plrs.im/add",
    });
    expect(m.views().signIn.state).toBe("key-refused");
    m.differentKey();
    expect(m.snapshot.activation).toBeUndefined();
    expect(m.snapshot.keyField).toEqual({ text: "" });
  });

  it("an ok keeps its key entries in the snapshot for the toast", async () => {
    const sdk = fakeSdk([{ outcome: "choose", grant: "sg_8", choices: VIEW }]);
    sdk.primitives.activate = async () => ({
      result: "ok",
      keyEntries: { used: 1, limit: 3 },
    });
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    await m.start();
    await tick();
    m.haveKey();
    await m.submitKey("pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpbG");
    expect(m.snapshot.activation?.keyEntries).toEqual({ used: 1, limit: 3 });
    expect(m.views().signIn.state).toBe("done");
  });
});

describe("SignInModel: automatic sign-in (I-46.8)", () => {
  const CONFIRM = {
    kind: "confirm" as const,
    grant: "sg_c1",
    claims: ["email", "name"],
    input: {
      email: "maya@example.com",
      license: "existing" as const,
      alsoGets: true,
      anchor: {
        name: "Pro",
        term: "perpetual" as const,
        position: 2,
        limit: 3,
      },
    },
  };

  it("a confirm draws the consent lines; Continue completes with the claims", async () => {
    const sdk = fakeSdk([]);
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC, provider: "Google" },
    });
    m.presentAuto(CONFIRM);
    const v = m.views().signIn;
    expect(v.state).toBe("confirm");
    expect(v.copy).toContain("signin.consent.licenseLine");
    // The license line's arguments come from the consent view, not the kit.
    expect(v.args).toMatchObject({ license: "Pro", position: "2", limit: "3" });
    await m.confirm();
    expect(sdk.calls).toContain("complete sg_c1 undefined consent email,name");
    expect(m.views().signIn.state).toBe("done");
  });

  it("Use another account gives the grant up and shows the methods", async () => {
    const sdk = fakeSdk([]);
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    m.presentAuto(CONFIRM);
    await m.useAnother();
    expect(sdk.calls).toContain("choice.cancel sg_c1");
    expect(m.views().signIn.state).toBe("methods");
  });

  it("a license_choice_required answer after consent opens the license list", async () => {
    const sdk = fakeSdk([], [{ outcome: "choose", choices: VIEW }]);
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    m.presentAuto(CONFIRM);
    await m.confirm();
    expect(m.views().licenseChoice.state).toBe("many");
    expect(m.snapshot.autoSignIn).toBeUndefined();
  });

  it("a choose result opens the license list; a device limit with a list uses the card's Replace", () => {
    const m = new SignInModel({
      primitives: fakeSdk([]).primitives,
      base: { platform: MAC },
    });
    m.presentAuto({ kind: "choose", grant: "sg_2", choices: VIEW });
    expect(m.views().licenseChoice.state).toBe("many");
    const n = new SignInModel({
      primitives: fakeSdk([]).primitives,
      base: { platform: MAC },
    });
    n.presentAuto({ kind: "deviceLimit", view: VIEW });
    expect(n.snapshot.session.replace).toBe("browser");
    expect(n.views().licenseChoice.state).not.toBe("hidden");
  });

  it("a device limit with no list says so and offers the portal link", () => {
    const m = new SignInModel({
      primitives: fakeSdk([]).primitives,
      base: { platform: MAC },
    });
    m.presentAuto({ kind: "deviceLimit", manageUrl: "https://key.plrs.im/m" });
    // Its own step of the form, never the key screen.
    expect(m.snapshot.autoSignIn).toMatchObject({
      step: "device-limit",
      manageUrl: "https://key.plrs.im/m",
    });
    expect(m.snapshot.activation).toBeUndefined();
    expect(m.views().signIn.state).toBe("device-limit");
    expect(m.manageUrl).toBe("https://key.plrs.im/m");
  });

  it("after Replace opened the browser, coming back runs the provider sign-in once more", async () => {
    const sdk = fakeSdk([]);
    let asked = 0;
    sdk.primitives.autoSignIn = async () => {
      asked++;
      return asked === 1 ? { kind: "signedIn", issuedNow: false } : null;
    };
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    m.presentAuto({ kind: "deviceLimit", manageUrl: "https://key.plrs.im/m" });
    // Coming back without a Replace does nothing.
    await m.returned();
    expect(asked).toBe(0);
    m.leftToReplace();
    await m.returned();
    expect(asked).toBe(1);
    expect(m.snapshot.session.outcome).toBe("signedIn");
    // Once per Replace.
    await m.returned();
    expect(asked).toBe(1);
  });

  it("the provider's button asks the provider, then falls back to the browser sign-in", async () => {
    const sdk = fakeSdk([{ outcome: "pending" }]);
    let asked = 0;
    sdk.primitives.autoSignIn = async () => {
      asked++;
      return { kind: "needsSignIn" };
    };
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    await m.signInWithProvider();
    expect(asked).toBe(1);
    expect(sdk.calls[0]).toBe("start browser app");
  });

  it("an expired grant: Continue asks the provider again for a fresh one, busy meanwhile", async () => {
    const sdk = fakeSdk([], [{ outcome: "expired" }]);
    const fresh = { ...CONFIRM, grant: "sg_c2" };
    let release: (() => void) | null = null;
    let asked = 0;
    sdk.primitives.autoSignIn = async () => {
      asked++;
      await new Promise<void>((r) => (release = r));
      return fresh;
    };
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC, provider: "Google" },
    });
    m.presentAuto(CONFIRM);
    // complete answers invalid_grant: the confirm renews at once, never leaving a dead Continue.
    const first = m.confirm();
    await tick();
    expect(asked).toBe(1);
    expect(m.snapshot.session.redeeming).toBe(true);
    release!();
    await first;
    expect(m.snapshot.session.redeeming).toBe(false);
    expect(m.views().signIn.state).toBe("confirm");
    await m.confirm();
    expect(sdk.calls).toContain("complete sg_c2 undefined consent email,name");
    // The 300 s timer reaches the same state.
    let timer: (() => void) | null = null;
    const t = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC, provider: "Google" },
      schedule: (fn: () => void) => {
        timer = fn;
        return () => {};
      },
    });
    t.presentAuto(CONFIRM);
    timer!();
    expect(t.snapshot.session.grantExpired).toBe(true);
    const again = t.confirm();
    await tick();
    expect(asked).toBe(2);
    release!();
    await again;
    expect(t.snapshot.session.grantExpired).toBe(false);
  });

  it("a network failure on Continue keeps the confirm and its grant; Continue retries", async () => {
    const sdk = fakeSdk([]);
    const real = sdk.primitives.choice!.complete;
    let fail = true;
    sdk.primitives.choice!.complete = async (g, c, o) => {
      if (fail) {
        fail = false;
        throw new Error("offline");
      }
      return real(g, c, o);
    };
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC, provider: "Google" },
    });
    m.presentAuto(CONFIRM);
    await m.confirm();
    const v = m.views().signIn;
    expect(v.state).toBe("confirm");
    expect(v.copy).toContain("core.codes.network.message");
    expect(v.copy).toContain("signin.auto.confirm.primary");
    expect(v.decisions.primary).toBe("signin.auto.confirm.primary");
    expect(m.snapshot.session.redeeming).toBe(false);
    await m.confirm();
    expect(
      sdk.calls.filter((c) => c.startsWith("complete sg_c1")),
    ).toHaveLength(1);
    expect(m.views().signIn.state).toBe("done");
  });

  it("back from Replace with no account found lands on the methods, without a sign-in of its own", async () => {
    const sdk = fakeSdk([]);
    sdk.primitives.autoSignIn = async () => ({ kind: "needsSignIn" });
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    m.presentAuto({ kind: "deviceLimit", manageUrl: "https://key.plrs.im/m" });
    m.leftToReplace();
    await m.returned();
    expect(sdk.calls).toEqual([]);
    expect(m.views().signIn.state).toBe("methods");
  });

  it("the device limit with no link says one thing: sign out elsewhere", () => {
    const m = new SignInModel({
      primitives: fakeSdk([]).primitives,
      base: { platform: MAC },
    });
    m.presentAuto({ kind: "deviceLimit" });
    const copy = m.views().signIn.copy;
    expect(copy).toContain("deviceLimit.noManage");
    expect(copy).not.toContain("core.codes.device_limit.message");
  });

  it("the provider's button shows what the provider found", async () => {
    const sdk = fakeSdk([]);
    sdk.primitives.autoSignIn = async () => CONFIRM;
    const m = new SignInModel({
      primitives: sdk.primitives,
      base: { platform: MAC },
    });
    await m.signInWithProvider();
    expect(sdk.calls).toEqual([]);
    expect(m.views().signIn.state).toBe("confirm");
  });
});

/** The key step answers `license_owned`. */
function ownedKey(p: SignInPrimitives): void {
  p.activate = async () => {
    throw Object.assign(new Error("owned"), {
      activation: { kind: "licenseOwned", code: "license_owned" },
    });
  };
}

describe("SignInModel: a key with no account (UK-42.5)", () => {
  const KEY = "pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpbG";
  const BASE = {
    platform: MAC,
    services: ["license", "identity"],
    activateDone: {},
  } as const;

  it("a key with no grant ends at key-done and leaves the snapshot", async () => {
    const sdk = fakeSdk([]);
    const m = new SignInModel({ primitives: sdk.primitives, base: BASE });
    m.haveKey();
    await m.submitKey(KEY);
    expect(m.snapshot.session.step).toBe("key-done");
    expect(m.snapshot.session.outcome).toBeUndefined();
    expect(m.views().signIn.state).toBe("key-done");
    expect(m.views().signIn.component).toBe("SignIn");
    // The key is in memory only: not in the snapshot, nor in what the views read.
    expect(JSON.stringify(m.snapshot)).not.toContain(KEY);
    expect(JSON.stringify(m.input())).not.toContain(KEY);
    expect(sdk.calls.some((c) => c.startsWith("complete"))).toBe(false);
  });

  it("Done drops the key and closes the form", async () => {
    const sdk = fakeSdk([]);
    const m = new SignInModel({ primitives: sdk.primitives, base: BASE });
    await m.submitKey(KEY);
    expect((m as unknown as { heldKey: string | null }).heldKey).toBe(KEY);
    m.done();
    expect((m as unknown as { heldKey: string | null }).heldKey).toBeNull();
    expect(m.snapshot.session.step).toBeUndefined();
    expect(m.snapshot.session.outcome).toBe("signedIn");
  });

  it("key-done opens Add to account and back, and shows added", async () => {
    const m = new SignInModel({
      primitives: fakeSdk([]).primitives,
      base: { ...BASE, addToAccount: { step: "form" } },
    });
    await m.submitKey(KEY);
    m.openAttach();
    expect(m.snapshot.session.step).toBe("attach");
    m.closeAttach();
    expect(m.snapshot.session.step).toBe("key-done");
    m.openAttach();
    m.attached();
    expect(m.snapshot.session.step).toBe("added");
    expect(m.views().signIn.state).toBe("added");
  });

  it("license_owned, then sign-in, then choose, completes the key with no list", async () => {
    const sdk = fakeSdk(
      [{ outcome: "choose", grant: "sg_k", choices: VIEW }],
      [{ outcome: "signedIn", issuedNow: false }],
    );
    ownedKey(sdk.primitives);
    const m = new SignInModel({ primitives: sdk.primitives, base: BASE });
    await m.submitKey(KEY);
    expect(m.snapshot.activation).toMatchObject({ code: "license_owned" });
    expect(m.snapshot.session.step).toBeUndefined();
    await m.start({ channel: "browser" });
    await tick();
    await tick();
    expect(sdk.calls).toContain(
      `complete sg_k ${JSON.stringify({ kind: "key", key: KEY })}`,
    );
    expect(sdk.calls).not.toContain("licenses");
    expect(m.snapshot.choices).toBeUndefined();
    expect(m.snapshot.session.outcome).toBe("signedIn");
    expect((m as unknown as { heldKey: string | null }).heldKey).toBeNull();
  });

  it("a choose answer to the key completion never lists licenses", async () => {
    const sdk = fakeSdk(
      [{ outcome: "choose", grant: "sg_k", choices: VIEW }],
      [{ outcome: "choose", choices: VIEW }],
    );
    ownedKey(sdk.primitives);
    const m = new SignInModel({ primitives: sdk.primitives, base: BASE });
    await m.submitKey(KEY);
    await m.start({ channel: "browser" });
    await tick();
    await tick();
    expect(m.snapshot.session.outcome).not.toBe("choose");
    expect(m.snapshot.choices).toBeUndefined();
    expect(m.snapshot.error).toEqual({ code: "sign-in-failed" });
  });

  it("a key submitted while a grant is pending completes {kind: key}", async () => {
    const sdk = fakeSdk([{ outcome: "choose", grant: "sg_p", choices: VIEW }]);
    const m = new SignInModel({ primitives: sdk.primitives, base: BASE });
    await m.start();
    await tick();
    m.haveKey();
    await m.submitKey(KEY);
    expect(sdk.calls).toContain(
      `complete sg_p ${JSON.stringify({ kind: "key", key: KEY })}`,
    );
    expect(m.snapshot.session.step).toBeUndefined();
  });

  it("Cancel and Use a different key drop a held key", async () => {
    const owned = () => {
      const sdk = fakeSdk([]);
      ownedKey(sdk.primitives);
      return new SignInModel({ primitives: sdk.primitives, base: BASE });
    };
    const held = (m: SignInModel) =>
      (m as unknown as { heldKey: string | null }).heldKey;
    const a = owned();
    await a.submitKey(KEY);
    expect(held(a)).toBe(KEY);
    a.differentKey();
    expect(held(a)).toBeNull();
    const b = owned();
    await b.submitKey(KEY);
    await b.cancel();
    expect(held(b)).toBeNull();
  });
});
