// @pkey-feature ui.signin ui.activate ui.settings
//
// Activation without an account (UK-42.3): ActivateDone, AddToAccount, the sign-in form's
// `key-done`, `attach` and `added` steps and the floating AccountAndLicense row. Written against
// the states the plan lists, ahead of the matrix's `holders` family (UK-42.2).

import { describe, expect, it } from "vitest";

import {
  maskEmail,
  recommendReasons,
  servicesWithout,
  SignInModel,
  viewOf,
  type UiInput,
} from "../src/index.js";

const base: UiInput = {
  integrator: { name: "Harbor", developer: "Tidewater" },
  platform: { os: "macos", formFactor: "mac" },
  activateDone: { tier: "Pro", term: "Lifetime", deviceKind: "computer" },
  licenseHolder: {},
};

const done = (o: Partial<UiInput> = {}) =>
  viewOf("ActivateDone", { ...base, ...o });
const add = (
  step: NonNullable<UiInput["addToAccount"]>,
  o: Partial<UiInput> = {},
) => viewOf("AddToAccount", { ...base, addToAccount: step, ...o });

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("alex@example.com")).toBe("a•••@example.com");
    expect(maskEmail("éva@example.co.uk")).toBe("é•••@example.co.uk");
  });
  it("shows nothing of an address it cannot mask", () => {
    for (const bad of ["", "@example.com", "alex@", "alex", undefined])
      expect(maskEmail(bad)).toBe("");
  });
});

describe("recommendReasons", () => {
  it("names Cloud Sync only when the product has it", () => {
    expect(recommendReasons({ identity: true, sync: true })).toEqual([
      "activate.recommend.sync",
      "activate.recommend.recover",
      "activate.recommend.devices",
    ]);
    expect(recommendReasons({ identity: true, sync: false })).toEqual([
      "activate.recommend.recover",
      "activate.recommend.devices",
    ]);
  });
  it("is the portal line alone with Identity off, whatever sync says", () => {
    for (const sync of [true, false])
      expect(recommendReasons({ identity: false, sync })).toEqual([
        "activate.recommend.portal",
      ]);
  });
});

describe("ActivateDone", () => {
  it("ready with Cloud Sync lists all three reasons", () => {
    const v = done();
    expect(v.state).toBe("ready");
    expect(v.copy).toEqual(
      expect.arrayContaining([
        "activate.recommend.sync",
        "activate.recommend.recover",
        "activate.recommend.devices",
        "activate.recommend.badge",
        "activate.recommend.action",
      ]),
    );
    expect(v.decisions.primary).toBe("signin.done.start");
    expect(v.args).toMatchObject({ product: "Harbor", tier: "Pro" });
  });
  it("ready without Cloud Sync never names it", () => {
    const v = done({ services: servicesWithout("sync") });
    expect(v.state).toBe("ready");
    expect(v.copy).not.toContain("activate.recommend.sync");
    expect(v.copy).toContain("activate.recommend.recover");
  });
  it("Identity off shows the portal line only (Sync goes with it)", () => {
    const v = done({ services: servicesWithout("identity") });
    expect(v.state).toBe("ready");
    expect(v.copy).toContain("activate.recommend.portal");
    expect(v.copy).not.toContain("activate.recommend.sync");
    expect(v.copy).not.toContain("activate.recommend.recover");
  });
  it("waiting masks the address and offers Sign in as it", () => {
    const v = done({ licenseHolder: { email: "alex@example.com" } });
    expect(v.state).toBe("waiting");
    expect(v.args.maskedEmail).toBe("a•••@example.com");
    expect(v.copy).toContain("activate.waitingSignIn");
    expect(v.copy).not.toContain("activate.recommend.title");
    expect(v.actions).toContain("start-sign-in");
    expect(JSON.stringify(v)).not.toContain("alex@");
  });
  it("is hidden with License off or with nothing to show", () => {
    expect(done({ services: servicesWithout("license") }).state).toBe("hidden");
    expect(
      viewOf("ActivateDone", { ...base, activateDone: undefined }).state,
    ).toBe("hidden");
  });
});

