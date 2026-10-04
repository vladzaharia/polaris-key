import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ManagedField,
  SchemaField,
  catalogDiagnostics,
  catalogIssues,
  validate,
  validateEntry,
  widgetFor,
  type FieldResult,
} from "../src/schema/index.js";
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

// ═════════════════════════════════════════════════════════════════════════════
// The validator
//
// These messages are `@polaris-key/catalog`'s, not this module's. The console used to carry a
// hand-written Draft-07 subset with its own wording ("must be a number", "min length 3"); it
// could not see `format`, `items`, `required` or any combinator, so a value it called fine came
// back 422. The console now runs `Catalog#validateEntryValue` — the exact call the worker's
// `applyOverrides` makes — which is why the expected strings below are the server's strings.
// ═════════════════════════════════════════════════════════════════════════════

describe("validate — the catalog's own Draft-07 interpreter", () => {
  it("treats undefined as 'not set' (always valid), and '' as a real string value", () => {
    // `undefined` means the key is absent from the payload — never an error. An empty string is
    // a VALUE, and is validated like one: the console never writes "" to mean "unset".
    expect(validate({ type: "string" }, undefined)).toBeNull();
    expect(validate({ type: "integer" }, undefined)).toBeNull();
    expect(validate({ type: "string" }, "")).toBeNull();
    expect(validate({ type: "string", minLength: 1 }, "")).toMatch(
      /fewer than 1 characters/,
    );
  });

  it("number bounds", () => {
    expect(validate({ type: "number" }, "not-a-number")).toMatch(
      /must be number, got string/,
    );
    expect(validate({ type: "integer" }, 1.5)).toMatch(
      /must be integer, got number/,
    );
    expect(validate({ type: "integer", minimum: 2 }, 1)).toMatch(/>= 2/);
    expect(validate({ type: "integer", maximum: 10 }, 11)).toMatch(/<= 10/);
    expect(
      validate({ type: "integer", minimum: 0, maximum: 10 }, 5),
    ).toBeNull();
    expect(validate({ type: "integer", multipleOf: 5 }, 7)).toMatch(
      /multiple of 5/,
    );
  });

  it("string length + pattern", () => {
    expect(validate({ type: "string", minLength: 3 }, "ab")).toMatch(
      /fewer than 3 characters/,
    );
    expect(validate({ type: "string", maxLength: 2 }, "abc")).toMatch(
      /more than 2 characters/,
    );
    expect(validate({ type: "string", pattern: "^[a-z]+$" }, "ABC")).toMatch(
      /must match pattern/,
    );
    expect(validate({ type: "string", pattern: "^[a-z]+$" }, "abc")).toBeNull();
  });

  it("enum membership", () => {
    expect(validate({ enum: ["a", "b"] }, "c")).toMatch(/must be one of/);
    expect(validate({ enum: ["a", "b"] }, "a")).toBeNull();
  });

  it("sees the keywords the old hand-written subset could not", () => {
    // Every one of these was silently accepted before and 422'd on save.
    expect(validate({ type: "string", format: "uri" }, "not a uri")).toMatch(
      /must match format "uri"/,
    );
    expect(
      validate({ type: "string", format: "uri" }, "https://x.dev"),
    ).toBeNull();
    expect(validate({ type: "array", items: { type: "string" } }, [1])).toMatch(
      /must be string, got integer/,
    );
    expect(
      validate({ type: "array", items: { type: "string" } }, ["a"]),
    ).toBeNull();
    expect(
      validate(
        {
          type: "object",
          properties: { host: { type: "string" } },
          required: ["host"],
        },
        {},
      ),
    ).toMatch(/must have required property "host"/);
    expect(validate({ const: 7 }, 8)).toMatch(/must be 7/);
    expect(validate({ type: "array", uniqueItems: true }, [1, 1])).toMatch(
      /duplicate items/,
    );
  });

  it("validateEntry strips the key prefix the server puts on every message", () => {
    // `validateEntryValue` returns `"<key><path> <message>"` so a flat 422 body can name the
    // key. Inline, next to a labelled control, the key is noise — but a JSON-Pointer path is not.
    expect(
      validateEntry(
        entry({ key: "audio.buffer", schema: { type: "integer", minimum: 8 } }),
        4,
      ),
    ).toBe("must be >= 8");
    expect(
      validateEntry(
        entry({
          key: "net.hosts",
          schema: { type: "array", items: { type: "string" } },
        }),
        [1],
      ),
    ).toBe("/0 must be string, got integer");
  });
});

