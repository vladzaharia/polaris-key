import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ConfigEntry,
  ManagementState,
  ProductCatalog,
  RedactedPayload,
} from "../src/api.js";
import {
  ManagedPayloadEditor,
  diffPayload,
  mapServerFields,
} from "../src/ManagedPayloadEditor.js";

/**
 * The shared managed-payload editor — the ONE surface behind both profile payloads and license
 * overrides. What is pinned here is the machinery both screens depend on: catalog-driven
 * grouping, filtering at catalog scale, set-vs-unset as a real state, inline validation from
 * `@polaris-key/catalog`, and the batch that actually reaches the worker.
 */

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

const ENTRIES: ConfigEntry[] = [
  {
    key: "ui.theme",
    kind: "config",
    category: "appearance",
    label: "Theme",
    description: "The colour scheme the app starts in.",
    schema: { type: "string", enum: ["dark", "light"] },
    default: "dark",
  },
  {
    key: "audio.buffer",
    kind: "config",
    category: "audio",
    label: "Buffer size",
    description: "Frames per audio buffer.",
    schema: { type: "integer", minimum: 64, maximum: 2048 },
    default: 512,
  },
  {
    key: "api.token",
    kind: "secret",
    category: "audio",
    label: "API token",
    description: "Upstream API token.",
    schema: { type: "string" },
  },
  {
    key: "flag.pro",
    kind: "flag",
    category: "entitlements",
    label: "Pro features",
    description: "Unlocks the pro tier.",
    schema: { type: "boolean" },
  },
  {
    key: "net.hosts",
    kind: "config",
    category: "network",
    label: "Allowed hosts",
    description: "Hosts the app may reach.",
    schema: { type: "array", items: { type: "string" } },
    ui: { advanced: true },
  },
];

const CATALOG: ProductCatalog = { schemaVersion: 3, entries: ENTRIES };

/** Only `ui.theme` is actually set — everything else is absent, which is not the same as blank. */
const PAYLOAD: RedactedPayload = {
  config: {
    "ui.theme": { state: "enforced", value: "light", updatedAt: 1_700_000_000 },
  },
  secrets: {},
  entitlements: {},
};

function renderEditor(
  over: Partial<React.ComponentProps<typeof ManagedPayloadEditor>> = {},
) {
  const onSubmit = vi.fn();
  const utils = render(
    <ManagedPayloadEditor
      slug="djdl"
      catalog={CATALOG}
      payload={PAYLOAD}
      onSubmit={onSubmit}
      {...over}
    />,
  );
  return { ...utils, onSubmit };
}

describe("ManagedPayloadEditor — catalog-driven structure", () => {
  it("groups entries by catalog category, each with a set/total count", () => {
    renderEditor();
    for (const category of ["appearance", "audio", "entitlements"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(category) }),
      ).toBeTruthy();
    }
    // `ui.advanced` entries sink into their own trailing group, "More settings" (MPE-4).
    expect(screen.getByRole("button", { name: /More settings/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /network/ })).toBeNull();
    // appearance: one entry, and it is the one that is set.
    expect(
      screen.getByRole("button", { name: /appearance/ }).textContent,
    ).toMatch(/1\/1 set/);
    expect(screen.getByRole("button", { name: /^audio/ }).textContent).toMatch(
      /0\/2 set/,
    );
  });

  it("leads each row with the catalog label and carries the dotted key as secondary text", () => {
    renderEditor();
    expect(screen.getByText("Theme")).toBeTruthy();
    expect(screen.getByText("ui.theme")).toBeTruthy();
    expect(
      screen.getByText("The colour scheme the app starts in."),
    ).toBeTruthy();
  });

  it("collapses a category section, and says so to assistive tech", async () => {
    renderEditor();
    const header = screen.getByRole("button", { name: /appearance/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    const bodyId = header.getAttribute("aria-controls")!;
    expect(document.getElementById(bodyId)!.hasAttribute("hidden")).toBe(true);
  });

  it("counts the entries that are set across the whole catalog", () => {
    renderEditor();
    expect(screen.getByText("1 of 5 entries set")).toBeTruthy();
  });
});

