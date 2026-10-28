// @pkey-feature ui.kit identity.autosignin
//
// Automatic sign-in in the custom element (I-46.9): `<pk-gate config>` runs the ladder once at
// boot (unless `auto-sign-in="off"`), the confirm has no Cancel and the confirm hierarchy of
// SIGN-IN §3.19, the device limit with no rows is its own step (h1, lede, Replace a device,
// Use another account, Cancel), Replace resumes the provider sign-in when the person comes back,
// and the provider's button is Google's.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AutoOutcome,
  LicenseChoiceView,
  SignInPrimitives,
  UiInput,
} from "@polaris-key/ui-core";

import "../src/index.js";
import type { PkGate, PkSignIn } from "../src/index.js";
import { CONSENT, fakeClient } from "./autoFixtures.js";
import {
  readMatrix,
  rowInput,
  stubResizeObserver,
  withDefaults,
  type Row,
} from "./fixtures.js";

const matrix = readMatrix();
const rows = matrix.signIn as Row[];
const input = (name: string): UiInput => rowInput("signIn", name);

beforeAll(stubResizeObserver);

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const settle = async (el: { updateComplete: Promise<unknown> }) => {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
};

async function draw(props: Partial<PkSignIn>): Promise<PkSignIn> {
  const el = document.createElement("pk-sign-in") as PkSignIn;
  Object.assign(el, props);
  document.body.replaceChildren(el);
  await settle(el);
  return el;
}

const keys = (el: Element) =>
  [...el.shadowRoot!.querySelectorAll<HTMLElement>("button[data-key]")].map(
    (b) => b.dataset.key,
  );

describe("the confirm step", () => {
  it("has Continue and Use another account, and no Cancel", async () => {
    const el = await draw({
      input: input("SignIn/confirm: the account's email, a new license"),
    });
    expect(keys(el)).toEqual([
      "signin.auto.confirm.primary",
      "signin.auto.confirm.other",
    ]);
  });

  it("puts 'as <email>' under the title, labels over values, the license line strong", async () => {
    const el = await draw({
      input: input("SignIn/confirm: the account's email, a new license"),
    });
    const root = el.shadowRoot!;
    expect(root.querySelectorAll("h1")).toHaveLength(1);
    const sub = root.querySelector('[data-part="subtitle"]')!;
    expect(sub.getAttribute("data-key")).toBe("signin.auto.confirm.as");
    expect(
      root.querySelectorAll('[data-part="consent-label"]').length,
    ).toBeGreaterThan(0);
    expect(
      root.querySelector('.consent-line[data-key="signin.consent.newLicense"]'),
    ).not.toBeNull();
    // The group order: the license first, then what the app also gets.
    const groups = [...root.querySelectorAll(".consent-group")];
    expect(groups.length).toBeGreaterThan(0);
    expect(
      groups[0]!.querySelector('[data-key^="signin.consent."]'),
    ).not.toBeNull();
  });
});

describe("the device limit with no license rows", () => {
  it("with a link: h1, the lede, Replace a device (new window) first, Use another account, Cancel", async () => {
    const el = await draw({
      fill: true,
      input: input(
        "SignIn/device-limit: no license rows, with a link to replace a device",
      ),
    });
    const root = el.shadowRoot!;
    expect(root.querySelectorAll("h1")).toHaveLength(1);
    expect(
      root.querySelector('[data-key="core.codes.device_limit.message"]'),
    ).not.toBeNull();
    expect(keys(el)).toEqual([
      "signin.deviceLimit.replace",
      "signin.auto.confirm.other",
      "common.cancel",
    ]);
    const replace = root.querySelector<HTMLElement>(
      '[data-key="signin.deviceLimit.replace"]',
    )!;
    expect(replace.dataset.variant).toBe("primary");
    expect(replace.querySelector("svg")).not.toBeNull();
    expect(root.querySelector("input")).toBeNull();
    expect(el.shadowRoot!.activeElement?.localName).toBe("h1");
  });

  it("without a link: the 'ask your developer' line and no Replace", async () => {
    const el = await draw({
      input: input("SignIn/device-limit: no license rows, no link"),
    });
    const root = el.shadowRoot!;
    expect(
      root.querySelector('[data-key="deviceLimit.noManage"]'),
    ).not.toBeNull();
    expect(keys(el)).toEqual(["signin.auto.confirm.other", "common.cancel"]);
    expect(root.querySelector("input")).toBeNull();
  });
});

