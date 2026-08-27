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
    // `ui.advanced` entries sink into their own trailing group rather than padding a category.
    expect(screen.getByRole("button", { name: /Advanced/ })).toBeTruthy();
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
    await userEvent.type(screen.getByLabelText("Filter keys"), "audio");
    expect(await screen.findByText("2 of 5 entries")).toBeTruthy();
    expect(screen.getByText("Buffer size")).toBeTruthy();
    expect(screen.queryByText("Theme")).toBeNull();
  });

  it("matches on the dotted key even when the label does not contain it", async () => {
    renderEditor();
    await userEvent.type(screen.getByLabelText("Filter keys"), "net.hosts");
    expect(await screen.findByText("1 of 5 entries")).toBeTruthy();
    expect(screen.getByText("Allowed hosts")).toBeTruthy();
  });

  it("offers a clear-filter affordance when nothing matches", async () => {
    renderEditor();
    await userEvent.type(screen.getByLabelText("Filter keys"), "zzzz");
    expect(
      await screen.findByText("No entries match this filter"),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));
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
    await userEvent.type(screen.getByLabelText("Filter keys"), "theme");
    await waitFor(() => expect(body().hasAttribute("hidden")).toBe(false));
    expect(screen.getByLabelText("Theme")).toBeTruthy();
  });
});

describe("ManagedPayloadEditor — set vs unset", () => {
  it("shows absent keys as 'Not set' with no editor at all", () => {
    renderEditor();
    // `audio.buffer` is not in the payload.
    expect(screen.queryByLabelText("Buffer size")).toBeNull();
    expect(screen.getAllByText("Not set").length).toBeGreaterThan(0);
    expect(screen.getByText(/clients fall back to 512/)).toBeTruthy();
  });

  it("materialises an editor seeded from the catalog default, and counts it as a change", async () => {
    renderEditor();
    const row = screen.getByText("audio.buffer").closest("div")!.parentElement!
      .parentElement!;
    await userEvent.click(
      within(row).getByRole("button", { name: "Set value" }),
    );
    const input = (await screen.findByLabelText(
      "Buffer size",
    )) as HTMLInputElement;
    expect(input.value).toBe("512");
    expect(await screen.findByText(/1 unsaved change/)).toBeTruthy();
  });

  it("clearing a set key sends the worker's delete shape, never an empty string", async () => {
    const { onSubmit } = renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Clear Theme" }));
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

  it("blocks Save while any row has an inline validation error", async () => {
    renderEditor();
    // Materialise the bounded integer, then push it out of range.
    await userEvent.click(
      within(
        screen.getByText("audio.buffer").closest("div")!.parentElement!
          .parentElement!,
      ).getByRole("button", { name: "Set value" }),
    );
    const input = await screen.findByLabelText("Buffer size");
    await userEvent.clear(input);
    await userEvent.type(input, "9999");
    // The message is the catalog validator's — the same one a 422 would carry.
    expect(await screen.findByText(/must be <= 2048/)).toBeTruthy();
    const save = screen.getByRole("button", {
      name: /Save changes/,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/fix 1 error to save/)).toBeTruthy();
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
        .getByRole("link", { name: /Go to Config → Catalog/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/config");
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
