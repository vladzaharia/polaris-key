// @pkey-feature ui.devices
//
// A rename or a remove confirmation happens in the device's own row, the list around it kept (as
// the elements draw it), not in place of the list.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiInput } from "@polaris-key/ui-core";

import { Devices } from "@polaris-key/react/kit";

afterEach(cleanup);

const devices = [
  {
    name: "Work laptop",
    platform: "macos",
    formFactor: "laptop",
    current: true,
    lastSeenDays: 0,
  },
  {
    name: "Mara's iPad",
    platform: "ios",
    formFactor: "tablet",
    current: false,
    lastSeenDays: 3,
  },
];
const input = (edit: UiInput["edit"]): UiInput =>
  ({
    elapsedMs: 60_000,
    bundle: { slug: "tidewater", name: "Tidewater Studio" },
    devices,
    edit,
  }) as UiInput;

describe("Devices edits in the row", () => {
  it("renames inside the row and keeps the other rows", () => {
    const { container } = render(
      <Devices input={input({ kind: "rename", device: "Work laptop" })} />,
    );
    const rows = container.querySelectorAll('[data-part="device-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-editing")).toBe("rename");
    expect(rows[0]!.querySelector("input")).not.toBeNull();
    expect(rows[1]!.textContent).toContain("Mara's iPad");
  });

  it("asks to remove inside the row", () => {
    const { container } = render(
      <Devices input={input({ kind: "remove", device: "Mara's iPad" })} />,
    );
    const rows = container.querySelectorAll('[data-part="device-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.getAttribute("data-editing")).toBe("remove");
    expect(
      rows[1]!.querySelector('[data-key="devices.remove"]'),
    ).not.toBeNull();
  });
});
