// @pkey-feature ui.gate ui.activate ui.devices
//
// The React kit's own behaviour beyond the matrix (UI-KITS.md §1.1–§1.3, §3, DL7, DL9): the empty
// theme is the Polaris Key look in ink, a fake presentation source gives the product's accent and
// icon with no integrator code, the shared stylesheet lands once per document and nothing on
// `:root`, controls report their action, typing and Enter drive Activate, the loading delay holds
// under StrictMode, and focus goes where the view says.

import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveKitColors } from "@polaris-key/ui-core/theme";
import type {
  PresentationSource,
  ProductPresentation,
} from "@polaris-key/client-core/presentation";

import {
  Activate,
  Devices,
  PolarisKeyGate,
  PolarisKeyTheme,
  Welcome,
  adoptKitStyles,
  kitStylesCss,
  type KitAction,
} from "@polaris-key/react/kit";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const welcome = {
  elapsedMs: 60_000,
  integrator: { name: "Tidewater" },
  gate: { status: "none" },
};

function rootOf(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>(".pk-root");
  expect(root).not.toBeNull();
  return root!;
}

function fakeSource(
  p: ProductPresentation,
  icon: Uint8Array | null,
): PresentationSource {
  return {
    current: () => p,
    icon: async () => icon,
    subscribe: () => () => {},
  };
}

describe("the default look", () => {
  it("an empty theme is the Polaris Key look in ink, scoped to the kit root", () => {
    const { container } = render(
      <Welcome input={welcome} theme={{ product: { name: "Tidewater" } }} />,
    );
    const root = rootOf(container);
    expect(root.dataset.preset).toBe("polaris-key");
    expect(root.dataset.theme).toBe("dark");
    const ink = resolveKitColors(null, "dark");
    expect(root.style.getPropertyValue("--pk-accent")).toBe(ink.primary);
    expect(root.style.getPropertyValue("--pk-accent-on")).toBe(ink.onPrimary);
    // Never on :root (§3.2).
    expect(document.documentElement.getAttribute("style") ?? "").not.toMatch(
      /--pk-/,
    );
    // The product is the identity (DL5): its monogram, its name once.
    expect(root.querySelector('[data-part="monogram"]')?.textContent).toBe("T");
    expect(root.querySelector("h1")?.textContent).toContain("Tidewater");
  });

  it("a product's presentation gives its accent and icon with no integrator code", async () => {
    const source = fakeSource(
      { name: "Driftkart", accent: "#ff6a3d", accentDark: "#ff8a5c" },
      new Uint8Array([137, 80, 78, 71]),
    );
    const { container } = render(
      <PolarisKeyTheme theme={{ presentation: source }}>
        <Welcome input={{ elapsedMs: 60_000, gate: { status: "none" } }} />
      </PolarisKeyTheme>,
    );
    const root = rootOf(container);
    const want = resolveKitColors("#ff8a5c", "dark");
    await waitFor(() =>
      expect(root.style.getPropertyValue("--pk-accent")).toBe(want.primary),
    );
    expect(root.style.getPropertyValue("--pk-accent-focus")).toBe(want.focus);
    await waitFor(() =>
      expect(
        root.querySelector<HTMLImageElement>('img[data-part="icon"]')?.src,
      ).toMatch(/^blob:/),
    );
    expect(root.textContent).toContain("Driftkart");
  });

  it("the monogram is the name's first letter past its bidi isolates", () => {
    const { container } = render(
      <Welcome
        input={welcome}
        theme={{ product: { name: "\u2068tidewater Studio\u2069" } }}
      />,
    );
    expect(
      rootOf(container).querySelector('[data-part="monogram"]')?.textContent,
    ).toBe("T");
  });

  it("the native preset hands the look to the host and draws no ambient", () => {
    const { container } = render(
      <Welcome input={welcome} theme={{ preset: "native" }} />,
    );
    const root = rootOf(container);
    expect(root.dataset.preset).toBe("native");
    expect(root.querySelector(".ambient")).toBeNull();
  });

  it("an integrator's colour scheme and radius reach the kit root", () => {
    const { container } = render(
      <Welcome
        input={welcome}
        theme={{ colorScheme: "light", radius: "lg" }}
      />,
    );
    const root = rootOf(container);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.getPropertyValue("--pk-kit-radius-control")).toBe("1rem");
  });
});

