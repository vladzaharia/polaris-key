/**
 * ST-08n: a view-only member's lock. Write controls render locked (a Button stays focusable with
 * the reason; an input is read-only, not disabled) while a read subtree stays usable.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button } from "../src/ui/Button.js";
import { Input } from "../src/ui/Input.js";
import { Switch } from "../src/ui/Switch.js";
import { Unlocked, WriteLock } from "../src/ui/WriteLock.js";
import { fieldUnit, formatSettingValue } from "../src/ui/settings/model.js";

afterEach(cleanup);

describe("WriteLock", () => {
  it("locks write controls and leaves reads usable", () => {
    render(
      <WriteLock locked reason="Ask Ana for edit access.">
        <Button>Save</Button>
        <Input aria-label="Name" defaultValue="DJDL" />
        <Switch aria-label="Flag" checked={false} />
        <Unlocked>
          <Button>Copy</Button>
        </Unlocked>
      </WriteLock>,
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect((save as HTMLButtonElement).disabled).toBe(false);
    const name = screen.getByRole("textbox", {
      name: "Name",
    }) as HTMLInputElement;
    expect(name.readOnly).toBe(true);
    expect(name.disabled).toBe(false);
    expect(
      screen
        .getByRole("switch", { name: "Flag" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Copy" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });
});

describe("registry units", () => {
  it("words perDay as 'a day'", () => {
    const spec = {
      kind: "integer",
      unit: "perDay",
      min: 1,
      max: 1_000_000,
    } as never;
    expect(fieldUnit(spec)).toBe("a day");
    expect(formatSettingValue(spec, 500)).toBe("500 a day");
  });
});