describe("the provider's button", () => {
  it("is Google's: its mark, never the accent", async () => {
    const methods = rows.find((r) => r.expect.state === "methods")!;
    const g = await draw({
      input: {
        elapsedMs: 60_000,
        ...withDefaults(methods.input, matrix.vocabulary.defaults),
        provider: "Google",
      },
    });
    const b = g.shadowRoot!.querySelector<HTMLElement>(
      'button[data-key="signin.provider.continue"]',
    );
    expect(b?.dataset.provider).toBe("google");
    expect(b?.querySelector("svg.mark")).not.toBeNull();
  });
});

const CONFIRM: AutoOutcome = {
  kind: "confirm",
  grant: "sg_1",
  expiresIn: 300,
  claims: ["email"],
  input: { email: "maya@example.com", license: "new", alsoGets: true },
};

function prims(over: Partial<SignInPrimitives> = {}) {
  const complete = vi.fn(async () => ({
    outcome: "signedIn" as const,
    issuedNow: true,
  }));
  const cancel = vi.fn(async () => {});
  const autoSignIn = vi.fn(async (): Promise<AutoOutcome | null> => null);
  const p: SignInPrimitives = {
    start: vi.fn(async () => ({
      wait: () => new Promise<never>(() => {}),
      reopen: () => false,
      cancel: () => {},
    })),
    choice: {
      licenses: async () => ({}) as LicenseChoiceView,
      devices: async () => ({}) as never,
      complete,
      cancel,
    },
    autoSignIn,
    ...over,
  };
  return { p, complete, cancel, autoSignIn };
}

describe("the form over the SDK primitives", () => {
  it("Continue completes with the consent; Use another account shows the methods", async () => {
    const { p, complete, cancel } = prims();
    const el = await draw({ primitives: p, seed: CONFIRM });
    expect(
      el.shadowRoot!.querySelector('[data-part="subtitle"]'),
    ).not.toBeNull();
    el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="signin.auto.confirm.other"]',
    )!.click();
    await settle(el);
    expect(cancel).toHaveBeenCalledWith("sg_1");
    expect(
      el.shadowRoot!.querySelector('[data-key="signin.provider.continue"]'),
    ).not.toBeNull();
    complete.mockClear();
    const again = await draw({ primitives: prims().p, seed: CONFIRM });
    again
      .shadowRoot!.querySelector<HTMLElement>(
        '[data-key="signin.auto.confirm.primary"]',
      )!
      .click();
    await settle(again);
  });

  it("Continue sends the consent's claims", async () => {
    const { p, complete } = prims();
    const el = await draw({ primitives: p, seed: CONFIRM });
    el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="signin.auto.confirm.primary"]',
    )!.click();
    await settle(el);
    expect(complete).toHaveBeenCalledWith("sg_1", undefined, {
      consent: { claims: ["email"] },
    });
  });

  it("Replace opens the manage link, and coming back runs the provider sign-in once more", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { p, autoSignIn } = prims();
    const el = await draw({
      primitives: p,
      seed: {
        kind: "deviceLimit",
        manageUrl: "https://polaris.locker/#/p/acme/devices",
      },
    });
    el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="signin.deviceLimit.replace"]',
    )!.click();
    await settle(el);
    expect(open).toHaveBeenCalled();
    expect(String(open.mock.calls[0]![0])).toContain("polaris.locker");
    expect(autoSignIn).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    await settle(el);
    expect(autoSignIn).toHaveBeenCalledTimes(1);
    // Only once per Replace.
    window.dispatchEvent(new Event("focus"));
    await settle(el);
    expect(autoSignIn).toHaveBeenCalledTimes(1);
  });

  it("a license list's Replace falls back to the refusal's manageUrl", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const choices = LIMIT_WITH_ROWS.view as unknown as LicenseChoiceView;
    const { p } = prims();
    const el = await draw({
      primitives: p,
      seed: {
        kind: "deviceLimit",
        view: choices,
        manageUrl: "https://polaris.locker/#/p/acme/devices",
      },
    });
    const row = el.shadowRoot!.querySelector('[data-part="license-row"]')!;
    expect(row.getAttribute("data-layout")).toBe("full");
    expect(row.querySelector(".row-name")?.textContent).toContain(
      "Tidewater Pro",
    );
    row.querySelector<HTMLElement>('[data-key="signin.replace.open"]')!.click();
    await settle(el);
    expect(open).toHaveBeenCalled();
  });
});