describe("the shared stylesheet", () => {
  it("is adopted once per document, never as a <style> element", () => {
    render(
      <>
        <Welcome input={welcome} />
        <Devices input={{ elapsedMs: 60_000, devices: [] }} />
      </>,
    );
    expect(document.querySelectorAll("style").length).toBe(0);
    // jsdom has no constructable sheets: a stand-in document and sheet.
    const texts: string[] = [];
    class Sheet {
      cssRules: unknown[] = [];
      replaceSync(t: string) {
        texts.push(t);
        this.cssRules = [t];
      }
    }
    vi.stubGlobal("CSSStyleSheet", Sheet);
    try {
      const doc = { adoptedStyleSheets: [] } as unknown as Document;
      adoptKitStyles(doc);
      adoptKitStyles(doc);
      expect(doc.adoptedStyleSheets).toHaveLength(1);
      expect(texts).toEqual([kitStylesCss()]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is in @layer polaris-key, anchored to the kit root, never :root", () => {
    const css = kitStylesCss();
    expect(css.trim().startsWith("/*") || css.trim().startsWith("@layer")).toBe(
      true,
    );
    expect(css).toContain("@layer polaris-key {");
    expect(css).not.toMatch(/:root|:host/);
  });
});

describe("controls", () => {
  it("report their copy key and vocabulary action", () => {
    const onAction = vi.fn<(a: KitAction) => void>();
    render(<Welcome input={welcome} onAction={onAction} />);
    const primary = document.querySelector<HTMLButtonElement>(
      '[data-variant="primary"]',
    )!;
    fireEvent.click(primary);
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        key: primary.dataset.key,
        component: "Welcome",
      }),
    );
  });

  it("typing a key moves Activate on, and Enter submits it", () => {
    const onAction = vi.fn<(a: KitAction) => void>();
    const onInput = vi.fn();
    const { container } = render(
      <Activate
        input={{ elapsedMs: 60_000 }}
        onAction={onAction}
        onInput={onInput}
      />,
    );
    const root = rootOf(container);
    expect(root.dataset.state).toBe("empty");
    const field = screen.getByLabelText(/license key/i) as HTMLInputElement;
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
    fireEvent.change(field, { target: { value: "pkey_ABCD" } });
    expect(onInput).toHaveBeenCalledWith("key", "pkey_ABCD");
    expect(root.dataset.state).not.toBe("empty");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ key: "activate.submit" }),
    );
  });
});

describe("loading (DL7) and StrictMode", () => {
  it("shows nothing for the delay, then the shimmer, under StrictMode", async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <StrictMode>
          <Devices input={{ loading: true }} />
        </StrictMode>,
      );
      expect(container.querySelector('[data-part="loading"]')).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(container.querySelector('[data-part="loading"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the gate", () => {
  it("renders the app once licensed, with no kit root around it", () => {
    const { container } = render(
      <PolarisKeyGate input={{ gate: { status: "ok" } }}>
        <p data-app="">app</p>
      </PolarisKeyGate>,
    );
    expect(container.querySelector("[data-app]")).not.toBeNull();
    expect(container.querySelector(".pk-root")).toBeNull();
  });

  it("never flashes Welcome while a cached license is checked", () => {
    const { container } = render(
      <PolarisKeyGate input={{ gate: { checking: true, cached: true } }}>
        <p data-app="">app</p>
      </PolarisKeyGate>,
    );
    expect(container.textContent).not.toMatch(/sign in/i);
  });
});

describe("focus (DL9)", () => {
  it("a screen opened with autoFocus focuses what its view says", async () => {
    render(<Welcome input={welcome} autoFocus />);
    await waitFor(() =>
      expect(document.activeElement?.closest(".pk-root")).not.toBeNull(),
    );
  });
});