describe("ManagedPayloadEditor — filtering at catalog scale", () => {
  it("filters across key, label, and category", async () => {
    renderEditor();
    await userEvent.type(
      screen.getByLabelText("Search keys and values"),
      "audio",
    );
    expect(await screen.findByText("2 of 5 entries")).toBeTruthy();
    expect(screen.getByText("Buffer size")).toBeTruthy();
    expect(screen.queryByText("Theme")).toBeNull();
  });

  it("matches on the dotted key even when the label does not contain it", async () => {
    renderEditor();
    await userEvent.type(
      screen.getByLabelText("Search keys and values"),
      "net.hosts",
    );
    expect(await screen.findByText("1 of 5 entries")).toBeTruthy();
    expect(screen.getByText("Allowed hosts")).toBeTruthy();
  });

  it("offers a clear-filter affordance when nothing matches", async () => {
    renderEditor();
    await userEvent.type(
      screen.getByLabelText("Search keys and values"),
      "zzzz",
    );
    expect(
      await screen.findByText(/No entries match this search/),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Clear filters" }),
    );
    expect(screen.getByText("Theme")).toBeTruthy();
  });

  it("a filter reveals matches inside a collapsed section", async () => {
    renderEditor();
    const header = screen.getByRole("button", { name: /appearance/ });
    const body = () =>
      document.getElementById(header.getAttribute("aria-controls")!)!;
    await userEvent.click(header);
    expect(body().hasAttribute("hidden")).toBe(true);
    // A filter is a request to see the matches, so it outranks a folded section.
    await userEvent.type(
      screen.getByLabelText("Search keys and values"),
      "theme",
    );
    await waitFor(() => expect(body().hasAttribute("hidden")).toBe(false));
    expect(screen.getByLabelText(/^Theme/)).toBeTruthy();
  });
});

describe("ManagedPayloadEditor — set vs unset", () => {
  it("shows absent keys as 'Not set' with no editor at all", () => {
    renderEditor();
    // `audio.buffer` is not in the payload.
    expect(screen.queryByLabelText(/^Buffer size/)).toBeNull();
    expect(screen.getAllByText("Not set").length).toBeGreaterThan(0);
    expect(screen.getByText(/clients fall back to 512/)).toBeTruthy();
  });

  it("materialises an editor seeded from the catalog default, and counts it as a change", async () => {
    renderEditor();
    await userEvent.click(
      screen.getByRole("button", { name: "Set a value for Buffer size" }),
    );
    const input = (await screen.findByLabelText(
      /^Buffer size/,
    )) as HTMLInputElement;
    expect(input.value).toBe("512");
    expect(await screen.findByText(/1 unsaved change/)).toBeTruthy();
  });

  it("clearing a set key sends the worker's delete shape, never an empty string", async () => {
    const { onSubmit } = renderEditor();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Theme from the payload" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // No value + state `default` is exactly what `applyOverrides` deletes on.
    expect(onSubmit.mock.calls.at(-1)![0]).toEqual([
      { key: "ui.theme", state: "default" },
    ]);
  });
});

