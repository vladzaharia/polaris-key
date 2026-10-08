// @pkey-feature ui.kit config.list
// `<ConfigPanel>` — the settings panel over the shipped `listUserConfig`/`getConfigSource`
// data layer. What is asserted here is what a hand-rolled copy usually gets wrong: the
// provenance badge, and offering an override affordance ONLY where an override can win.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { ConfigPanel } from "../src/components/ConfigPanel.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { ManagedEntry } from "@polaris-key/protocol/core";
import {
  entry,
  makeFakeBridge,
  NOW_SEC,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(cleanup);

/** `waitFor` treats a null RETURN as success — only a throw retries. This asserts inside the
 *  callback so the query actually waits for the element to appear. */
async function findEl<T extends Element>(
  container: HTMLElement,
  selector: string,
): Promise<T> {
  return (await waitFor(() => {
    const el = container.querySelector(selector);
    expect(el, selector).toBeTruthy();
    return el;
  })) as T;
}

function renderPanel(
  config: Record<string, ManagedEntry>,
  opts: {
    localOverrides?: Record<string, unknown>;
    onOverride?: (key: string, value: string) => void;
    readOnly?: boolean;
    capabilities?: ReturnType<typeof services>;
  } = {},
) {
  const capabilities = opts.capabilities ?? services("license", "config");
  const adapter = desktopAdapter({
    bridge: makeFakeBridge(okBridgeState({ config, capabilities })),
    now: () => NOW_SEC,
    localOverrides: (opts.localOverrides ?? {}) as Record<string, never>,
    expectServices: capabilities,
  });
  const utils = render(
    <PolarisKeyProvider productSlug="acme" adapter={adapter}>
      <ConfigPanel onOverride={opts.onOverride} readOnly={opts.readOnly} />
    </PolarisKeyProvider>,
  );
  return { ...utils, adapter };
}

const sample = {
  "a.enforced": entry("enforced", "server"),
  "b.hidden": entry("hidden", "secret"),
  "c.default": entry("default", "shipped"),
};

describe("ConfigPanel — rows", () => {
  it("renders one row per user-visible key and excludes hidden ones", async () => {
    const { container, adapter } = renderPanel(sample);
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-config="rows"]'),
      ).toBeTruthy(),
    );
    expect(
      container.querySelector('[data-polaris-config-row="a.enforced"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-polaris-config-row="c.default"]'),
    ).toBeTruthy();
    // `hidden` is applied by getConfig but withheld from user-facing enumeration.
    expect(
      container.querySelector('[data-polaris-config-row="b.hidden"]'),
    ).toBeNull();
    adapter.dispose();
  });

  it("badges each row with its provenance", async () => {
    const { container, adapter } = renderPanel(sample, {
      localOverrides: { "c.default": "mine" },
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-config="rows"]'),
      ).toBeTruthy(),
    );
    expect(
      container
        .querySelector('[data-polaris-config-row="a.enforced"]')
        ?.querySelector("[data-polaris-config-source]")
        ?.getAttribute("data-polaris-config-source"),
    ).toBe("enforced");
    expect(
      container
        .querySelector('[data-polaris-config-row="c.default"]')
        ?.querySelector("[data-polaris-config-source]")
        ?.getAttribute("data-polaris-config-source"),
    ).toBe("local");
    // The badge is announced with the row rather than left as decoration.
    expect(
      within(container).getByLabelText(/a\.enforced: Managed/),
    ).toBeTruthy();
    adapter.dispose();
  });

  it("renders the empty state when nothing has been delivered", async () => {
    const { container, adapter } = renderPanel({});
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-config="empty"]'),
      ).toBeTruthy(),
    );
    expect(within(container).getByRole("status").textContent).toMatch(
      /No settings/i,
    );
    adapter.dispose();
  });
});

