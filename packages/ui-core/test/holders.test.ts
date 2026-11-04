// @pkey-feature ui.signin ui.activate ui.settings
//
// Activation without an account (UK-42.3): ActivateDone, AddToAccount, the sign-in form's
// `key-done`, `attach` and `added` steps and the floating AccountAndLicense row. Written against
// the states the plan lists, ahead of the matrix's `holders` family (UK-42.2).

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("maskEmail vectors (ui-matrix.json holdersFlow)", () => {
  const vectors = (
    JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../conformance/corpus/v2/ui-matrix.json",
        ),
        "utf8",
      ),
    ) as {
      holdersFlow: { maskEmail: { email: string | null; masked: string }[] };
    }
  ).holdersFlow.maskEmail;
  it.each(vectors.map((v) => [String(v.email), v] as const))("%s", (_n, v) => {
    expect(maskEmail(v.email)).toBe(v.masked);
  });
});

describe("licenseHolder.addIn (UK-43.2)", () => {
  it("portal turns every Add control into Add it in Polaris Locker", () => {
    const holder = { email: "", addIn: "portal" as const };
    for (const v of [
      done({ licenseHolder: holder }),
      viewOf("AccountAndLicense", {
        ...base,
        licenseHolder: holder,
        account: { signedIn: false },
      }),
    ]) {
      expect(v.copy).toEqual(
        expect.arrayContaining(["signin.key.addInLocker", "a11y.externalLink"]),
      );
      expect(v.copy).not.toContain("activate.recommend.action");
      expect(v.actions).toContain("open-manage-url");
    }
  });
});

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

describe("ActivateDone Add channel", () => {
  it("says it opens Polaris Locker when the channel is the portal, Identity on", () => {
    const v = done({
      activateDone: { ...base.activateDone!, addIn: "portal" },
    });
    expect(v.copy).toEqual(
      expect.arrayContaining(["signin.key.addInLocker", "a11y.externalLink"]),
    );
    expect(v.copy).not.toContain("activate.recommend.action");
  });
  it("keeps Add your name and email for the app channel or an unknown one", () => {
    for (const addIn of [undefined, "app" as const]) {
      const v = done({
        activateDone: { ...base.activateDone!, ...(addIn ? { addIn } : {}) },
      });
      expect(v.copy).toContain("activate.recommend.action");
      expect(v.copy).not.toContain("signin.key.addInLocker");
    }
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
  it("a holder email with Identity off stays ready with the portal line", () => {
    const v = done({
      licenseHolder: { email: "alex@example.com" },
      services: servicesWithout("identity"),
    });
    expect(v.state).toBe("ready");
    expect(v.copy).toContain("activate.recommend.portal");
    expect(v.copy).not.toContain("activate.waiting");
    expect(v.copy).not.toContain("activate.waitingSignIn");
    expect(v.args.maskedEmail).toBeUndefined();
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
    expect(add({ step: "form" }).decisions.focus).toBe("activate.attach.name");
    const phone = add(
      { step: "form" },
      { platform: { os: "ios", formFactor: "iphone" } },
    );
    expect(phone.decisions.focus).toBe("heading");
  });
  it("invalid says which field and sits the message under it", () => {
    const v = add({ step: "invalid", field: "email" });
    expect(v.copy).toContain("signin.email.invalid");
    expect(v.copy).not.toContain("activate.attach.nameRequired");
    expect(v.decisions).toMatchObject({
      tone: "danger",
      errorSlot: "signin.email.label",
    });
  });
  it("busy with no code keeps Continue and Cancel and offers the browser again", () => {
    const v = add({ step: "busy" });
    expect(v.decisions.primary).toBe("common.continue");
    expect(v.copy).toEqual(
      expect.arrayContaining([
        "common.continue",
        "common.cancel",
        "common.working",
        "signin.handoff.again",
      ]),
    );
    expect(v.actions).toContain("open-browser");
    expect(v.decisions.focus).toBeNull();
  });
  it("busy with the device code is a waiting view: title, the code to check, no form", () => {
    const v = add(
      { step: "busy" },
      { deviceCode: { phase: "waiting", userCode: "WDJB-MJHT" } },
    );
    expect(v.state).toBe("waiting");
    expect(v.copy).toEqual(
      expect.arrayContaining([
        "activate.attach.waitTitle",
        "part.code.label",
        "a11y.code",
        "a11y.copyCode",
        "activate.attach.waitCheck",
        "activate.attach.reopen",
        "common.cancel",
      ]),
    );
    for (const hidden of [
      "activate.attach.name",
      "signin.email.label",
      "activate.attach.fine",
      "common.continue",
      "common.working",
    ])
      expect(v.copy).not.toContain(hidden);
    expect(v.decisions.focus).toBe("heading");
  });
  it("email-bound with no known email leaves the sentence out", () => {
    const v = add({ step: "email-bound" });
    expect(v.copy).toContain("activate.otherEmail.title");
    expect(v.copy).not.toContain("activate.otherEmail.body");
    // No "Verify that email" without an email to name: Use another account leads.
    expect(v.copy).not.toContain("activate.otherEmail.verify");
    expect(v.decisions.primary).toBe("signin.auto.confirm.other");
    const named = add(
      { step: "email-bound" },
      { licenseHolder: { email: "alex@example.com" } },
    );
    expect(named.copy).toContain("activate.otherEmail.body");
    expect(named.copy).toContain("activate.otherEmail.verify");
    expect(named.decisions.primary).toBe("activate.otherEmail.verify");
  });
  it("other-account names both emails masked, and never an empty one", () => {
    const v = add({
      step: "other-account",
      typedEmail: "m•••@example.com",
      signedEmail: "j•••@example.com",
    });
    expect(v.state).toBe("other-account");
    expect(v.copy).toContain("activate.otherAccount.body");
    expect(v.args).toMatchObject({
      maskedEmail: "m•••@example.com",
      email: "j•••@example.com",
    });
    expect(v.decisions.primary).toBe("common.tryAgain");
    // The provider shared no email: the sentence that names it is left out.
    const none = add({ step: "other-account", typedEmail: "m•••@example.com" });
    expect(none.copy).not.toContain("activate.otherAccount.body");
    expect(none.copy).toContain("activate.otherAccount.title");
  });
  it("a holder email too short to mask counts as no holder", () => {
    const v = done({ licenseHolder: { email: "@example.com" } });
    expect(v.state).toBe("ready");
  });
  it("Identity off: the action opens polaris.locker and says so", () => {
    const v = done({ services: servicesWithout("identity") });
    expect(v.copy).toContain("signin.key.addInLocker");
    expect(v.copy).toContain("a11y.externalLink");
    expect(v.copy).not.toContain("activate.recommend.action");
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
