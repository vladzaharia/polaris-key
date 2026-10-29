// @pkey-feature ui.signin
//
// The one sign-in form (SIGN-IN.md §3.17): `<pk-sign-in>` morphs its body through the steps of
// ui-matrix.json's signIn family (the handoff's code view, the license choice, Replace a device,
// Done), the step elements draw one step each, `presentation="sheet"` puts the form in a
// `<dialog>`, and with SDK primitives the form drives ui-core's SignInModel from its own controls.

import { beforeAll, describe, expect, it } from "vitest";
import type {
  LicenseChoiceView,
  SignInPrimitives,
  SignInWait,
  UiInput,
} from "@polaris-key/ui-core";

import { FORM_ORDER } from "../src/form.js";
import {
  EMAIL,
  fakeHolders,
  KEY,
  NAME,
  type FakeHolders,
} from "./holdersFixtures.js";
import { formStep, type PkSignIn } from "../src/index.js";
import {
  readMatrix,
  stubResizeObserver,
  withDefaults,
  type Row,
} from "./fixtures.js";

const matrix = readMatrix();
const rows = matrix.signIn as Row[];
const input = (name: string): UiInput => {
  const r = rows.find((x) => x.name === name);
  if (!r) throw new Error(`no signIn row ${name}`);
  return {
    elapsedMs: 60_000,
    ...withDefaults(r.input, matrix.vocabulary.defaults),
  };
};

beforeAll(stubResizeObserver);

async function draw(
  tag: string,
  props: Partial<PkSignIn> & { input?: UiInput },
): Promise<PkSignIn> {
  const el = document.createElement(tag) as PkSignIn;
  Object.assign(el, props);
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el;
}

const flush = async (el: PkSignIn) => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
};

describe("the form's steps", () => {
  it("draws the code view in the form's body", async () => {
    const i = input("SignIn/code: a device-code sign-in");
    expect(formStep(i).body.component).toBe("SignInHandoff");
    const el = await draw("pk-sign-in", { input: i });
    expect(el.shadowRoot!.querySelector('[data-part="code"]')).not.toBeNull();
  });

  it("draws the license choice with one title", async () => {
    const el = await draw("pk-sign-in", {
      input: input("SignIn/choose: desktop"),
    });
    const root = el.shadowRoot!;
    expect(el.step.body.component).toBe("LicenseChoice");
    expect(root.querySelectorAll("h1")).toHaveLength(1);
    expect(root.querySelector('[data-part="license-list"]')).not.toBeNull();
  });

  it("names a store-origin license's store, never a raw {store}", async () => {
    const base = input("SignIn/choose: desktop");
    const choices = base.choices!;
    const i: UiInput = {
      ...base,
      choices: {
        ...choices,
        choices: choices.choices.map((r) => ({
          ...r,
          origin: "store",
          store: "Steam",
        })),
      },
    };
    const el = await draw("pk-sign-in", { input: i });
    const text = el.shadowRoot!.textContent ?? "";
    expect(text).toContain("From Steam");
    expect(text).not.toContain("{store}");
  });

  it("titles Replace a device, preselects the least recent and names it in the confirm", async () => {
    const el = await draw("pk-sign-in", {
      input: input("SignIn/replace: the web confirms inline"),
    });
    const root = el.shadowRoot!;
    expect(root.querySelector("h1")?.getAttribute("data-key")).toBe(
      "deviceLimit.title",
    );
    const devices = root.querySelectorAll('[data-part="device-row"]');
    expect(devices).toHaveLength(3);
    expect(devices[0]!.getAttribute("aria-checked")).toBe("true");
    expect(devices[0]!.textContent).toContain("Windows");
    expect(
      root.querySelector('[data-key="signin.replace.title"]')?.textContent,
    ).toContain("Work laptop");
    // Picking another device moves the confirm with it, and Replace and continue carries it.
    (devices[1] as HTMLElement).click();
    await el.updateComplete;
    expect(
      root.querySelector('[data-key="signin.replace.title"]')?.textContent,
    ).toContain("Mara's iPad");
    let detail: Record<string, unknown> | null = null;
    el.addEventListener("pk-action", (e) => {
      detail = (e as CustomEvent).detail;
    });
    root
      .querySelector<HTMLElement>('[data-key="signin.replace.confirm"]')!
      .click();
    expect(detail).toMatchObject({
      key: "signin.replace.confirm",
      deviceId: "dev_ipad",
    });
  });

  it("ends on Done with the success mark", async () => {
    const r = rows.find(
      (x) =>
        x.expect.component === "SignIn" &&
        x.expect.state === "done" &&
        x.expect.copy.includes("signin.done.start"),
    )!;
    const el = await draw("pk-sign-in", {
      input: {
        elapsedMs: 60_000,
        ...withDefaults(r.input, matrix.vocabulary.defaults),
      },
    });
    expect(el.shadowRoot!.querySelector(".success")).not.toBeNull();
  });
});

