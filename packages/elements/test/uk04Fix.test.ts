// @pkey-feature ui.signin ui.activate ui.settings ui.update
//
// The UK-04 fix round: Cancel as a control on the license step, the code step's countdown and
// waiting line, a refused key said once (aria-invalid, cleared on edit), the revoked screen's
// Sign in, a Settings number checked as you type, the web update prompt, and a Replace on a full
// license beside a free one.

import { beforeAll, describe, expect, it } from "vitest";
import "../src/index.js";
import type { PkElement, PkSignIn } from "../src/index.js";
import type { UiInput } from "@polaris-key/ui-core";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

const BASE: UiInput = {
  elapsedMs: 60_000,
  presentation: {
    name: "Tidewater Studio",
    developerName: "Harbor Audio",
    icon: false,
  },
  bundle: { slug: "tidewater", name: "Tidewater Studio" },
  platform: { os: "web", formFactor: "computer" },
  registration: "requires-license",
  capabilities: { signIn: true, keyEntry: true, deviceCode: true },
};

async function draw<T extends PkElement>(
  tag: string,
  input: UiInput,
  props: object = {},
): Promise<T> {
  const el = document.createElement(tag) as T;
  Object.assign(el, props);
  el.input = { ...BASE, ...input };
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el;
}

const row = (id: string, tier: string, state: "free" | "full") => ({
  id,
  tierName: tier,
  name: null,
  origin: "account" as const,
  access: "seats" as const,
  seats: { used: state === "free" ? 1 : 3, limit: 3 },
  current: false,
  expiresAt: null,
  state,
  replace: { allowed: true, retryAfter: null },
  freeDeviceUrl: null,
});

const q = (el: PkElement, sel: string) => el.shadowRoot!.querySelector(sel);

describe("UK-04 fix", () => {
  it("draws Cancel on the license step as a secondary button", async () => {
    const el = await draw<PkSignIn>("pk-sign-in", {
      signIn: {
        presentation: "inline",
        replace: "inline",
        channel: "browser",
        outcome: "choose",
      },
      choices: {
        state: "choose",
        keep: false,
        preselected: "a",
        create: null,
        getLicense: null,
        choices: [row("a", "Pro", "free"), row("b", "Team", "full")],
      },
    });
    const cancel = q(el, 'button[data-key="common.cancel"]');
    expect(cancel?.getAttribute("data-variant")).toBe("secondary");
    expect(q(el, 'p[data-key="common.cancel"]')).toBeNull();
    // The full license beside a free one carries its own Replace.
    const replace = q(
      el,
      '[data-id="b"] button[data-key="signin.replace.open"]',
    );
    expect(replace).not.toBeNull();
  });

  it("gives the code step a countdown, a waiting line and Cancel", async () => {
    const el = await draw<PkSignIn>("pk-sign-in-handoff", {
      signIn: {
        presentation: "inline",
        replace: "inline",
        channel: "device-code",
        browserOpened: false,
      },
      deviceCode: {
        phase: "waiting",
        userCode: "WDJB-MJHT",
        secondsLeft: 598,
        verificationUri: "https://polaris.locker/device",
      },
    });
    const root = el.shadowRoot!;
    expect(root.textContent).toContain("9:58");
    expect(q(el, '[data-key="cli.signin.waitingCode"]')).not.toBeNull();
    expect(q(el, 'button[data-key="common.cancel"]')).not.toBeNull();
  });

  it("says a refusal once, links it to the field and clears it on edit", async () => {
    const el = await draw<PkElement>("pk-activate", {
      keyField: { text: "pkey_tidewater_nope" },
      activation: { result: "unauthorized" },
    });
    const field = q(el, "input#pk-key") as HTMLInputElement;
    // A key the service does not know is the input being wrong (DL7): the stroke and the link.
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe("pk-message");
    const callout = q(el, ".callout");
    expect(callout?.getAttribute("data-tone")).toBe("danger");
    expect(callout?.querySelectorAll("span")).toHaveLength(1);
    field.value = "pkey_tidewater_other";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;
    expect(q(el, ".callout")).toBeNull();
    expect(
      (q(el, "input#pk-key") as HTMLInputElement).getAttribute("aria-invalid"),
    ).toBe("false");
  });

  it("offers Sign in first on a revoked device, with no Sign out", async () => {
    const el = await draw<PkElement>("pk-status-screen", {
      gate: { status: "revoked" },
    });
    expect(
      q(el, 'button[data-key="welcome.signIn"]')?.getAttribute("data-variant"),
    ).toBe("primary");
    expect(
      q(el, 'button[data-key="signin.key.differentKey"]')?.getAttribute(
        "data-variant",
      ),
    ).toBe("secondary");
    expect(q(el, '[data-key="common.signOut"]')).toBeNull();
  });

  it("checks a Settings number as you type and holds Save", async () => {
    const el = await draw<PkElement>("pk-settings", {
      config: [
        {
          key: "audio.volume",
          value: 120,
          source: "local",
          locked: false,
          type: "number",
          min: 0,
          max: 100,
        },
      ],
      edit: { kind: "value" },
    });
    const field = q(el, 'input[type="number"]') as HTMLInputElement;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const id = field.getAttribute("aria-describedby")!;
    expect(el.shadowRoot!.getElementById(id)?.getAttribute("data-tone")).toBe(
      "danger",
    );
    expect(
      q(el, 'button[data-key="common.save"]')?.getAttribute("aria-disabled"),
    ).toBe("true");
    field.value = "40";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;
    expect(
      (q(el, 'input[type="number"]') as HTMLInputElement).getAttribute(
        "aria-invalid",
      ),
    ).toBe("false");
    expect(
      q(el, 'button[data-key="common.save"]')?.getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("draws the web update as one Download action and Later", async () => {
    const el = await draw<PkElement>("pk-update-prompt", {
      bundle: { slug: "tidewater", name: "Tidewater Studio", version: "2.4.1" },
      update: { action: "binary", version: "2.5.0" },
    });
    const root = el.shadowRoot!;
    expect(q(el, 'button[data-key="update.install"]')?.textContent).toContain(
      "2.5.0",
    );
    expect(q(el, '[data-key="update.restartWhenReady"]')).toBeNull();
    expect(root.querySelectorAll(".actions button[data-variant]")).toHaveLength(
      2,
    );
  });

  it("offers Use a different key over the device limit", async () => {
    const el = await draw<PkElement>("pk-activate", {
      keyField: { text: "pkey_full" },
      activation: { result: "device-limit", limit: 3, deviceCount: 3 },
    });
    const other = q(el, '[data-key="signin.key.differentKey"]') as HTMLElement;
    expect(other).not.toBeNull();
    other.click();
    await el.updateComplete;
    expect(q(el, '[data-key="activate.submit"]')).not.toBeNull();
  });
});