describe("ConfigPanel — the override affordance", () => {
  it("offers an input for default-state keys only", async () => {
    const onOverride = vi.fn();
    const { container, adapter } = renderPanel(sample, { onOverride });
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-config-input="c.default"]'),
      ).toBeTruthy(),
    );
    // An `enforced` key is locked to the server; an input that silently discards what you
    // typed is worse than no input.
    expect(
      container.querySelector('[data-polaris-config-input="a.enforced"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-polaris-config-value="a.enforced"]')
        ?.textContent,
    ).toBe("server");
    adapter.dispose();
  });

  it("commits an override to the host rather than persisting it itself", async () => {
    const onOverride = vi.fn();
    const { container, adapter } = renderPanel(sample, { onOverride });
    const input = await findEl<HTMLInputElement>(
      container,
      '[data-polaris-config-input="c.default"]',
    );
    fireEvent.change(input, { target: { value: "mine" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(onOverride).toHaveBeenCalledWith("c.default", "mine"),
    );
    adapter.dispose();
  });

  it("readOnly hides every input", async () => {
    const { container, adapter } = renderPanel(sample, {
      onOverride: vi.fn(),
      readOnly: true,
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-config="rows"]'),
      ).toBeTruthy(),
    );
    expect(container.querySelector("[data-polaris-config-input]")).toBeNull();
    adapter.dispose();
  });

  it("no onOverride and a host that cannot store overrides (bridge < v4) ⇒ no input", async () => {
    const { container, adapter } = renderPanel(sample);
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-config="rows"]'),
      ).toBeTruthy(),
    );
    expect(container.querySelector("[data-polaris-config-input]")).toBeNull();
    adapter.dispose();
  });
});

describe("ConfigPanel — the config service disabled", () => {
  it("explains itself instead of rendering an empty table", async () => {
    const { container, adapter } = renderPanel(
      {},
      { capabilities: services("license") },
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-config="disabled"]'),
      ).toBeTruthy(),
    );
    // Inline, in the host's page: the panel explains itself in place, never a full-window
    // dialog over the host app.
    const panel = container.querySelector(
      '[data-polaris-config="disabled"]',
    ) as HTMLElement;
    expect(panel.tagName).toBe("SECTION");
    expect(panel.style.position).not.toBe("fixed");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(within(panel).getByRole("heading").textContent).toBe(
      "Settings are not managed",
    );
    expect(container.textContent).toMatch(
      /does not distribute managed settings/i,
    );
    adapter.dispose();
  });
});

describe("ConfigPanel — layout and chrome", () => {
  it("the key names the field; no visible '{key} Override' label repeats it", async () => {
    const { container, adapter } = renderPanel(sample, {
      onOverride: vi.fn(),
    });
    const input = await findEl<HTMLInputElement>(
      container,
      '[data-polaris-config-input="c.default"]',
    );
    expect(within(container).getByLabelText("c.default")).toBe(input);
    expect(container.textContent).not.toContain("c.default Override");
    adapter.dispose();
  });

  it("draws no divider under the last row", async () => {
    const { container, adapter } = renderPanel(sample);
    await findEl(container, '[data-polaris-config="rows"]');
    const rows = container.querySelectorAll<HTMLElement>(
      "[data-polaris-config-row]",
    );
    expect(rows[rows.length - 1]!.style.borderBottom).not.toContain("solid");
    expect(rows[0]!.style.borderBottom).toContain("1px solid");
    adapter.dispose();
  });

  it("starts at the host's start edge, and bare drops the card chrome", async () => {
    const framed = renderPanel(sample);
    const panel = await findEl<HTMLElement>(
      framed.container,
      '[data-polaris-config="panel"]',
    );
    // A panel in the host's page never centres itself.
    expect(panel.style.margin).toMatch(/^0(px)?$/);
    expect(panel.style.border).toContain("1px solid");
    framed.adapter.dispose();
    cleanup();
    const capabilities = services("license", "config");
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState({ config: sample, capabilities })),
      now: () => NOW_SEC,
      expectServices: capabilities,
    });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <ConfigPanel bare />
      </PolarisKeyProvider>,
    );
    const bare = await findEl<HTMLElement>(
      container,
      '[data-polaris-config="panel"]',
    );
    expect(bare.style.background).toBe("transparent");
    expect(bare.style.borderRadius).toMatch(/^0(px)?$/);
    expect(within(bare).getByRole("heading").textContent).toBe("Settings");
    adapter.dispose();
  });
});

describe("ConfigPanel — slots", () => {
  it("a rows slot replaces the whole table but keeps the data layer", async () => {
    const capabilities = services("license", "config");
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState({ config: sample, capabilities })),
      now: () => NOW_SEC,
      expectServices: capabilities,
    });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <ConfigPanel
          slots={{
            rows: (rows) => (
              <div data-testid="custom">{rows.map((r) => r.key).join(",")}</div>
            ),
          }}
        />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(within(container).getByTestId("custom").textContent).toBe(
        "a.enforced,c.default",
      ),
    );
    expect(container.querySelector('[data-polaris-config="rows"]')).toBeNull();
    adapter.dispose();
  });
});