describe("ManagedPayloadEditor — dirty state and saving", () => {
  it("hides the action bar until something changes, then counts the changes", async () => {
    renderEditor();
    expect(screen.queryByRole("button", { name: /Save changes/ })).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Hidden" }));
    expect(await screen.findByText(/1 unsaved change/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeTruthy();
  });

  it("Discard returns every row to the loaded payload", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("radio", { name: "Hidden" }));
    await screen.findByText(/1 unsaved change/);
    await userEvent.click(screen.getByRole("button", { name: /Discard/ }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull(),
    );
    expect(
      screen
        .getByRole("radio", { name: "Enforced" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("a state-only change still carries the value, so Default cannot silently delete it", async () => {
    const { onSubmit } = renderEditor();
    await userEvent.click(screen.getByRole("radio", { name: "Default" }));
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls.at(-1)![0]).toEqual([
      { key: "ui.theme", state: "default", value: "light" },
    ]);
  });

  it("blocks Save while a changed row has an inline validation error", async () => {
    const { onSubmit } = renderEditor();
    // Materialise the bounded integer, then push it out of range.
    await userEvent.click(
      screen.getByRole("button", { name: "Set a value for Buffer size" }),
    );
    const input = await screen.findByLabelText(/^Buffer size/);
    await userEvent.clear(input);
    await userEvent.type(input, "9999");
    // The message is the catalog validator's — the same one a 422 would carry.
    expect(await screen.findByText(/must be <= 2048/)).toBeTruthy();
    // Save is refused while a CHANGED row is invalid: it jumps to the error instead.
    expect(screen.getByText(/fix 1 error to save/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("ManagedPayloadEditor — server-side validation lands on the row", () => {
  it("matches a 422 `fields` entry back onto the key it names", () => {
    renderEditor({ serverFields: ['ui.theme must be one of "dark", "light"'] });
    // The key prefix is stripped: the row already carries the label.
    expect(screen.getByRole("alert").textContent).toBe(
      'must be one of "dark", "light"',
    );
  });

  it("surfaces a field that names no catalog key in a batch-level alert", () => {
    renderEditor({ serverFields: ["unknown config key: gone.away"] });
    expect(screen.getByText(/The server rejected this batch/)).toBeTruthy();
    expect(screen.getByText("unknown config key: gone.away")).toBeTruthy();
  });

  it("does not swallow a message for a row that is no longer set", () => {
    // `audio.buffer` is absent from the payload, so there is no control to hang it under.
    renderEditor({ serverFields: ["audio.buffer must be >= 64"] });
    expect(screen.getByText("audio.buffer must be >= 64")).toBeTruthy();
  });
});

describe("ManagedPayloadEditor — empty and edge states", () => {
  it("points at Config → Catalog when the product declares nothing", () => {
    render(
      <ManagedPayloadEditor
        slug="djdl"
        catalog={{ schemaVersion: 1, entries: [] }}
        payload={{ config: {}, secrets: {}, entitlements: {} }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText("This product has no config catalog")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Open the catalog/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/config/catalog");
  });
});

// ── the pure pieces ──────────────────────────────────────────────────────────

describe("diffPayload", () => {
  /** The loaded-payload shape `diffPayload` diffs against (structurally, not by import). */
  type Base = {
    set: boolean;
    value: unknown;
    state: ManagementState;
    updatedAt: number;
    secretConfigured: boolean;
  };
  const baseline = new Map<string, Base>([
    [
      "ui.theme",
      {
        set: true,
        value: "light",
        state: "enforced" as const,
        updatedAt: 1,
        secretConfigured: false,
      },
    ],
    [
      "api.token",
      {
        set: true,
        value: undefined,
        state: "enforced" as const,
        updatedAt: 1,
        secretConfigured: true,
      },
    ],
    [
      "flag.pro",
      {
        set: false,
        value: undefined,
        state: "default" as const,
        updatedAt: 0,
        secretConfigured: false,
      },
    ],
  ]);
  const entries = ENTRIES.filter((e) => baseline.has(e.key));

  it("emits nothing when nothing moved", () => {
    expect(
      diffPayload(entries, baseline, {
        "ui.theme": { set: true, value: "light", state: "enforced" },
        "api.token": { set: true, value: undefined, state: "enforced" },
        "flag.pro": { set: false, value: undefined, state: "default" },
      }),
    ).toEqual([]);
  });

  it("does not resend a secret whose value was never retyped", () => {
    // The value is not on the wire in either direction; a state-only update makes the worker
    // carry the sealed value forward untouched.
    expect(
      diffPayload(entries, baseline, {
        "ui.theme": { set: true, value: "light", state: "enforced" },
        "api.token": { set: true, value: undefined, state: "hidden" },
        "flag.pro": { set: false, value: undefined, state: "default" },
      }),
    ).toEqual([{ key: "api.token", state: "hidden" }]);
  });

  it("sends a newly-set key with both its value and its state", () => {
    expect(
      diffPayload(entries, baseline, {
        "ui.theme": { set: true, value: "light", state: "enforced" },
        "api.token": { set: true, value: undefined, state: "enforced" },
        "flag.pro": { set: true, value: true, state: "enforced" },
      }),
    ).toEqual([{ key: "flag.pro", state: "enforced", value: true }]);
  });

  it("compares object values structurally, not by reference", () => {
    const withArray = new Map(baseline).set("net.hosts", {
      set: true,
      value: ["a"],
      state: "default" as const,
      updatedAt: 0,
      secretConfigured: false,
    });
    const entry = ENTRIES.find((e) => e.key === "net.hosts")!;
    expect(
      diffPayload([entry], withArray, {
        "net.hosts": { set: true, value: ["a"], state: "default" },
      }),
    ).toEqual([]);
    expect(
      diffPayload([entry], withArray, {
        "net.hosts": { set: true, value: ["a", "b"], state: "default" },
      }),
    ).toEqual([{ key: "net.hosts", state: "default", value: ["a", "b"] }]);
  });
});

describe("mapServerFields", () => {
  it("assigns each message to the longest catalog key that prefixes it", () => {
    const entries: ConfigEntry[] = [
      { ...ENTRIES[0]!, key: "audio" },
      { ...ENTRIES[1]!, key: "audio.buffer" },
    ];
    const { byKey, rest } = mapServerFields(
      ["audio.buffer must be >= 64", "audio must be object, got string"],
      entries,
    );
    expect(byKey).toEqual({
      "audio.buffer": "must be >= 64",
      audio: "must be object, got string",
    });
    expect(rest).toEqual([]);
  });

  it("keeps a message that names no key so it can be shown at batch level", () => {
    const { byKey, rest } = mapServerFields(
      ["unknown config key: nope", "missing key"],
      ENTRIES,
    );
    expect(byKey).toEqual({});
    expect(rest).toEqual(["unknown config key: nope", "missing key"]);
  });

  it("keeps the JSON-Pointer path that follows the key", () => {
    const { byKey } = mapServerFields(
      ["net.hosts/0 must be string, got integer"],
      ENTRIES,
    );
    expect(byKey["net.hosts"]).toBe("/0 must be string, got integer");
  });
});

// ── the rebuild (ADMIN.md §6.6.3: MPE-1 to MPE-4) ─────────────────────────────────────────────

describe("ManagedPayloadEditor — a refetch never wipes the draft (MPE-1)", () => {
  it("keeps an edit across a background refetch of the same payload", async () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <ManagedPayloadEditor
        slug="djdl"
        catalog={CATALOG}
        payload={PAYLOAD}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Hidden" }));
    await screen.findByText(/1 unsaved change/);
    // A focus refetch: a new object, the same content.
    rerender(
      <ManagedPayloadEditor
        slug="djdl"
        catalog={CATALOG}
        payload={structuredClone(PAYLOAD)}
        onSubmit={onSubmit}
      />,
    );
    expect(
      screen
        .getByRole("radio", { name: "Hidden" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText(/1 unsaved change/)).toBeTruthy();
  });

  it("says so when the server moved under a dirty draft, and keeps the draft until asked", async () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <ManagedPayloadEditor
        slug="djdl"
        catalog={CATALOG}
        payload={PAYLOAD}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Hidden" }));
    const moved: RedactedPayload = {
      ...PAYLOAD,
      config: {
        "ui.theme": {
          state: "default",
          value: "dark",
          updatedAt: 1_700_000_500,
        },
      },
    };
    rerender(
      <ManagedPayloadEditor
        slug="djdl"
        catalog={CATALOG}
        payload={moved}
        onSubmit={onSubmit}
      />,
    );
    expect(
      await screen.findByText(/changed on the server while you were editing/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "Hidden" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Take theirs" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("radio", { name: "Default" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("takes the refetch that holds a saved draft silently", async () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <ManagedPayloadEditor
        slug="djdl"
        catalog={CATALOG}
        payload={PAYLOAD}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Hidden" }));
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Until the refetch lands, the draft stays (a failed save must never lose it).
    expect(screen.getByText(/1 unsaved change/)).toBeTruthy();
    rerender(
      <ManagedPayloadEditor
        slug="djdl"
        catalog={CATALOG}
        payload={{
          ...PAYLOAD,
          config: {
            "ui.theme": {
              state: "hidden",
              value: "light",
              updatedAt: 1_700_000_900,
            },
          },
        }}
        onSubmit={onSubmit}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByText(/unsaved change/)).toBeNull(),
    );
    expect(screen.queryByText(/changed on the server/)).toBeNull();
  });
});

describe("ManagedPayloadEditor — only changed rows block a save (MPE-2)", () => {
  /** A stored value the catalog no longer accepts (the schema tightened since). */
  const STALE: RedactedPayload = {
    config: {
      "ui.theme": { state: "enforced", value: "light", updatedAt: 1 },
      "audio.buffer": { state: "default", value: 4, updatedAt: 1 },
    },
    secrets: {},
    entitlements: {},
  };

  it("shows a stale invalid value without letting it block an unrelated save", async () => {
    const { onSubmit } = renderEditor({ payload: STALE });
    expect(screen.getByText(/must be >= 64/)).toBeTruthy();
    // The group that holds it says how many errors it has.
    expect(screen.getByRole("button", { name: /^audio/ }).textContent).toMatch(
      /1 error/,
    );
    await userEvent.click(
      within(
        screen.getByRole("radiogroup", { name: "Management state for Theme" }),
      ).getByRole("radio", { name: "Hidden" }),
    );
    expect(screen.queryByText(/to save/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls.at(-1)![0]).toEqual([
      { key: "ui.theme", state: "hidden", value: "light" },
    ]);
  });

  it("jumps to the first error, opening its collapsed group", async () => {
    renderEditor();
    await userEvent.click(
      screen.getByRole("button", { name: "Set a value for Buffer size" }),
    );
    const input = await screen.findByLabelText(/^Buffer size/);
    await userEvent.clear(input);
    await userEvent.type(input, "1");
    const header = screen.getByRole("button", { name: /^audio/ });
    await userEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(
      screen.getByRole("button", { name: /Jump to first error/ }),
    );
    await waitFor(() =>
      expect(header.getAttribute("aria-expanded")).toBe("true"),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText(/^Buffer size/),
      ),
    );
  });
});

describe("ManagedPayloadEditor — review before saving (MPE-3)", () => {
  it("lists every change with before, after and the effective value", async () => {
    const { onSubmit } = renderEditor({
      inherited: {
        "ui.theme": {
          source: "profile “base”",
          value: "dark",
          state: "default",
        },
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Theme from the payload" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Review changes",
    });
    const item = within(drawer).getByText("ui.theme").closest("li")!;
    expect(item.textContent).toMatch(/Beforelight · Enforced/);
    expect(item.textContent).toMatch(/AfterNot set/);
    expect(item.textContent).toMatch(/Effectivedark \(from profile “base”\)/);
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  });
});

describe("ManagedPayloadEditor — search and grouping (MPE-4)", () => {
  it("matches the current value, not only the key and label", async () => {
    renderEditor();
    await userEvent.type(
      screen.getByLabelText("Search keys and values"),
      "light",
    );
    expect(await screen.findByText("1 of 5 entries")).toBeTruthy();
    expect(screen.getByText("ui.theme")).toBeTruthy();
  });

  it("keeps a real Advanced category apart from the synthetic group", () => {
    renderEditor({
      catalog: {
        schemaVersion: 4,
        entries: [
          ...ENTRIES,
          {
            key: "dsp.oversample",
            kind: "config",
            category: "Advanced",
            label: "Oversampling",
            description: "",
            schema: { type: "integer" },
          },
        ],
      },
    });
    expect(screen.getByRole("button", { name: /^Advanced/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^More settings/ })).toBeTruthy();
    const ids = screen
      .getAllByRole("button", { expanded: true })
      .map((b) => b.getAttribute("aria-controls"));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
