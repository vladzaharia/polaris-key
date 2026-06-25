import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ManagedField,
  SchemaField,
  validate,
  type FieldResult,
} from "../src/SchemaForm.js";
import type { ConfigEntry } from "../src/api.js";

beforeEach(() => {
  // jsdom lacks these Radix-needed APIs.
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
});
afterEach(cleanup);

function entry(over: Partial<ConfigEntry> = {}): ConfigEntry {
  return {
    key: "k",
    kind: "config",
    category: "general",
    label: "A field",
    description: "",
    schema: { type: "string" },
    ...over,
  };
}

describe("validate — the Draft-07 subset", () => {
  it("treats empty/undefined as 'no override' (always valid)", () => {
    expect(validate({ type: "string" }, "")).toBeNull();
    expect(validate({ type: "integer" }, undefined)).toBeNull();
  });

  it("number bounds", () => {
    expect(validate({ type: "number" }, "not-a-number")).toMatch(
      /must be a number/,
    );
    expect(validate({ type: "integer" }, 1.5)).toMatch(/must be an integer/);
    expect(validate({ type: "integer", minimum: 2 }, 1)).toMatch(/≥ 2/);
    expect(validate({ type: "integer", maximum: 10 }, 11)).toMatch(/≤ 10/);
    expect(
      validate({ type: "integer", minimum: 0, maximum: 10 }, 5),
    ).toBeNull();
  });

  it("string length + pattern", () => {
    expect(validate({ type: "string", minLength: 3 }, "ab")).toMatch(
      /min length 3/,
    );
    expect(validate({ type: "string", maxLength: 2 }, "abc")).toMatch(
      /max length 2/,
    );
    expect(validate({ type: "string", pattern: "^[a-z]+$" }, "ABC")).toMatch(
      /does not match/,
    );
    expect(validate({ type: "string", pattern: "^[a-z]+$" }, "abc")).toBeNull();
  });

  it("enum membership", () => {
    expect(validate({ enum: ["a", "b"] }, "c")).toMatch(/not an allowed value/);
    expect(validate({ enum: ["a", "b"] }, "a")).toBeNull();
  });
});

describe("SchemaField — control per schema/kind", () => {
  it("boolean renders a checkbox role and emits a boolean", () => {
    const onChange = vi.fn();
    render(
      <SchemaField
        entry={entry({ schema: { type: "boolean" } })}
        value={false}
        onChange={onChange}
      />,
    );
    const box = screen.getByRole("checkbox", { name: "A field" });
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith({ value: true, valid: true });
  });

  it("an enum renders a select trigger (combobox role)", () => {
    render(
      <SchemaField
        entry={entry({ schema: { type: "string", enum: ["dark", "light"] } })}
        value=""
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("combobox", { name: "A field" })).toBeTruthy();
  });

  it("a number schema renders a number input with min/max", () => {
    render(
      <SchemaField
        entry={entry({ schema: { type: "integer", minimum: 1, maximum: 9 } })}
        value={3}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("A field") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.min).toBe("1");
    expect(input.max).toBe("9");
  });

  it("a secret entry renders a password input", () => {
    render(
      <SchemaField
        entry={entry({ kind: "secret", schema: { type: "string" } })}
        value=""
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("A field") as HTMLInputElement;
    expect(input.type).toBe("password");
  });

  it("a plain string renders a text input and emits coerced values", () => {
    const onChange = vi.fn();
    render(<SchemaField entry={entry()} value="" onChange={onChange} />);
    const input = screen.getByLabelText("A field") as HTMLInputElement;
    expect(input.type).toBe("text");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(onChange).toHaveBeenCalledWith({
      value: "hello",
      valid: true,
      error: undefined,
    });
  });

  it("shows the kind badge", () => {
    render(
      <SchemaField
        entry={entry({ kind: "flag", schema: { type: "boolean" } })}
        value={true}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("flag")).toBeTruthy();
  });
});

describe("SchemaField — coercion + validation feedback", () => {
  it("coerces a numeric string to a number on change", () => {
    const onChange = vi.fn();
    render(
      <SchemaField
        entry={entry({ schema: { type: "integer" } })}
        value={undefined}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("A field"), {
      target: { value: "42" },
    });
    expect(onChange).toHaveBeenCalledWith({
      value: 42,
      valid: true,
      error: undefined,
    });
  });

  it("emits valid=false + an error message for an out-of-range number", () => {
    const onChange = vi.fn<(r: FieldResult) => void>();
    render(
      <SchemaField
        entry={entry({ schema: { type: "integer", maximum: 5 } })}
        value={undefined}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("A field"), {
      target: { value: "9" },
    });
    const result = onChange.mock.calls.at(-1)![0];
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/≤ 5/);
  });

  it("renders a role=alert with the validation error for the current value", () => {
    render(
      <SchemaField
        entry={entry({ schema: { type: "string", minLength: 5 } })}
        value="ab"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/min length 5/);
  });
});

describe("ManagedField — v2 management state + updatedAt", () => {
  it("renders the value editor, the current state badge, and the updatedAt stamp", () => {
    render(
      <ManagedField
        entry={entry()}
        value="hi"
        state="enforced"
        updatedAt={1_700_000_000}
        onValueChange={vi.fn()}
        onStateChange={vi.fn()}
      />,
    );
    // The state badge reflects the v2 ManagementState.
    expect(screen.getByText("enforced")).toBeTruthy();
    // An updatedAt stamp is rendered.
    expect(screen.getByText(/Updated/)).toBeTruthy();
    // The state selector is present + labelled.
    expect(
      screen.getByRole("combobox", { name: /Management state for A field/ }),
    ).toBeTruthy();
  });

  it("omits the stamp when never updated", () => {
    render(
      <ManagedField
        entry={entry()}
        value=""
        state="default"
        onValueChange={vi.fn()}
        onStateChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Updated/)).toBeNull();
  });
});
