// @pkey-feature ui.signin ui.activate
//
// AddToAccount while the person confirms the email in Polaris Locker (UK-42.22.13F): the form
// gives way to the title, the code to check there, and Open Polaris Locker again / Cancel. The
// Add action on Done says it opens Polaris Locker when the web channel is the portal.

import { beforeAll, describe, expect, it } from "vitest";
import type { UiInput } from "@polaris-key/ui-core";

import { TAGS, type PkElement } from "../src/index.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

const base: UiInput = {
  integrator: { name: "Harbor", developer: "Tidewater" },
  platform: { os: "macos", formFactor: "mac" },
  activateDone: { deviceKind: "computer" },
  licenseHolder: {},
};

async function draw(tag: string, input: UiInput): Promise<PkElement> {
  const el = document.createElement(tag) as PkElement;
  el.input = { elapsedMs: 60_000, ...input };
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el;
}

const keys = (el: PkElement): string[] =>
  [...(el.shadowRoot ?? el).querySelectorAll("[data-key]")].map(
    (n) => n.getAttribute("data-key")!,
  );

describe("elements: AddToAccount waiting", () => {
  it("draws the code in place of the form", async () => {
    const el = await draw(TAGS.AddToAccount, {
      ...base,
      addToAccount: { step: "busy", deviceKind: "computer" },
      deviceCode: { phase: "waiting", userCode: "WDJB-MJHT" },
    });
    const root = el.shadowRoot ?? el;
    expect(root.textContent).toContain("WDJB-MJHT");
    const k = keys(el);
    expect(k).toContain("activate.attach.waitTitle");
    expect(k).toContain("activate.attach.waitCheck");
    expect(k).toContain("activate.attach.reopen");
    expect(k).toContain("common.cancel");
    for (const gone of [
      "activate.attach.name",
      "signin.email.label",
      "common.continue",
    ])
      expect(k).not.toContain(gone);
  });
  it("Done says Add opens Polaris Locker on the portal channel, and shows busy while unknown", async () => {
    const portal = await draw(TAGS.ActivateDone, {
      ...base,
      activateDone: { deviceKind: "computer", addIn: "portal" },
    });
    expect(keys(portal)).toContain("signin.key.addInLocker");
    expect(keys(portal)).not.toContain("activate.recommend.action");
    const busy = await draw(TAGS.ActivateDone, {
      ...base,
      activateDone: { deviceKind: "computer", addBusy: true },
    });
    const btn = (busy.shadowRoot ?? busy).querySelector(
      '[data-key="activate.recommend.action"]',
    );
    expect(
      btn?.getAttribute("aria-busy") ?? btn?.getAttribute("aria-disabled"),
    ).toBeTruthy();
  });
});
