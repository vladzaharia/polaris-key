// @pkey-feature ui.signin
//
// The UK-kits polish slice: in a sheet, Cancel on the license step leaves it, an existing license
// closes the sheet with a toast (nameless when the holder has no name), `close()` is idempotent,
// the Replace step has no opener, and the Download button carries the external glyph.

import { beforeAll, describe, expect, it } from "vitest";
import type {
  LicenseChoiceView,
  SignInPrimitives,
  SignInWait,
  UiInput,
} from "@polaris-key/ui-core";

import "../src/index.js";
import type { PkElement, PkSignIn } from "../src/index.js";
import { readMatrix, withDefaults, type Row } from "./fixtures.js";

const matrix = readMatrix();
const rowOf = (name: string): Row => {
  for (const f of ["signIn", "update"] as const) {
    const r = (matrix[f] as Row[]).find((x) => x.name === name);
    if (r) return r;
  }
  throw new Error(`no row ${name}`);
};
const input = (name: string): UiInput => ({
  elapsedMs: 60_000,
  ...withDefaults(rowOf(name).input, matrix.vocabulary.defaults),
});

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

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

function primitives(issuedNow: boolean): SignInPrimitives {
  let answered = false;
  return {
    async start() {
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
      complete: async () => ({ outcome: "signedIn", issuedNow }),
      cancel: async () => {},
    },
  };
}

const flush = async (el: PkElement) => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
};

/** A sheet driven to the license step. */
async function chooseStep(
  issuedNow: boolean,
  account?: UiInput["account"],
): Promise<{ el: PkSignIn; closed: () => number }> {
  const base = input("SignIn/methods: web (sheet)");
  delete base.signIn;
  const el = document.createElement("pk-sign-in") as PkSignIn;
  el.presentation = "sheet";
  el.primitives = primitives(issuedNow);
  el.input = { ...base, ...(account ? { account } : {}) };
  document.body.replaceChildren(el);
  el.open = true;
  await el.updateComplete;
  let n = 0;
  el.addEventListener("pk-close", () => n++);
  el.shadowRoot!.querySelector<HTMLElement>(
    `[data-key="${el.view.decisions.primary}"]`,
  )!.click();
  await flush(el);
  expect(el.view.state).toBe("choose");
  return { el, closed: () => n };
}

describe("a sheet", () => {
  it("Cancel on the license step closes it, once; close() again does nothing", async () => {
    const { el, closed } = await chooseStep(false);
    el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="common.cancel"]',
    )!.click();
    await flush(el);
    expect(el.open).toBe(false);
    expect(closed()).toBe(1);
    el.close();
    el.close();
    expect(closed()).toBe(1);
  });

  it("an existing license closes the sheet with a toast naming the holder", async () => {
    const { el, closed } = await chooseStep(false, {
      signedIn: true,
      holder: "Mara",
    });
    el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="signin.choice.continue"]',
    )!.click();
    await flush(el);
    expect(el.open).toBe(false);
    expect(closed()).toBe(1);
    const toast = el.shadowRoot!.querySelector('[data-part="toast"]');
    expect(toast?.getAttribute("data-key")).toBe("signin.desktop.toast");
    expect(toast?.textContent).toContain("Mara");
    expect(toast?.textContent).toContain("Pro");
  });

  it("an existing license of a holder with no name gets the nameless toast", async () => {
    const { el } = await chooseStep(false);
    el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="signin.choice.continue"]',
    )!.click();
    await flush(el);
    expect(el.open).toBe(false);
    const toast = el.shadowRoot!.querySelector('[data-part="toast"]');
    expect(toast?.getAttribute("data-key")).toBe("signin.return.signedInShort");
    expect(toast?.textContent).not.toContain("{");
  });

  it("a license issued now ends on Done, with no toast", async () => {
    const { el } = await chooseStep(true);
    el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="signin.choice.continue"]',
    )!.click();
    await flush(el);
    expect(el.open).toBe(true);
    expect(el.view.state).toBe("done");
    expect(el.shadowRoot!.querySelector('[data-part="toast"]')).toBeNull();
  });
});

describe("the Replace step", () => {
  it("draws no Replace a device opener", async () => {
    const el = document.createElement("pk-sign-in") as PkSignIn;
    el.input = input("SignIn/replace: the web confirms inline");
    document.body.replaceChildren(el);
    await el.updateComplete;
    const root = el.shadowRoot!;
    expect(root.querySelector('[data-key="signin.replace.open"]')).toBeNull();
    expect(
      root.querySelector('[data-key="signin.replace.openSystem"]'),
    ).toBeNull();
    expect(
      root.querySelector('[data-key="signin.replace.confirm"]'),
    ).not.toBeNull();
  });
});

describe("the web update prompt", () => {
  it("draws Download with the external glyph", async () => {
    const el = document.createElement("pk-update-prompt") as PkElement;
    el.input = {
      ...input("UpdatePrompt/available"),
      platform: { os: "web", formFactor: "computer" },
    } as UiInput;
    document.body.replaceChildren(el);
    await el.updateComplete;
    const btn = el.shadowRoot!.querySelector('[data-key="update.install"]');
    expect(btn?.querySelector("svg")).not.toBeNull();
  });
});
