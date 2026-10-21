/**
 * ProductSettingsSection stabilization (B-032, B-035): a number that only applies with a switch
 * says so and refuses edits while the switch is off, and an empty field names the platform value
 * it follows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import type { ProductSetting } from "../src/api.js";
import { renderAt, resetCore } from "./coreTestUtils.js";

const fns = vi.hoisted(() => ({ productSettings: vi.fn() }));

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      ...actual.api,
      productSettings: (...a: unknown[]) => fns.productSettings(...a),
    },
  };
});

const { ProductSettingsSection } =
  await import("../src/console/components/ProductSettingsSection.js");

function setting(key: string, over: Partial<ProductSetting>): ProductSetting {
  return {
    key,
    area: "assets",
    service: "core",
    label: key,
    description: `What ${key} does.`,
    docs: "",
    spec: { kind: "integer", unit: "count", min: 1, max: 100 },
    confirm: { up: "L0", down: "L0" },
    critical: false,
    manifestPath: null,
    visibleWhen: null,
    serviceEnabled: true,
    value: 25,
    source: "default",
    defaultValue: 25,
    version: 0,
    updatedAt: null,
    updatedBy: null,
    reason: null,
    ...over,
  };
}

beforeEach(resetCore);
afterEach(cleanup);

describe("ProductSettingsSection", () => {
  it("B-032: a key that waits for a switch is locked, with the reason, while the switch is off", async () => {
    fns.productSettings.mockResolvedValue({
      settings: [
        setting("lazy.on", {
          label: "Lazy deltas",
          spec: { kind: "switch" },
          value: "off",
          defaultValue: "off",
        }),
        setting("lazy.hot", { label: "Hot devices" }),
      ],
    });
    renderAt(
      "#/p/djdl/settings",
      <ProductSettingsSection
        slug="djdl"
        area="assets"
        id="s"
        title="Deltas"
        lockedBy={{ "lazy.hot": "lazy.on" }}
      />,
    );
    const card = await screen.findByRole("region", { name: "Deltas" });
    expect(
      await within(card).findByText("Applies once Lazy deltas is on."),
    ).toBeTruthy();
    expect(
      (within(card).getByRole("textbox") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("B-032: the key is editable once the switch is on", async () => {
    fns.productSettings.mockResolvedValue({
      settings: [
        setting("lazy.on", {
          label: "Lazy deltas",
          spec: { kind: "switch" },
          value: "on",
          defaultValue: "off",
        }),
        setting("lazy.hot", { label: "Hot devices" }),
      ],
    });
    renderAt(
      "#/p/djdl/settings",
      <ProductSettingsSection
        slug="djdl"
        area="assets"
        id="s"
        title="Deltas"
        lockedBy={{ "lazy.hot": "lazy.on" }}
      />,
    );
    const card = await screen.findByRole("region", { name: "Deltas" });
    await within(card).findByRole("textbox");
    expect(within(card).queryByText(/Applies once/)).toBeNull();
    expect(
      (within(card).getByRole("textbox") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("B-035: an unset field names the platform value it follows", async () => {
    fns.productSettings.mockResolvedValue({
      settings: [
        setting("email.dailyCap", {
          label: "Daily sign-in mail cap",
          spec: { kind: "integer", unit: "perDay", min: 1, max: 1_000_000 },
          value: null,
          defaultValue: null,
          inherited: 200,
        }),
      ],
    });
    renderAt(
      "#/p/djdl/settings",
      <ProductSettingsSection
        slug="djdl"
        area="general"
        id="s"
        title="Email"
      />,
    );
    const field = await screen.findByRole("textbox");
    expect(field.getAttribute("placeholder")).toBe(
      "Platform default: 200 a day",
    );
  });
});
