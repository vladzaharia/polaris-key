// @pkey-feature ui.signin ui.devices ui.settings ui.update ui.paywall ui.activate
//
// The built UX review of UK-04 (ux-UK-04.json): the functional blockers, one test each. No raw
// placeholder reaches a person; the license step draws its rows in every choices shape; the
// keyboard moves the choice; a full license can be replaced; the form finishes with a signal; the
// sheet closes on a phone; events carry what a host needs; the panes have real controls; the
// update prompt names the installed version; offline activation reads in order; the paywall
// shows its offers.

import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  LicenseChoiceRow,
  LicenseChoiceView,
  SignInPrimitives,
  SignInWait,
  UiInput,
} from "@polaris-key/ui-core";

import {
  PolarisKey,
  TAGS,
  type PkElement,
  type PkSignIn,
} from "../src/index.js";
import {
  COMPONENT_FAMILIES,
  familyRows,
  readMatrix,
  withDefaults,
  type Row,
} from "./fixtures.js";

const matrix = readMatrix();
const defaults = matrix.vocabulary.defaults;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const base = (extra: Partial<UiInput> = {}): UiInput => ({
  elapsedMs: 60_000,
  ...withDefaults({}, defaults),
  ...extra,
});

async function draw<T extends PkElement>(
  tag: string,
  input: UiInput,
  props: Record<string, unknown> = {},
): Promise<T> {
  const el = document.createElement(tag) as T;
  Object.assign(el, { input }, props);
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el;
}

const flush = async (el: PkElement) => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
};

const session = (
  over: Record<string, unknown> = {},
): NonNullable<UiInput["signIn"]> =>
  ({
    presentation: "inline",
    replace: "inline",
    channel: "browser",
    outcome: "choose",
    ...over,
  }) as NonNullable<UiInput["signIn"]>;

const row = (id: string, over: Partial<LicenseChoiceRow> = {}) =>
  ({
    id,
    tierName: id === "lic_a" ? "Pro" : "Plus",
    name: null,
    origin: "signin",
    access: "seats",
    seats: { used: 1, limit: 3 },
    current: false,
    expiresAt: null,
    state: "free",
    replace: null,
    freeDeviceUrl: null,
    ...over,
  }) as LicenseChoiceRow;

const view = (
  choices: LicenseChoiceRow[],
  over: Partial<LicenseChoiceView> = {},
): LicenseChoiceView => ({
  state: "choose",
  choices,
  keep: false,
  preselected: choices[0]?.id ?? null,
  create: null,
  getLicense: null,
  ...over,
});

describe("no raw placeholder reaches a person", () => {
  for (const family of COMPONENT_FAMILIES)
    it(`${family}: every row draws without a brace`, async () => {
      for (const r of familyRows(matrix, family)) {
        const tag = TAGS[r.expect.component as keyof typeof TAGS];
        const el = await draw(tag, base(withDefaults(r.input, defaults)));
        const shown =
          el.shadowRoot!.querySelector(".pk-root")?.textContent ?? "";
        expect(shown, r.name).not.toMatch(/\{[A-Za-z]+\}/);
      }
    });
});

