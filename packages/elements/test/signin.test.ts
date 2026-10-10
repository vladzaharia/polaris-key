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

import { formStep, type PkSignIn } from "../src/index.js";
import { readMatrix, withDefaults, type Row } from "./fixtures.js";

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

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

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