describe("the step elements", () => {
  it("each draws its own step and nothing else", async () => {
    const methods = input("SignIn/methods: web");
    const replace = input("SignIn/replace: the web confirms inline");
    let el = await draw("pk-sign-in-methods", { input: methods });
    expect(el.shadowRoot!.querySelector("h1")).not.toBeNull();
    el = await draw("pk-sign-in-methods", { input: replace });
    expect(el.shadowRoot!.querySelector("h1")).toBeNull();
    el = await draw("pk-replace-device", { input: replace });
    expect(
      el.shadowRoot!.querySelectorAll('[data-part="device-row"]'),
    ).toHaveLength(3);
    el = await draw("pk-replace-device", { input: methods });
    expect(el.shadowRoot!.querySelector("h1")).toBeNull();
    el = await draw("pk-sign-in-done", { input: methods });
    expect(el.shadowRoot!.querySelector("h1")).toBeNull();
  });
});

describe('presentation="sheet"', () => {
  it("puts the form in a dialog labelled by its title", async () => {
    const el = await draw("pk-sign-in", {
      input: input("SignIn/methods: web"),
      presentation: "sheet",
    });
    const dialog = el.shadowRoot!.querySelector("dialog.sheet");
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-labelledby")).toBe("pk-title");
    expect(dialog!.querySelector("#pk-title")).not.toBeNull();
  });
});

describe("live: the form drives the SDK primitives", () => {
  const choices: LicenseChoiceView = {
    state: "choose",
    keep: false,
    preselected: "lic_pro",
    create: null,
    getLicense: null,
    choices: [
      {
        id: "lic_pro",
        tierName: "Pro",
        name: null,
        origin: "store",
        access: "seats",
        seats: { used: 1, limit: 3 },
        current: false,
        expiresAt: null,
        state: "free",
        replace: null,
        freeDeviceUrl: null,
      },
    ],
  };

  it("Continue in browser → choose → Use this license → Done", async () => {
    const calls: string[] = [];
    let answered = false;
    const primitives: SignInPrimitives = {
      async start(o) {
        calls.push(`start:${o.channel}:${o.licenseChoice}`);
        return {
          browserOpened: true,
          async wait(): Promise<SignInWait> {
            if (answered) return new Promise(() => {});
            answered = true;
            return { outcome: "choose", grant: "g1", choices };
          },
          reopen: () => true,
          cancel: () => {},
        };
      },
      choice: {
        licenses: async () => choices,
        devices: async () => {
          throw new Error("unused");
        },
        async complete(grant, choice) {
          calls.push(`complete:${grant}:${JSON.stringify(choice)}`);
          return { outcome: "signedIn", issuedNow: true };
        },
        cancel: async () => {},
      },
    };
    const base = input("SignIn/methods: web");
    delete base.signIn;
    const el = await draw("pk-sign-in", { input: base, primitives });
    expect(el.view.state).toBe("methods");
    el.shadowRoot!.querySelector<HTMLElement>(
      `[data-key="${el.view.decisions.primary}"]`,
    )!.click();
    await flush(el);
    expect(calls[0]).toBe("start:browser:app");
    expect(el.view.state).toBe("choose");
    el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="signin.choice.continue"]',
    )!.click();
    await flush(el);
    expect(calls[1]).toBe(
      'complete:g1:{"kind":"license","licenseId":"lic_pro"}',
    );
    expect(el.view.state).toBe("done");
    expect(el.shadowRoot!.querySelector(".success")).not.toBeNull();
  });
});

describe("the form's steps after a key with no account (UK-42.5)", () => {
  it("key-done, attach and added travel forward from the key, before done", () => {
    const at = (s: string) => FORM_ORDER.indexOf(s);
    expect(at("key")).toBeGreaterThan(-1);
    expect(at("key-done")).toBeGreaterThan(at("key"));
    expect(at("attach")).toBeGreaterThan(at("key-done"));
    expect(at("added")).toBeGreaterThan(at("attach"));
    expect(at("done")).toBeGreaterThan(at("added"));
  });

  it("formStep draws the form's own view for each", () => {
    for (const step of ["key-done", "attach", "added"] as const) {
      const i = {
        platform: { os: "macos", formFactor: "mac" },
        services: ["license", "identity"],
        signIn: {
          presentation: "inline",
          replace: "inline",
          channel: "browser",
          step,
        },
        activateDone: {},
        addToAccount: { step: "form" },
      } as UiInput;
      const f = formStep(i);
      expect(f.form.state).toBe(step);
      expect(f.body).toBe(f.form);
    }
  });
});

