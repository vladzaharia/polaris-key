// @pkey-feature ui.devicelimit ui.devices ui.settings
//
// The look fixes from the slice-2 renders, held in the DOM: platform names never print as raw ids
// (DL8), DeviceLimit is titled Replace a device with the count as its subhead (§4.3), settings rows
// name the setting (its catalog label, never the raw key), and the split's identity panel carries
// the blurred icon only where the stylesheet shows it.

import { beforeAll, describe, expect, it } from "vitest";
import type { UiInput } from "@polaris-key/ui-core";

import { PolarisKey, type PkElement } from "../src/index.js";
import { OS_LABELS, platformLabel } from "../src/platforms.js";
import { settingLabel } from "../src/views.js";
import { readMatrix, withDefaults, type Row } from "./fixtures.js";

const matrix = readMatrix();

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

function row(family: string, name: string): Row {
  const r = (matrix[family] as Row[]).find((x) => x.name === name);
  if (!r) throw new Error(`no ${family} row ${name}`);
  return r;
}

async function draw(tag: string, input: UiInput): Promise<ShadowRoot> {
  const el = document.createElement(tag) as PkElement;
  el.input = { elapsedMs: 60_000, ...input };
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el.shadowRoot!;
}

describe("platform names (DL8)", () => {
  it("names every platform of the vocabulary, and passes a name through", () => {
    expect(platformLabel("macos")).toBe("macOS");
    expect(platformLabel("IOS")).toBe("iOS");
    expect(platformLabel("windows")).toBe("Windows");
    expect(platformLabel("ipados")).toBe("iPadOS");
    expect(platformLabel("Windows 11")).toBe("Windows 11");
    expect(platformLabel(null)).toBe("");
    for (const [id, label] of Object.entries(OS_LABELS)) {
      expect(label).not.toBe(id);
      expect(label.length).toBeGreaterThan(1);
    }
  });

  it("device rows print the name, never the id", async () => {
    const r = row("devices", "Devices/list");
    const root = await draw(
      "pk-devices",
      withDefaults(r.input, matrix.vocabulary.defaults),
    );
    const metas = [...root.querySelectorAll(".row .meta")].map(
      (n) => n.textContent ?? "",
    );
    expect(metas.length).toBeGreaterThan(0);
    for (const m of metas) expect(m).not.toMatch(/\b(macos|ios|windows)\b/);
  });
});

describe("DeviceLimit (UI-KITS.md §4.3)", () => {
  it("is titled Replace a device, with the count as the subhead above the lede", async () => {
    const r = (matrix.deviceLimit as Row[]).find(
      (x) =>
        x.expect.component === "DeviceLimit" && x.expect.state === "default",
    )!;
    const root = await draw(
      "pk-device-limit",
      withDefaults(r.input, matrix.vocabulary.defaults),
    );
    expect(root.querySelector("h1")?.getAttribute("data-key")).toBe(
      "deviceLimit.title",
    );
    const sub = root.querySelector('h2[data-key="deviceLimit.heading"]');
    expect(sub?.getAttribute("data-size")).toBe("sub");
    const order = [...root.querySelectorAll("[data-key^='deviceLimit.']")].map(
      (n) => n.getAttribute("data-key"),
    );
    expect(order.indexOf("deviceLimit.title")).toBeLessThan(
      order.indexOf("deviceLimit.heading"),
    );
    expect(order.indexOf("deviceLimit.heading")).toBeLessThan(
      order.indexOf("deviceLimit.lede"),
    );
  });
});

describe("Settings rows", () => {
  it("name each setting by its label, never its key", async () => {
    const r = row("settings", "Settings/list");
    const input = withDefaults(r.input, matrix.vocabulary.defaults);
    // A catalog label wins over the key read as words.
    input.config = input.config!.map((c, i) =>
      i === 0 ? { ...c, label: "Render quality" } : c,
    ) as UiInput["config"];
    const root = await draw("pk-settings", input);
    const titles = [
      ...root.querySelectorAll('[data-part="settings-row"] .row-title'),
    ].map((n) => n.textContent?.trim());
    expect(titles).toContain("Render quality");
    expect(titles).toContain("Audio volume");
    for (const t of titles) expect(t).not.toMatch(/^[a-z]+\.[a-z]/);
    // Booleans read On or Off; the source sits under the name.
    const values = [...root.querySelectorAll(".row-value")].map((n) =>
      n.textContent?.trim(),
    );
    expect(values).toContain("On");
    expect(values).toContain("Off");
  });

  it("reads a key as words when the catalog gives no label", () => {
    expect(
      settingLabel({
        key: "audio.masterVolume",
        type: "number",
        source: "local",
        locked: false,
      }),
    ).toBe("Audio master volume");
    expect(
      settingLabel({
        key: "net.proxy",
        type: "string",
        source: "env",
        locked: false,
        label: "Proxy server",
      }),
    ).toBe("Proxy server");
  });

  it("puts the lock on the locked row", async () => {
    const r = row("settings", "Settings/locked: set by an organization");
    const root = await draw(
      "pk-settings",
      withDefaults(r.input, matrix.vocabulary.defaults),
    );
    const lockedRow = [
      ...root.querySelectorAll('[data-part="settings-row"]'),
    ].find((n) => n.querySelector('[data-key="a11y.locked"]'));
    expect(lockedRow?.textContent).toContain("Fennick Studio");
  });
});

describe("the split's identity panel", () => {
  it("carries the blurred icon only when there is an icon", async () => {
    const r = (matrix.activate as Row[]).find(
      (x) => x.expect.component === "Welcome",
    )!;
    PolarisKey.theme({ iconSrc: "data:image/png;base64,AAAA" });
    let root = await draw(
      "pk-welcome",
      withDefaults(r.input, matrix.vocabulary.defaults),
    );
    expect(root.querySelector(".passport-ambient img")).not.toBeNull();
    PolarisKey.theme({});
    root = await draw(
      "pk-welcome",
      withDefaults(r.input, matrix.vocabulary.defaults),
    );
    expect(root.querySelector(".passport-ambient")).toBeNull();
  });
});