describe("the license step draws its rows in every choices shape", () => {
  const shapes: [string, LicenseChoiceView][] = [
    ["one", view([row("lic_a")])],
    ["many", view([row("lic_a"), row("lic_b")])],
    [
      "mixed",
      view([row("lic_a"), row("lic_b", { access: "account" })], {
        preselected: "lic_a",
      }),
    ],
    ["current", view([row("lic_a", { current: true }), row("lic_b")])],
  ];
  for (const [name, choices] of shapes)
    it(name, async () => {
      const el = await draw(
        "pk-license-choice",
        base({ choices, signIn: session() }),
      );
      const root = el.shadowRoot!;
      expect(root.querySelector("h1")).not.toBeNull();
      expect(root.querySelectorAll('[role="radio"]')).toHaveLength(
        choices.choices.length,
      );
      expect(
        root.querySelector('[data-key="signin.choice.continue"]'),
      ).not.toBeNull();
      expect(root.querySelector('[data-key="common.cancel"]')).not.toBeNull();
    });

  it("raced keeps the rows to choose from", async () => {
    const el = await draw(
      "pk-license-choice",
      base({
        choices: view([row("lic_a"), row("lic_b")]),
        signIn: session({ raced: true }),
      }),
    );
    expect(el.view.state).toBe("raced");
    expect(el.shadowRoot!.querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect(el.shadowRoot!.querySelector("h1")).not.toBeNull();
  });

  it("arrow keys move the choice and Space picks it", async () => {
    const el = await draw(
      "pk-license-choice",
      base({
        choices: view([row("lic_a"), row("lic_b"), row("lic_c")]),
        signIn: session(),
      }),
    );
    const root = el.shadowRoot!;
    const radios = () =>
      [...root.querySelectorAll<HTMLElement>('[role="radio"]')].map((r) =>
        r.getAttribute("aria-checked"),
      );
    expect(radios()).toEqual(["true", "false", "false"]);
    const picks: string[] = [];
    el.addEventListener("pk-select", (e) =>
      picks.push((e as CustomEvent).detail.id),
    );
    const first = root.querySelector<HTMLElement>('[role="radio"]')!;
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await el.updateComplete;
    expect(picks).toEqual(["lic_b"]);
    expect(radios()).toEqual(["false", "true", "false"]);
  });

  it("all-full draws Replace a device on each full license, carrying its id", async () => {
    const full = (id: string) =>
      row(id, {
        state: "full",
        seats: { used: 3, limit: 3 },
        replace: { allowed: true, retryAfter: null },
      });
    const el = await draw(
      "pk-license-choice",
      base({
        choices: view([full("lic_a"), full("lic_b")], { preselected: null }),
        signIn: session(),
      }),
    );
    expect(el.view.state).toBe("all-full");
    const buttons = el.shadowRoot!.querySelectorAll<HTMLElement>(
      'button[data-key="signin.replace.open"]',
    );
    expect(buttons).toHaveLength(2);
    expect(
      el.shadowRoot!.querySelector('[data-key="common.cancel"]'),
    ).not.toBeNull();
    let detail: Record<string, unknown> | null = null;
    el.addEventListener("pk-action", (e) => {
      detail = (e as CustomEvent).detail;
    });
    buttons[1]!.click();
    expect(detail).toMatchObject({
      key: "signin.replace.open",
      licenseId: "lic_b",
    });
  });
});

describe("the form finishes with a signal", () => {
  const choices = view([row("lic_a")]);
  const primitives = (done: SignInWait): SignInPrimitives => {
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
        complete: async () => done as never,
        cancel: async () => {},
      },
    };
  };

  it("fires pk-done and names the license, never a placeholder", async () => {
    const el = await draw<PkSignIn>(
      "pk-sign-in",
      base({ account: { signedIn: true, holder: "Mara" } }),
      { primitives: primitives({ outcome: "signedIn", issuedNow: true }) },
    );
    let done = 0;
    el.addEventListener("pk-done", () => done++);
    el.shadowRoot!.querySelector<HTMLElement>(
      `[data-key="${el.view.decisions.primary}"]`,
    )!.click();
    await flush(el);
    el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="signin.choice.continue"]',
    )!.click();
    await flush(el);
    expect(el.view.state).toBe("done");
    expect(done).toBe(1);
    const root = el.shadowRoot!;
    expect(root.textContent).not.toMatch(/\{[a-z]+\}/);
    expect(root.querySelector("h1")).not.toBeNull();
    expect(root.querySelector('[data-key="signin.done.start"]')).not.toBeNull();
  });

  it("a sheet has a close control and closes on the scrim", async () => {
    const el = await draw<PkSignIn>(
      "pk-sign-in",
      base({
        signIn: {
          presentation: "sheet",
          replace: "inline",
          channel: "browser",
        },
      }),
      { presentation: "sheet" },
    );
    const root = el.shadowRoot!;
    expect(root.querySelector('button[data-part="close"]')).not.toBeNull();
    el.open = true;
    let closed = 0;
    el.addEventListener("pk-close", () => closed++);
    root.querySelector<HTMLElement>('button[data-part="close"]')!.click();
    expect(closed).toBe(1);
    expect(el.open).toBe(false);
    el.open = true;
    root
      .querySelector("dialog")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closed).toBe(2);
  });
});

