// @pkey-feature ui.settings
//
// Settings draws a typed control per catalog row (UI-KITS.md §4.1): a switch, a slider for a
// bounded number, a number field for an unbounded one, a select for an enum, text with its length
// limit; a locked row is its value as text; Reset to default waits for a change of the person's and
// Show advanced for an advanced row. The React kit draws the same (sdk-react test/kitSettingsControls).

import { beforeAll, describe, expect, it } from "vitest";
import "../src/index.js";
import type { PkElement } from "../src/index.js";
import type { UiInput } from "@polaris-key/ui-core";
import { floatingRow } from "./holdersFixtures.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

const row = (over: Record<string, unknown>) => ({
  source: "default",
  locked: false,
  ...over,
});

async function draw(config: unknown[]): Promise<ShadowRoot> {
  const el = document.createElement("pk-settings") as PkElement;
  el.input = {
    elapsedMs: 60_000,
    bundle: { slug: "tidewater", name: "Tidewater Studio" },
    presentation: {
      name: "Tidewater Studio",
      developerName: "Harbor",
      icon: false,
    },
    config,
  } as UiInput;
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el.shadowRoot!;
}

describe("Settings controls", () => {
  it("draws the control each row's type calls for", async () => {
    const root = await draw([
      row({ key: "a.on", type: "boolean", value: true }),
      row({ key: "a.vol", type: "number", value: 5, min: 0, max: 10 }),
      row({ key: "a.count", type: "number", value: 5 }),
      row({
        key: "a.mode",
        type: "string",
        value: "b",
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
      }),
      row({ key: "a.name", type: "string", value: "x", maxLength: 8 }),
    ]);
    expect(root.querySelector('[role="switch"]')).not.toBeNull();
    const slider = root.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect([slider.min, slider.max, slider.step]).toEqual(["0", "10", "1"]);
    expect(root.querySelector('input[type="number"]')).not.toBeNull();
    const select = root.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("b");
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(
      root.querySelector<HTMLInputElement>('input[type="text"]')!.maxLength,
    ).toBe(8);
  });

  it("shows a locked row as text, with no control", async () => {
    const root = await draw([
      row({
        key: "net.lock",
        type: "boolean",
        value: true,
        locked: true,
        source: "enforced",
        org: "Fennick",
      }),
      row({
        key: "a.vol",
        type: "number",
        value: 5,
        min: 0,
        max: 10,
        locked: true,
        source: "enforced",
        display: "5 dB",
      }),
    ]);
    expect(root.querySelector('[role="switch"], input, select')).toBeNull();
    expect(root.textContent).toContain("5 dB");
    // The locked rows are their own group, under "Managed settings".
    const managed = root.querySelector("[data-managed]");
    expect(
      managed?.querySelectorAll('[data-part="settings-row"]'),
    ).toHaveLength(2);
    expect(root.querySelectorAll('[data-part="settings-group"]')).toHaveLength(
      1,
    );
  });

  it("offers Reset to default after a local change and Show advanced for an advanced row", async () => {
    const plain = await draw([
      row({ key: "a.on", type: "boolean", value: true }),
    ]);
    expect(plain.querySelector('[data-key="settings.reset"]')).toBeNull();
    expect(plain.querySelector('[data-key="settings.advanced"]')).toBeNull();
    const changed = await draw([
      row({ key: "a.on", type: "boolean", value: true, source: "local" }),
      row({ key: "a.dbg", type: "boolean", value: false, advanced: true }),
    ]);
    expect(changed.querySelector('[data-key="settings.reset"]')).not.toBeNull();
    expect(
      changed.querySelector('[data-key="settings.advanced"]'),
    ).not.toBeNull();
    expect(changed.querySelectorAll('[role="switch"]')).toHaveLength(1);
  });
});

describe("AccountAndLicense: a floating license (UK-42.8)", () => {
  async function drawRow(input: UiInput): Promise<PkElement> {
    const el = document.createElement("pk-account-and-license") as PkElement;
    el.input = input;
    document.body.replaceChildren(el);
    await el.updateComplete;
    return el;
  }

  it("says it is not in an account, with the one Add action in the row", async () => {
    const el = await drawRow(floatingRow());
    const root = el.shadowRoot!;
    const row = root.querySelector('[data-key="account.notInAccount"]')!;
    expect(row.closest("li")).not.toBeNull();
    // The label and its action are drawn once each: no body copy of the same keys.
    expect(
      root.querySelectorAll('[data-key="account.notInAccount"]'),
    ).toHaveLength(1);
    expect(
      root.querySelectorAll('[data-key="activate.recommend.action"]'),
    ).toHaveLength(1);
    expect(root.querySelector('[data-key="account.keyOnly"]')).toBeNull();
    let detail: Record<string, unknown> | null = null;
    el.addEventListener("pk-action", (e) => {
      detail = (e as CustomEvent).detail;
    });
    root
      .querySelector<HTMLElement>(
        'button[data-key="activate.recommend.action"]',
      )!
      .click();
    expect(detail).toMatchObject({
      key: "activate.recommend.action",
      component: "AccountAndLicense",
    });
  });

  it("keeps the Add action with Identity off: the host opens the portal", async () => {
    const el = await drawRow(floatingRow(["license"]));
    expect(
      el.shadowRoot!.querySelector(
        'button[data-key="activate.recommend.action"]',
      ),
    ).not.toBeNull();
  });

  it("a license waiting for an email keeps the key-only line and no Add", async () => {
    const el = await drawRow({
      ...floatingRow(),
      licenseHolder: { email: "mara@example.test" },
    });
    const root = el.shadowRoot!;
    expect(root.querySelector('[data-key="account.keyOnly"]')).not.toBeNull();
    expect(
      root.querySelector('[data-key="activate.recommend.action"]'),
    ).toBeNull();
    expect(root.textContent).not.toContain("mara@example.test");
  });
});