// ── the gate ────────────────────────────────────────────────────────────────────────────────

async function mountGate(
  result: unknown,
  attrs: Record<string, string> = {},
): Promise<{ gate: PkGate; autoSignIn: ReturnType<typeof vi.fn> }> {
  const { adapter, autoSignIn } = fakeClient(result);
  const gate = document.createElement("pk-gate") as PkGate;
  for (const [k, v] of Object.entries(attrs)) gate.setAttribute(k, v);
  gate.setAttribute("config", '{"product":"acme"}');
  gate.seams = { client: adapter as never };
  document.body.replaceChildren(gate);
  await settle(gate);
  return { gate, autoSignIn };
}

const formOf = (g: PkGate) =>
  g.shadowRoot!.querySelector<PkSignIn>("pk-sign-in");

describe("<pk-gate config> and automatic sign-in", () => {
  it("runs the ladder once at boot and shows the confirm", async () => {
    const { gate, autoSignIn } = await mountGate({
      kind: "confirm",
      grant: "sg_1",
      expiresIn: 300,
      consent: CONSENT,
    });
    expect(autoSignIn).toHaveBeenCalledTimes(1);
    const form = formOf(gate)!;
    expect(form).not.toBeNull();
    expect(
      form.shadowRoot!.querySelector('[data-part="subtitle"]')?.textContent,
    ).toContain("maya@example.com");
    expect(keys(form)).not.toContain("common.cancel");
    // The existing-license line names the license, its term and this device, with no hole.
    const line = form.shadowRoot!.querySelector(
      '[data-key="signin.consent.licenseLine"]',
    );
    expect(line?.textContent).toMatch(/Pro/);
    expect(line?.textContent).not.toMatch(/[{}]/);
  });

  it("auto-sign-in=off runs no ladder and stays on Welcome", async () => {
    const { gate, autoSignIn } = await mountGate(
      { kind: "unavailable", code: "refused" },
      { "auto-sign-in": "off" },
    );
    expect(autoSignIn).not.toHaveBeenCalled();
    expect(formOf(gate)).toBeNull();
    expect(
      gate.shadowRoot!.querySelector('[data-key="welcome.signIn"]'),
    ).not.toBeNull();
  });

  it("an unavailable ladder changes nothing: Welcome", async () => {
    const { gate, autoSignIn } = await mountGate({
      kind: "unavailable",
      code: "refused",
    });
    expect(autoSignIn).toHaveBeenCalledTimes(1);
    expect(formOf(gate)).toBeNull();
  });

  it("needs sign-in keeps Welcome; its Sign in opens the form with the Google button", async () => {
    const { gate } = await mountGate({
      kind: "needsSignIn",
      reason: "signedOut",
    });
    expect(formOf(gate)).toBeNull();
    gate
      .shadowRoot!.querySelector<HTMLElement>('[data-key="welcome.signIn"]')!
      .click();
    await settle(gate);
    const form = formOf(gate)!;
    expect(form).not.toBeNull();
    const g = form.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="signin.provider.continue"]',
    );
    expect(g?.dataset.provider).toBe("google");
    // Cancel leaves the form for Welcome.
    form
      .shadowRoot!.querySelector<HTMLElement>('[data-key="common.cancel"]')!
      .click();
    await settle(gate);
    expect(formOf(gate)).toBeNull();
    expect(
      gate.shadowRoot!.querySelector('[data-key="welcome.signIn"]'),
    ).not.toBeNull();
  });

  it("a device limit with no list opens its own step, not the key screen", async () => {
    const { gate } = await mountGate({
      kind: "deviceLimit",
      manageUrl: "https://polaris.locker/#/p/acme/devices",
    });
    const form = formOf(gate)!;
    expect(
      form.shadowRoot!.querySelector('[data-key="signin.deviceLimit.replace"]'),
    ).not.toBeNull();
    expect(form.shadowRoot!.querySelector("input")).toBeNull();
  });
});