describe("events carry what a host needs to finish the task", () => {
  const devices = [
    {
      id: "dev_1",
      name: "Work laptop",
      platform: "windows",
      formFactor: "computer",
      lastSeenDays: 2,
      current: false,
    },
    {
      id: "dev_2",
      name: "Mara's iPad",
      platform: "ios",
      formFactor: "ipad",
      lastSeenDays: 5,
      current: false,
    },
  ];

  it("Devices: rename in the row sends the id and the typed name", async () => {
    const el = await draw("pk-devices", base({ devices }));
    const root = el.shadowRoot!;
    const actions: Record<string, unknown>[] = [];
    el.addEventListener("pk-action", (e) =>
      actions.push((e as CustomEvent).detail),
    );
    root
      .querySelectorAll<HTMLElement>('button[data-key="devices.rename"]')[1]!
      .click();
    await flush(el);
    expect(el.view.state).toBe("renaming");
    // The list stays, with the field in the row.
    expect(root.querySelectorAll('[data-part="device-row"]')).toHaveLength(2);
    const input = root.querySelector<HTMLInputElement>("#pk-rename")!;
    input.value = "Studio iPad";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(actions.at(-1)).toMatchObject({
      key: "common.save",
      deviceId: "dev_2",
      name: "Studio iPad",
    });
  });

  it("Devices: remove asks inline, then sends the id", async () => {
    const el = await draw("pk-devices", base({ devices }));
    const root = el.shadowRoot!;
    const actions: Record<string, unknown>[] = [];
    el.addEventListener("pk-action", (e) =>
      actions.push((e as CustomEvent).detail),
    );
    root
      .querySelectorAll<HTMLElement>('button[data-key="devices.remove"]')[0]!
      .click();
    await flush(el);
    expect(actions).toHaveLength(0);
    expect(el.view.state).toBe("confirming");
    root
      .querySelector<HTMLElement>(
        '[data-part="confirm"] button[data-key="devices.remove"]',
      )!
      .click();
    expect(actions[0]).toMatchObject({
      key: "devices.remove",
      deviceId: "dev_1",
    });
  });

  it("OfflineActivation: the pasted response is emitted and sent with Activate", async () => {
    const el = await draw(
      "pk-offline-activation",
      base({
        capabilities: { offlineActivation: true },
        offline: { requestCode: "REQ-1234-ABCD" },
      }),
    );
    const root = el.shadowRoot!;
    // Two numbered steps, the request code first and shown.
    expect(root.querySelectorAll('[data-part="step"]')).toHaveLength(2);
    expect(root.textContent).toContain("REQ-1234-ABCD");
    const inputs: unknown[] = [];
    el.addEventListener("pk-input", (e) =>
      inputs.push((e as CustomEvent).detail),
    );
    const area = root.querySelector<HTMLTextAreaElement>("#pk-response")!;
    area.value = "RESPONSE";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    expect(inputs.at(-1)).toMatchObject({
      field: "response",
      value: "RESPONSE",
    });
    await el.updateComplete;
    let detail: Record<string, unknown> | null = null;
    el.addEventListener("pk-action", (e) => {
      detail = (e as CustomEvent).detail;
    });
    root
      .querySelector<HTMLElement>(
        'button[data-key="offlineActivation.submit"]',
      )!
      .click();
    expect(detail).toMatchObject({ response: "RESPONSE" });
  });
});