describe("live: a key with no account, then Add your name and email (UK-42.8)", () => {
  async function atKeyDone(f: FakeHolders, extra: Partial<PkSignIn> = {}) {
    const base = input("SignIn/methods: web");
    delete base.signIn;
    const el = await draw("pk-sign-in", {
      input: {
        ...base,
        services: ["license", "identity"],
      },
      primitives: f.primitives,
      ...extra,
    });
    await el.signIn!.submitKey(KEY);
    await flush(el);
    return el;
  }

  const press = async (el: PkSignIn, key: string) => {
    el.shadowRoot!.querySelector<HTMLElement>(`[data-key="${key}"]`)!.click();
    await flush(el);
  };
  const type = (el: PkSignIn, label: string, value: string) => {
    el.shadowRoot!.querySelector<HTMLInputElement>(
      `[data-key="${label}"]`,
    )!.value = value;
  };

  it("key-done draws ActivateDone's body; the key is nowhere in the input", async () => {
    const f = fakeHolders();
    const el = await atKeyDone(f);
    expect(el.view.state).toBe("key-done");
    const root = el.shadowRoot!;
    expect(
      root.querySelector('[data-key="activate.recommend.action"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-key="signin.done.start"]')).not.toBeNull();
    expect(JSON.stringify(el.signIn!.snapshot)).not.toContain(KEY);
    expect(JSON.stringify(el.input ?? {})).not.toContain(KEY);
  });

  it("Add your name and email: the fields leave only in Continue, the hints carry them, attach is previewed first", async () => {
    const f = fakeHolders();
    const el = await atKeyDone(f);
    const seen: Array<Record<string, unknown>> = [];
    el.addEventListener("pk-action", (e) =>
      seen.push((e as CustomEvent).detail),
    );
    await press(el, "activate.recommend.action");
    expect(el.view.state).toBe("attach");
    expect(
      el.shadowRoot!.querySelector('[data-key="signin.gate.name"]'),
    ).not.toBeNull();
    type(el, "signin.gate.name", NAME);
    type(el, "signin.email.label", EMAIL);
    await press(el, "common.continue");
    // Previewed with confirm:false, then written; the form ends on Added.
    expect(f.attaches).toEqual([false, true]);
    expect(f.starts[0]).toMatchObject({
      licenseChoice: "app",
      hints: { loginHint: EMAIL, nameHint: NAME, purpose: "attach" },
    });
    expect(el.view.state).toBe("added");
    // Name and email are in the Continue detail and nowhere else.
    const carriers = seen.filter((d) => JSON.stringify(d).includes(EMAIL));
    expect(carriers.map((d) => d.key)).toEqual(["common.continue"]);
    expect(JSON.stringify(el.signIn!.snapshot)).not.toContain(EMAIL);
    expect(JSON.stringify(el.signIn!.snapshot)).not.toContain(KEY);
    // Start using ends the form, once.
    let done = 0;
    el.addEventListener("pk-done", () => done++);
    await press(el, "signin.done.start");
    expect(done).toBe(1);
  });

  it("Cancel on the attach step lets the model go, back to Done with the key still held", async () => {
    const f = fakeHolders();
    const el = await atKeyDone(f);
    await press(el, "activate.recommend.action");
    type(el, "signin.gate.name", NAME);
    await press(el, "common.cancel");
    expect(el.view.state).toBe("key-done");
    // A new Add starts from empty fields: the old model is gone.
    await press(el, "activate.recommend.action");
    expect(
      el.shadowRoot!.querySelector<HTMLInputElement>(
        '[data-key="signin.gate.name"]',
      )!.value,
    ).toBe("");
    // Owned, then Cancel: the same way back.
    f.attach.code = "license_owned";
    type(el, "signin.gate.name", NAME);
    type(el, "signin.email.label", EMAIL);
    await press(el, "common.continue");
    await press(el, "common.cancel");
    expect(el.view.state).toBe("key-done");
    // Start using drops the key.
    await press(el, "signin.done.start");
    expect(el.signIn!.snapshot.session.step).toBeUndefined();
  });

  it("owned: a second Sign in press does nothing; a preview mismatch goes to email-bound", async () => {
    const f = fakeHolders();
    const el = await atKeyDone(f);
    await press(el, "activate.recommend.action");
    f.attach.code = "license_owned";
    type(el, "signin.gate.name", NAME);
    type(el, "signin.email.label", EMAIL);
    await press(el, "common.continue");
    expect(
      el.shadowRoot!.querySelector('[data-key="signin.key.ownedSignIn"]'),
    ).not.toBeNull();
    // Both presses land before the first sign-in has started.
    const button = el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="signin.key.ownedSignIn"]',
    )!;
    const before = f.starts.length;
    button.click();
    button.click();
    await flush(el);
    expect(f.starts.length - before).toBe(1);

    const g = fakeHolders();
    g.attach.code = "license_email_bound";
    const el2 = await atKeyDone(g);
    await press(el2, "activate.recommend.action");
    type(el2, "signin.gate.name", NAME);
    type(el2, "signin.email.label", EMAIL);
    await press(el2, "common.continue");
    expect(g.attaches).toEqual([false]);
    expect(
      el2.shadowRoot!.querySelector('[data-key="activate.otherEmail.verify"]'),
    ).not.toBeNull();
  });

  it("a sheet closed on a holder step drops the key and the model", async () => {
    const f = fakeHolders();
    const el = await atKeyDone(f, { presentation: "sheet", open: true });
    await press(el, "activate.recommend.action");
    el.close();
    await flush(el);
    expect(el.signIn!.snapshot.session.step).toBeUndefined();
    expect(JSON.stringify(el.signIn!.snapshot)).not.toContain(KEY);
  });
});
