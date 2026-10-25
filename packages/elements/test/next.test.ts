// @pkey-feature ui.signin ui.devicelimit ui.update ui.settings
//
// The next slice of the UK-04 review (ux-UK-04.json, ux-UK-05.json): the failed sign-in keeps the
// other methods, the Replace step's primary names the device, the count is stated once, an
// optional update is a dialog and a mandatory one is a screen, and a setting key reads as a
// label ("UI compact").

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { UiInput } from "@polaris-key/ui-core";

import {
  settingLabel,
  type PkElement,
  type PkUpdatePrompt,
} from "../src/index.js";
import { readMatrix, withDefaults, type Row } from "./fixtures.js";

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

const row = (family: string, name: string): UiInput => {
  const r = (matrix[family] as Row[]).find((x) => x.name === name);
  if (!r) throw new Error(`no ${family} row ${name}`);
  return { elapsedMs: 60_000, ...withDefaults(r.input, defaults) };
};

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

describe("the sign-in error", () => {
  it("keeps the methods, with the failure under the title and no or-divider", async () => {
    const el = await draw(
      "pk-sign-in",
      row("signIn", "SignIn/error: a sign-in method failed"),
    );
    const root = el.shadowRoot!;
    expect(
      root.querySelector('[data-key="signIn.methodError"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-key="signin.provider.continue"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-key="common.cancel"]')).not.toBeNull();
    expect(root.querySelector('[data-key="signin.provider.group"]')).toBeNull();
    expect(root.querySelector('[data-key="signin.menu.signIn"]')).toBeNull();
  });
});

describe("Replace a device", () => {
  it("names the device in the primary and states the count once", async () => {
    const el = await draw(
      "pk-device-limit",
      row("deviceLimit", "DeviceLimit/default: the devices listed in the app"),
    );
    const root = el.shadowRoot!;
    const primary = root.querySelector('[data-part="primary"]')!;
    expect(primary.textContent).toContain("Replace Work laptop");
    expect(
      root.querySelector('[data-key="part.seatMeter.caption"]'),
    ).toBeNull();
    expect(
      root.querySelector('[data-key="deviceLimit.heading"]'),
    ).not.toBeNull();
  });

  it("scrolls the list in its own box past six devices", async () => {
    const base = row(
      "deviceLimit",
      "DeviceLimit/default: the devices listed in the app",
    );
    const devices = Array.from({ length: 9 }, (_, i) => ({
      id: `d${i}`,
      name: `Device ${i}`,
      platform: "windows",
      formFactor: "computer",
      lastSeenDays: i,
      current: false,
    }));
    const el = await draw("pk-device-limit", { ...base, devices });
    const list = el.shadowRoot!.querySelector('[data-part="device-list"]')!;
    expect(list.hasAttribute("data-scroll")).toBe(true);
    expect(
      el.shadowRoot!.querySelector('[data-part="primary"]')!.textContent,
    ).toContain("Replace Device 8");
  });
});

describe("pk-update-prompt", () => {
  it("is a dialog over the host when the update is optional; Later closes it and the host hears it", async () => {
    const el = await draw<PkUpdatePrompt>(
      "pk-update-prompt",
      row("update", "UpdatePrompt/available"),
    );
    const root = el.shadowRoot!;
    const dialog = root.querySelector("dialog.sheet");
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-labelledby")).toBe("pk-title");
    const seen: string[] = [];
    el.addEventListener("pk-action", (e) =>
      seen.push((e as CustomEvent).detail.key),
    );
    root.querySelector<HTMLElement>('[data-key="update.later"]')!.click();
    await el.updateComplete;
    expect(seen).toContain("update.later");
    expect(root.querySelector("dialog")).toBeNull();
  });

  it("owns the window as a screen when the update is mandatory", async () => {
    const el = await draw<PkUpdatePrompt>(
      "pk-update-prompt",
      row("update", "UpdatePrompt/mandatory"),
    );
    expect(el.shadowRoot!.querySelector("dialog")).toBeNull();
    expect(el.shadowRoot!.querySelector(".stage")).not.toBeNull();
  });
});

describe("setting labels", () => {
  it("spell acronyms in capitals", () => {
    const r = (key: string) => ({
      key,
      type: "boolean",
      source: "default",
      locked: false,
    });
    expect(settingLabel(r("ui.compact"))).toBe("UI compact");
    expect(settingLabel(r("net.proxyUrl"))).toBe("Net proxy URL");
    expect(settingLabel(r("audio.volume"))).toBe("Audio volume");
  });
});