describe("the panes have real controls", () => {
  it("Settings: a switch, a number field, and advanced rows behind their toggle", async () => {
    const config = [
      {
        key: "audio.sound",
        type: "boolean",
        source: "default",
        locked: false,
        value: true,
      },
      {
        key: "audio.volume",
        type: "number",
        source: "local",
        locked: false,
        value: 80,
        min: 0,
        max: 100,
      },
      {
        key: "debug.logging",
        type: "boolean",
        source: "default",
        locked: false,
        value: false,
        advanced: true,
      },
    ];
    const el = await draw("pk-settings", base({ config }));
    const root = el.shadowRoot!;
    expect(root.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(root.querySelector('input[type="range"]')).not.toBeNull();
    const events: unknown[] = [];
    el.addEventListener("pk-input", (e) =>
      events.push((e as CustomEvent).detail),
    );
    root.querySelector<HTMLElement>('[role="switch"]')!.click();
    await flush(el);
    expect(events.at(-1)).toMatchObject({
      field: "setting",
      key: "audio.sound",
      value: false,
    });
    expect(el.view.state).toBe("dirty");
    expect(root.querySelector("h1,h2")).not.toBeNull();
  });

  it("a pane heads at h2 and never takes focus on mount", async () => {
    const host = document.createElement("button");
    document.body.replaceChildren(host);
    const el = await draw(
      "pk-devices",
      base({
        devices: [
          {
            id: "d1",
            name: "Laptop",
            platform: "windows",
            formFactor: "computer",
            lastSeenDays: 1,
            current: false,
          },
        ],
      }),
    );
    expect(el.shadowRoot!.querySelector("h1")).toBeNull();
    expect(el.shadowRoot!.querySelector("h2")).not.toBeNull();
    expect(document.activeElement).not.toBe(el);
  });

  it("ChannelPicker: a Stable and Beta choice that emits pk-input", async () => {
    const el = await draw(
      "pk-channel-picker",
      base({ channel: { locked: false, current: "stable" } }),
    );
    const events: unknown[] = [];
    el.addEventListener("pk-input", (e) =>
      events.push((e as CustomEvent).detail),
    );
    const radios =
      el.shadowRoot!.querySelectorAll<HTMLElement>('[role="radio"]');
    expect(radios).toHaveLength(2);
    radios[1]!.click();
    expect(events.at(-1)).toMatchObject({ field: "channel", value: "beta" });
  });

  it("AccountAndLicense: label and value rows with a switch and the channel choice", async () => {
    const el = await draw(
      "pk-account-and-license",
      base({
        account: {
          signedIn: true,
          holder: "Mara",
          tier: "Pro",
          devices: { used: 2, limit: 3 },
          autoUpdate: true,
        },
        bundle: {
          slug: "tidewater",
          name: "Tidewater Studio",
          version: "2.4.1",
        },
        channel: { locked: false, current: "stable" },
      }),
    );
    const root = el.shadowRoot!;
    expect(root.textContent).toContain("2 of 3");
    expect(root.querySelector('[role="switch"]')).not.toBeNull();
    expect(root.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(root.textContent).toContain("Version 2.4.1");
  });

  it.each([true, "line", "badge"] as const)(
    "theme.poweredBy %s reaches the pane through the theme; the badge is About's only (LK-16)",
    async (poweredBy) => {
      PolarisKey.theme({ poweredBy });
      try {
        const el = await draw(
          "pk-account-and-license",
          base({ account: { signedIn: true, holder: "Mara", tier: "Pro" } }),
        );
        const root = el.shadowRoot!;
        expect(
          root.querySelector('[data-part="powered-by"]')!.textContent!.trim(),
        ).toBe("Powered by Polaris Locker");
        expect(root.querySelector('[data-part="powered-by-badge"]')).toBeNull();
      } finally {
        PolarisKey.theme({});
      }
    },
  );

  it("AccountAndLicense poweredBy: the Locker micro mark and the phrase in live text, never the badge (LK-16)", async () => {
    for (const poweredBy of ["line", "badge"] as const) {
      const el = await draw(
        "pk-account-and-license",
        base({
          account: { signedIn: true, holder: "Mara", tier: "Pro" },
          integrator: { poweredBy },
        }),
      );
      const root = el.shadowRoot!;
      const line = root.querySelector('[data-part="powered-by"]')!;
      expect(line.textContent!.trim()).toBe("Powered by Polaris Locker");
      const mark = line.querySelector("svg")!;
      expect(mark.getAttribute("width")).toBe("16");
      expect(mark.getAttribute("viewBox")).toBe("0 0 16 16");
      expect(mark.getAttribute("aria-hidden")).toBe("true");
      expect(root.querySelector('[data-part="powered-by-badge"]')).toBeNull();
      expect(root.innerHTML).not.toContain("Polaris Key");
    }
  });

  it("About poweredBy badge: the 320 x 104 Locker badge with the line as its fallback (LK-16)", async () => {
    const el = await draw(
      "pk-about",
      base({ integrator: { poweredBy: "badge" } }),
    );
    const root = el.shadowRoot!;
    const badge = root.querySelector('[data-part="powered-by-badge"] svg')!;
    expect(badge.getAttribute("viewBox")).toBe("0 0 320 104");
    expect(badge.getAttribute("width")).toBe("320");
    expect(badge.getAttribute("aria-label")).toBe("Powered by Polaris Locker");
    expect(root.querySelector('[data-part="powered-by"]')).not.toBeNull();
  });
});

describe("the update prompt", () => {
  it("names the installed version, the size and the release notes", async () => {
    const el = await draw(
      "pk-update-prompt",
      base({
        bundle: {
          slug: "tidewater",
          name: "Tidewater Studio",
          version: "2.4.1",
        },
        update: {
          action: "binary",
          version: "2.5.0",
          size: "61 MB",
        },
        releaseNotes: [
          {
            version: "2.5.0",
            date: "Oct 1",
            notes: "Faster sync.\nFixes a crash.",
          },
        ],
      }),
    );
    const text = el.shadowRoot!.querySelector(".pk-root")?.textContent ?? "";
    expect(text).toContain("You have 2.4.1");
    expect(text).toContain("61 MB");
    expect(text).toContain("Faster sync.");
    expect(text).not.toMatch(/\{[a-z]+\}/);
  });
});

describe("the paywall", () => {
  it("draws its offers with prices and sends the chosen one", async () => {
    const el = await draw(
      "pk-paywall",
      base({
        platform: { os: "ios", formFactor: "iphone" },
        capabilities: { purchase: true },
        entitlement: { name: "pro", entitled: false, tier: "Pro" },
        offers: {
          available: true,
          items: [
            { id: "o_year", name: "Pro", price: "$29", term: "per year" },
            { id: "o_life", name: "Pro Lifetime", price: "$79", term: "once" },
          ],
        },
      }),
    );
    const root = el.shadowRoot!;
    expect(root.querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect(root.textContent).toContain("$79");
    root.querySelectorAll<HTMLElement>('[role="radio"]')[1]!.click();
    await el.updateComplete;
    let detail: Record<string, unknown> | null = null;
    el.addEventListener("pk-action", (e) => {
      detail = (e as CustomEvent).detail;
    });
    root.querySelector<HTMLElement>('[data-variant="primary"]')!.click();
    expect(detail).toMatchObject({ offerId: "o_life" });
  });

  it("not-available offers the store page as its one action", async () => {
    const el = await draw(
      "pk-paywall",
      base({
        entitlement: { name: "pro", entitled: false, tier: "Pro" },
        offers: { available: false, url: "https://store.example/pro" },
      }),
    );
    const btn = el.shadowRoot!.querySelector<HTMLElement>(
      'button[data-key="paywall.portal"]',
    );
    expect(btn).not.toBeNull();
    let detail: Record<string, unknown> | null = null;
    el.addEventListener("pk-action", (e) => {
      detail = (e as CustomEvent).detail;
    });
    btn!.click();
    expect(detail).toMatchObject({ url: "https://store.example/pro" });
  });
});