describe("validate — `pattern` is matched in linear time (R10 residual 4)", () => {
  // `schema.pattern` is operator-supplied and can arrive from a linked repo via a
  // webhook-triggered resync with no review. Under `new RegExp` this exact input took ~54 s
  // and froze the operator's tab; the linear matcher must answer immediately.
  it("answers the catastrophic-backtracking case immediately", () => {
    const started = Date.now();
    expect(
      validate({ type: "string", pattern: "(x+x+)+y" }, "x".repeat(41)),
    ).toMatch(/must match pattern/);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("still agrees with the host RegExp on ordinary patterns", () => {
    for (const [pattern, value] of [
      ["^[a-z]+$", "abc"],
      ["^\\d{3}-\\d{4}$", "555-1234"],
      ["^(a|b)*c$", "ababc"],
      ["[A-Z]", "xYz"],
    ] as const) {
      expect(validate({ type: "string", pattern }, value)).toBeNull();
      expect(new RegExp(pattern, "u").test(value)).toBe(true);
    }
    for (const [pattern, value] of [
      ["^[a-z]+$", "ABC"],
      ["^\\d{3}-\\d{4}$", "5551234"],
      ["^(a|b)*c$", "abd"],
    ] as const) {
      expect(validate({ type: "string", pattern }, value)).toMatch(
        /must match pattern/,
      );
      expect(new RegExp(pattern, "u").test(value)).toBe(false);
    }
  });

  it("fails closed on a pattern the matcher refuses, never falling back to RegExp", () => {
    // Backreferences need backtracking, so the linear engine rejects them at compile time.
    // The worker treats such a fragment as rejected and drops every value under it, so the
    // console must not present the value as acceptable.
    expect(validate({ type: "string", pattern: "(a)\\1" }, "aa")).toMatch(
      /backreferences are not supported/,
    );
    // Same for an oversized source (MAX_PATTERN_SOURCE = 300).
    expect(
      validate({ type: "string", pattern: "a".repeat(301) }, "aaa"),
    ).toMatch(/exceeds the 300 limit/);
  });

  it("rejects an input past the matcher's input cap instead of hanging", () => {
    // MAX_PATTERN_INPUT = 4096; `test` returns false beyond it, which is fail-closed and is
    // exactly what the worker does.
    expect(
      validate({ type: "string", pattern: "^a*$" }, "a".repeat(4097)),
    ).toMatch(/must match pattern/);
  });

  it("is memoised: repeated validation of one fragment prepares it once", () => {
    const schema = { type: "string", pattern: "^[a-z]{1,40}$" };
    const started = Date.now();
    for (let i = 0; i < 2000; i++) validate(schema, "abcdef");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The control
// ═════════════════════════════════════════════════════════════════════════════

describe("SchemaField — control per schema/kind", () => {
  it("boolean renders a switch and emits a boolean", () => {
    const onChange = vi.fn();
    render(
      <SchemaField
        entry={entry({ schema: { type: "boolean" } })}
        value={false}
        onChange={onChange}
      />,
    );
    const box = screen.getByRole("switch", { name: "A field" });
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

  it("a number schema renders a number input with min/max and an integer step", () => {
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
    expect(input.step).toBe("1");
  });

  it("takes the number step from `multipleOf` when the schema declares one", () => {
    render(
      <SchemaField
        entry={entry({ schema: { type: "number", multipleOf: 0.5 } })}
        value={1}
        onChange={vi.fn()}
      />,
    );
    expect((screen.getByLabelText("A field") as HTMLInputElement).step).toBe(
      "0.5",
    );
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
    expect(screen.getByText("Flag")).toBeTruthy();
  });

  it("picks the widget from the schema, letting `ui.widget` only break ties", () => {
    expect(widgetFor(entry({ schema: { type: "boolean" } }))).toBe("switch");
    expect(widgetFor(entry({ schema: { enum: ["a"] } }))).toBe("select");
    expect(widgetFor(entry({ schema: { type: "integer" } }))).toBe("number");
    expect(widgetFor(entry({ schema: { type: "array" } }))).toBe("json");
    expect(widgetFor(entry({ schema: { type: "object" } }))).toBe("json");
    expect(
      widgetFor(
        entry({ schema: { type: "string" }, ui: { widget: "textarea" } }),
      ),
    ).toBe("textarea");
    // A hint may not contradict the type: a boolean asked to be a textarea is still a switch.
    expect(
      widgetFor(
        entry({ schema: { type: "boolean" }, ui: { widget: "textarea" } }),
      ),
    ).toBe("switch");
  });

  it("labels enum options from `ui.optionLabels` while emitting the raw value", async () => {
    const onChange = vi.fn();
    render(
      <SchemaField
        entry={entry({
          schema: { type: "string", enum: ["dark", "light"] },
          ui: { optionLabels: { dark: "Midnight", light: "Daylight" } },
        })}
        value="dark"
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "A field" }));
    expect(await screen.findByText("Daylight")).toBeTruthy();
  });

  it("carries `ui.unit` in the visible label that names the control (SCF-2)", () => {
    // The control is named by its visible label, unit included; no `aria-label` overrides it.
    render(
      <SchemaField
        entry={entry({ schema: { type: "integer" }, ui: { unit: "ms" } })}
        value={10}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("(ms)")).toBeTruthy();
    const input = screen.getByLabelText("A field (ms)");
    expect(input.tagName).toBe("INPUT");
    expect(input.id).toBeTruthy();
    expect(input.getAttribute("aria-label")).toBeNull();
  });
});

describe("SchemaField — arrays and objects get a JSON editor", () => {
  it("renders a textarea seeded with pretty JSON and emits the parsed value", () => {
    const onChange = vi.fn<(r: FieldResult) => void>();
    render(
      <SchemaField
        entry={entry({ schema: { type: "array", items: { type: "string" } } })}
        value={["a"]}
        onChange={onChange}
      />,
    );
    const box = screen.getByLabelText("A field") as HTMLTextAreaElement;
    expect(box.tagName).toBe("TEXTAREA");
    expect(JSON.parse(box.value)).toEqual(["a"]);
    fireEvent.change(box, { target: { value: '["a","b"]' } });
    expect(onChange.mock.calls.at(-1)![0]).toEqual({
      value: ["a", "b"],
      valid: true,
      error: undefined,
    });
  });

  it("reports unparseable JSON without discarding the last good value", () => {
    const onChange = vi.fn<(r: FieldResult) => void>();
    render(
      <SchemaField
        entry={entry({ schema: { type: "array" } })}
        value={["a"]}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("A field"), {
      target: { value: '["a",' },
    });
    const result = onChange.mock.calls.at(-1)![0];
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Invalid JSON/);
    // The payload keeps the value it had — a half-typed array must not blank the key.
    expect(result.value).toEqual(["a"]);
  });

  it("keeps the operator's text while editing, but follows an outside change", () => {
    const onChange = vi.fn<(r: FieldResult) => void>();
    const field = (value: unknown) => (
      <SchemaField
        entry={entry({ schema: { type: "array" } })}
        value={value}
        onChange={onChange}
      />
    );
    const { rerender } = render(field(["a"]));
    const box = screen.getByLabelText("A field") as HTMLTextAreaElement;

    // Typing valid JSON must not get reformatted under the cursor…
    fireEvent.change(box, { target: { value: '["a","b"]' } });
    const emitted = onChange.mock.calls.at(-1)![0].value;
    rerender(field(emitted));
    expect(
      (screen.getByLabelText("A field") as HTMLTextAreaElement).value,
    ).toBe('["a","b"]');

    // …but a Discard/reload, which hands back a different value, does re-seed the box.
    rerender(field(["z"]));
    expect(
      JSON.parse(
        (screen.getByLabelText("A field") as HTMLTextAreaElement).value,
      ),
    ).toEqual(["z"]);
  });

  it("validates the parsed value against the schema, not just its syntax", () => {
    const onChange = vi.fn<(r: FieldResult) => void>();
    render(
      <SchemaField
        entry={entry({ schema: { type: "array", items: { type: "string" } } })}
        value={[]}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("A field"), {
      target: { value: "[1]" },
    });
    const result = onChange.mock.calls.at(-1)![0];
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/must be string, got integer/);
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
    expect(result.error).toMatch(/<= 5/);
  });

  it("renders a role=alert with the validation error for the current value", () => {
    render(
      <SchemaField
        entry={entry({ schema: { type: "string", minLength: 5 } })}
        value="ab"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(
      /fewer than 5 characters/,
    );
  });

  it("marks the control aria-invalid and wires the error by aria-describedby", () => {
    render(
      <SchemaField
        entry={entry({ schema: { type: "string", minLength: 5 } })}
        value="ab"
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("A field");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby") ?? "";
    expect(described).toContain(screen.getByRole("alert").id);
  });

  it("an externally supplied error (a 422) outranks the local check", () => {
    render(
      <SchemaField
        entry={entry()}
        value="fine"
        error="the server said no"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("the server said no");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The row
// ═════════════════════════════════════════════════════════════════════════════

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
    // The state badge reflects the v2 ManagementState (badge and selected radio both read it).
    expect(screen.getAllByText("Enforced").length).toBeGreaterThanOrEqual(2);
    // An updatedAt stamp is rendered.
    expect(screen.getByText(/Updated/)).toBeTruthy();
    // The state selector is a segmented radio group, labelled per entry.
    const group = screen.getByRole("radiogroup", {
      name: /Management state for A field/,
    });
    expect(group).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "Enforced" })
        .getAttribute("aria-checked"),
    ).toBe("true");
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

  it("explains the selected state in the protocol's own words", () => {
    render(
      <ManagedField
        entry={entry()}
        value="hi"
        state="hidden"
        onValueChange={vi.fn()}
        onStateChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/withheld from user-facing enumeration/),
    ).toBeTruthy();
  });

  it("moves between states with the arrow keys (radio-group pattern)", async () => {
    const onStateChange = vi.fn();
    render(
      <ManagedField
        entry={entry()}
        value="hi"
        state="default"
        onValueChange={vi.fn()}
        onStateChange={onStateChange}
      />,
    );
    const selected = screen.getByRole("radio", { name: "Default" });
    selected.focus();
    // Held, as a real key press is: the radio group selects what the arrow focuses.
    await userEvent.keyboard("{ArrowRight>}");
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith("enforced"),
    );
    await userEvent.keyboard("{/ArrowRight}");
    // One tab stop for the whole group (roving tabindex).
    expect(
      screen
        .getAllByRole("radio")
        .filter((r) => r.getAttribute("tabindex") === "0"),
    ).toHaveLength(1);
  });
});

describe("ManagedField — set vs unset is a real state", () => {
  it("an unset row reads 'Not set', ghosts the fallback, and offers to set it", () => {
    render(
      <ManagedField
        entry={entry({ default: "system", description: "UI theme" })}
        value={undefined}
        state="default"
        set={false}
        onSetChange={vi.fn()}
        onValueChange={vi.fn()}
        onStateChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(screen.getByText(/clients fall back to system/)).toBeTruthy();
    // No editor at all until the operator asks for one.
    expect(screen.queryByLabelText("A field")).toBeNull();
    // Each row's button is named for its key (SCF-6: no N identical "Set value" buttons).
    expect(
      screen.getByRole("button", { name: "Set a value for A field" }),
    ).toBeTruthy();
  });

  it("an unset row names the layer it inherits from when there is one", () => {
    render(
      <ManagedField
        entry={entry()}
        value={undefined}
        state="default"
        set={false}
        inherited={{
          source: "profile “base”",
          value: "dark",
          state: "default",
        }}
        onSetChange={vi.fn()}
        onValueChange={vi.fn()}
        onStateChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/inherits dark from profile “base”/)).toBeTruthy();
  });

  it("a set row offers a per-entry clear that returns it to unset", async () => {
    const onSetChange = vi.fn();
    render(
      <ManagedField
        entry={entry()}
        value="dark"
        state="default"
        set
        onSetChange={onSetChange}
        onValueChange={vi.fn()}
        onStateChange={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove A field from the payload" }),
    );
    expect(onSetChange).toHaveBeenCalledWith(false);
  });

  it("a set row that overrides a lower layer says what it is overriding", () => {
    render(
      <ManagedField
        entry={entry()}
        value="light"
        state="default"
        set
        inherited={{
          source: "profile “base”",
          value: "dark",
          state: "default",
        }}
        onSetChange={vi.fn()}
        onValueChange={vi.fn()}
        onStateChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Overrides dark from profile “base”/)).toBeTruthy();
  });
});

describe("ManagedField — secrets are write-only", () => {
  const secret = entry({
    kind: "secret",
    label: "API token",
    key: "api.token",
  });

  it("never renders a stored secret: it stays read-only until Replace is ticked", async () => {
    render(
      <ManagedField
        entry={secret}
        value={undefined}
        state="enforced"
        set
        secretConfigured
        onValueChange={vi.fn()}
        onStateChange={vi.fn()}
      />,
    );
    const masked = screen.getByLabelText(/^API token/) as HTMLInputElement;
    expect(masked.type).toBe("password");
    expect(masked.readOnly).toBe(true);
    // Whatever is in the box, it is not a value the server sent — the API redacts it.
    expect(masked.value).not.toMatch(/[A-Za-z0-9]/);
    expect(screen.getByText("Configured")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("checkbox", { name: /Replace the existing value/ }),
    );
    const editable = screen.getByLabelText(/^API token/) as HTMLInputElement;
    expect(editable.readOnly).toBe(false);
    expect(editable.value).toBe("");
  });

  it("warns that demoting a configured secret to Default clears it", () => {
    // `applyOverrides` deletes a key whose update carries no value and state `default`; the
    // console has no secret value to resend, so this really does drop the stored secret.
    render(
      <ManagedField
        entry={secret}
        value={undefined}
        state="default"
        set
        secretConfigured
        onValueChange={vi.fn()}
        onStateChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/removes the stored secret/)).toBeTruthy();
  });

  it("an unconfigured secret shows a 'Missing' badge", () => {
    render(
      <ManagedField
        entry={secret}
        value=""
        state="default"
        set
        secretConfigured={false}
        onValueChange={vi.fn()}
        onStateChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Missing")).toBeTruthy();
    expect(
      (screen.getByLabelText(/^API token/) as HTMLInputElement).readOnly,
    ).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The rebuild (ADMIN.md §6.6: SCF-1, SCF-3, CAT-4, CAT-5)
// ═════════════════════════════════════════════════════════════════════════════

describe("SchemaField — the form layer wires every control (SCF-1, SCF-3)", () => {
  it("labels an enum's select trigger and announces its error", () => {
    render(
      <SchemaField
        entry={entry({ schema: { type: "string", enum: ["dark", "light"] } })}
        value="dim"
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "A field" });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    const describedBy = trigger.getAttribute("aria-describedby")!;
    expect(
      document.getElementById(describedBy.split(" ").pop()!)!.textContent,
    ).toMatch(/must be one of/);
  });

  it("validates a switch's value instead of calling it valid (SCF-3)", () => {
    const onChange = vi.fn<(r: FieldResult) => void>();
    render(
      <SchemaField
        entry={entry({ schema: { type: "boolean", const: false } })}
        value={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "A field" }));
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({
      value: true,
      valid: false,
    });
  });

  it("formats a JSON value on request (SCF-4)", () => {
    const onChange = vi.fn<(r: FieldResult) => void>();
    render(
      <SchemaField
        entry={entry({ schema: { type: "array" } })}
        value={[1, 2]}
        onChange={onChange}
      />,
    );
    const box = screen.getByLabelText("A field") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "[3,4]" } });
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    expect(box.value).toBe("[\n  3,\n  4\n]");
  });
});

describe("catalogIssues and catalogDiagnostics — the editor's validator (CAT-4, CAT-5)", () => {
  const good = { schemaVersion: 1, entries: [entry({ key: "a" })] };

  it("accepts a catalog the publish route accepts", () => {
    expect(catalogIssues(good)).toEqual([]);
  });

  it("names structural problems by entry", () => {
    const issues = catalogIssues({
      entries: [
        entry({ key: "a" }),
        entry({ key: "a" }),
        { ...entry({ key: "b" }), kind: "setting" },
        entry({ key: "c", schema: { type: "not-a-type" } }),
      ],
    });
    expect(issues.map((i) => [i.index, i.field])).toEqual([
      [1, "key"],
      [2, "kind"],
      [3, "schema"],
    ]);
    expect(catalogIssues({})).toEqual([
      { field: "entries", message: "entries must be an array." },
    ]);
  });

  it("puts a JSON syntax error at its line and column", () => {
    const [d] = catalogDiagnostics('{\n  "entries": [,]\n}');
    expect(d!.line).toBe(2);
    expect(d!.message).toMatch(/Invalid JSON/);
  });

  it("puts an entry's problem on the line of its key", () => {
    const text = JSON.stringify(
      {
        entries: [
          entry({ key: "a" }),
          entry({ key: "b", schema: { type: 5 } }),
        ],
      },
      null,
      2,
    );
    const [d] = catalogDiagnostics(text);
    expect(text.split("\n")[d!.line - 1]).toContain('"key": "b"');
  });
});
