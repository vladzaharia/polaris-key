// @pkey-feature ui.settings
//
// The React Settings pane draws the typed controls the elements do (UI-KITS.md §4.1): a switch, a
// slider for a bounded number, a number field, a select, text with its length limit; a locked row
// is its value as text; Reset to default waits for a change of the person's, Show advanced for an
// advanced row and toggles in the pane.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiInput } from "@polaris-key/ui-core";

import { Settings } from "@polaris-key/react/kit";

afterEach(cleanup);

const row = (over: Record<string, unknown>) => ({
  source: "default",
  locked: false,
  ...over,
});
const input = (config: unknown[]): UiInput =>
  ({
    elapsedMs: 60_000,
    bundle: { slug: "tidewater", name: "Tidewater Studio" },
    presentation: {
      name: "Tidewater Studio",
      developerName: "Harbor",
      icon: false,
    },
    config,
  }) as UiInput;

describe("Settings controls", () => {
  it("draws the control each row's type calls for, without a host handler", () => {
    const { container } = render(
      <Settings
        input={input([
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
        ])}
      />,
    );
    expect(container.querySelector('[role="switch"]')).not.toBeNull();
    const slider = container.querySelector<HTMLInputElement>(
      'input[type="range"]',
    )!;
    expect([slider.min, slider.max, slider.step]).toEqual(["0", "10", "1"]);
    expect(container.querySelector('input[type="number"]')).not.toBeNull();
    const select = container.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("b");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(
      container.querySelector<HTMLInputElement>('input[type="text"]')!
        .maxLength,
    ).toBe(8);
  });

  it("reports a slider move as config:<key>", () => {
    const onInput = vi.fn();
    const { container } = render(
      <Settings
        onInput={onInput}
        input={input([
          row({ key: "a.vol", type: "number", value: 5, min: 0, max: 10 }),
        ])}
      />,
    );
    fireEvent.change(container.querySelector('input[type="range"]')!, {
      target: { value: "7" },
    });
    expect(onInput).toHaveBeenCalledWith("config:a.vol", "7");
  });

  it("shows a locked row as text, with no control", () => {
    const { container } = render(
      <Settings
        input={input([
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
        ])}
      />,
    );
    expect(
      container.querySelector('[role="switch"], input, select'),
    ).toBeNull();
    expect(container.textContent).toContain("5 dB");
  });

  it("offers Reset to default after a local change, and Show advanced reveals advanced rows", () => {
    const plain = render(
      <Settings
        input={input([row({ key: "a.on", type: "boolean", value: true })])}
      />,
    );
    expect(
      plain.container.querySelector('[data-key="settings.reset"]'),
    ).toBeNull();
    expect(
      plain.container.querySelector('[data-key="settings.advanced"]'),
    ).toBeNull();
    cleanup();
    const { container } = render(
      <Settings
        input={input([
          row({ key: "a.on", type: "boolean", value: true, source: "local" }),
          row({ key: "a.dbg", type: "boolean", value: false, advanced: true }),
        ])}
      />,
    );
    expect(
      container.querySelector('[data-key="settings.reset"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
    fireEvent.click(container.querySelector('[data-key="settings.advanced"]')!);
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(2);
  });
});