describe("AddToAccount", () => {
  it("form focuses Name, or the heading under a coarse pointer", () => {
    expect(add({ step: "form" }).decisions.focus).toBe("signin.gate.name");
    const phone = add(
      { step: "form" },
      { platform: { os: "ios", formFactor: "iphone" } },
    );
    expect(phone.decisions.focus).toBe("heading");
  });
  it("invalid says which field and sits the message under it", () => {
    const v = add({ step: "invalid", field: "email" });
    expect(v.copy).toContain("signin.email.invalid");
    expect(v.copy).not.toContain("signin.gate.nameRequired");
    expect(v.decisions).toMatchObject({
      tone: "danger",
      errorSlot: "signin.email.label",
    });
  });
  it("busy has no control", () => {
    const v = add({ step: "busy" });
    expect(v.decisions.primary).toBeNull();
    expect(v.copy).toContain("common.working");
  });
  it("added names Cloud Sync only when the product has it", () => {
    expect(add({ step: "added", deviceKind: "computer" }).copy).toContain(
      "activate.attach.syncOn",
    );
    expect(
      add({ step: "added" }, { services: servicesWithout("sync") }).copy,
    ).not.toContain("activate.attach.syncOn");
  });
  it("owned, email-bound and failed", () => {
    expect(add({ step: "owned" }).copy).toContain("activate.owned.title");
    const bound = add(
      { step: "email-bound" },
      { licenseHolder: { email: "alex@example.com" } },
    );
    expect(bound.args.maskedEmail).toBe("a•••@example.com");
    expect(bound.copy).toContain("signin.done.start");
    expect(bound.actions).toEqual(["open-manage-url"]);
    const failed = add({ step: "failed" });
    expect(failed.decisions.tone).toBe("danger");
    expect(failed.actions).toContain("retry");
  });
  it("is hidden with Identity off", () => {
    expect(
      add({ step: "form" }, { services: servicesWithout("identity") }).state,
    ).toBe("hidden");
  });
});

describe("SignIn form steps", () => {
  const form = (
    step: "key-done" | "attach" | "added",
    o: Partial<UiInput> = {},
  ) =>
    SignInModel.restore({
      ...base,
      addToAccount: { step: "form" },
      signIn: {
        presentation: "inline",
        replace: "inline",
        channel: "browser",
        step,
      },
      ...o,
    }).view("SignIn");
  it("key-done draws the Done step", () => {
    const v = form("key-done");
    expect(v).toMatchObject({ component: "SignIn", state: "key-done" });
    expect(v.copy).toContain("activate.recommend.title");
  });
  it("attach draws the form and added the added state", () => {
    expect(form("attach")).toMatchObject({ state: "attach" });
    const added = form("added");
    expect(added.state).toBe("added");
    expect(added.copy).toContain("activate.attach.done");
  });
});

describe("AccountAndLicense", () => {
  const account = (o: Partial<UiInput> = {}) =>
    viewOf("AccountAndLicense", {
      ...base,
      account: { signedIn: false, tier: "Pro" },
      ...o,
    });
  it("a floating license says Not in an account and offers Add", () => {
    const v = account();
    expect(v.state).toBe("key-only");
    expect(v.copy).toEqual(
      expect.arrayContaining([
        "account.notInAccount",
        "activate.recommend.action",
      ]),
    );
    expect(v.copy).not.toContain("account.keyOnly");
  });
  it("Identity off keeps the row, whose action opens the portal", () => {
    const v = account({ services: servicesWithout("identity") });
    expect(v.copy).toContain("account.notInAccount");
  });
  it("is the old key-only row when the holder is unknown or waiting", () => {
    expect(account({ licenseHolder: undefined }).copy).toContain(
      "account.keyOnly",
    );
    expect(
      account({ licenseHolder: { email: "alex@example.com" } }).copy,
    ).toContain("account.keyOnly");
  });
});