// ── the gate's fix round (UXR I-46.9) ───────────────────────────────────────────────────────

const FULL_ROW = {
  state: "full",
  replace: { retryAfter: null, allowed: true },
  freeDeviceUrl: null,
  expiresAt: null,
  current: false,
  seats: { limit: 3, used: 3 },
  access: "seats",
  origin: "signin",
  name: "Tidewater Pro",
  tierName: "Pro",
  id: "lic_pro",
};
const LIMIT_WITH_ROWS = {
  kind: "deviceLimit",
  manageUrl: "https://polaris.locker/#/p/acme/devices",
  view: {
    getLicense: null,
    create: null,
    preselected: null,
    keep: false,
    choices: [FULL_ROW],
    state: "choose",
  },
};
const active = (g: PkGate) => formOf(g)?.shadowRoot?.activeElement ?? null;
const welcomeButton = (g: PkGate) =>
  g.shadowRoot!.querySelector<HTMLElement>('[data-key="welcome.signIn"]');

describe("the gate on a device limit with rows", () => {
  it("the row's Replace carries the new-window glyph, and the h1 takes focus", async () => {
    const { gate } = await mountGate(LIMIT_WITH_ROWS);
    const form = formOf(gate)!;
    const replace = form.shadowRoot!.querySelector<HTMLElement>(
      '[data-part="license-row"] [data-key="signin.replace.open"]',
    )!;
    expect(replace.querySelector("svg")).not.toBeNull();
    expect(replace.querySelector(".visually-hidden")).not.toBeNull();
    expect(active(gate)?.tagName).toBe("H1");
  });

  it("Cancel and Escape both go to Welcome, with Sign in focused", async () => {
    const { gate } = await mountGate(LIMIT_WITH_ROWS);
    formOf(gate)!
      .shadowRoot!.querySelector<HTMLElement>('[data-key="common.cancel"]')!
      .click();
    await settle(gate);
    expect(formOf(gate)).toBeNull();
    expect(gate.shadowRoot!.activeElement).toBe(welcomeButton(gate));
  });

  it("a row's Replace keeps focus on its button", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { gate } = await mountGate(LIMIT_WITH_ROWS);
    const form = formOf(gate)!;
    const btn = form.shadowRoot!.querySelector<HTMLElement>(
      '[data-part="license-row"] [data-key="signin.replace.open"]',
    )!;
    btn.focus();
    btn.click();
    await settle(gate);
    expect(form.shadowRoot!.activeElement?.getAttribute("data-key")).toBe(
      "signin.replace.open",
    );
  });

  it("with no replaceable row it offers Use another account, not the key", async () => {
    const { gate } = await mountGate({
      ...LIMIT_WITH_ROWS,
      view: {
        ...LIMIT_WITH_ROWS.view,
        choices: [
          { ...FULL_ROW, replace: { retryAfter: null, allowed: false } },
        ],
      },
    });
    const k = keys(formOf(gate)!);
    expect(k).toContain("signin.auto.confirm.other");
    expect(k).not.toContain("signin.choice.keyInstead");
  });
});

describe("the gate's form closes to Welcome", () => {
  it("Escape on the confirm returns focus to Sign in", async () => {
    const { gate } = await mountGate({
      kind: "confirm",
      grant: "sg_1",
      expiresIn: 300,
      consent: CONSENT,
    });
    gate.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        composed: true,
      }),
    );
    await settle(gate);
    expect(formOf(gate)).toBeNull();
    expect(gate.shadowRoot!.activeElement).toBe(welcomeButton(gate));
  });
});
