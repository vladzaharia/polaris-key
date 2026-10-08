// @pkey-feature ui.kit ui.kit.manage
//
// The drop-in kit's narrow fixes ahead of UK-05: a full device limit never dead-ends the gate,
// the sign-in line names the product, the kit never falls back to the browser's serif, and the
// full-window layout switches on the window's size. The real-browser half (overflow, first
// viewport, target sizes, text scaling at every width) is test/browser/responsive.browser.test.tsx.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { LicenseGate } from "../src/components/LicenseGate.js";
import { PolarisLogin, signInLede } from "../src/components/PolarisLogin.js";
import { MessageScreen } from "../src/components/primitives/MessageScreen.js";
import { Button } from "../src/components/primitives/buttons.js";
import {
  SYSTEM_FONT_STACK,
  defaultTheme,
  isBrowserDefaultFont,
  mergeTheme,
} from "../src/components/theme.js";
import { screenFor } from "../src/react/hooks.js";
import {
  BLEED_BELOW_REM,
  SHORT_BELOW_REM,
  windowLayoutOf,
} from "../src/components/primitives/layout.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeActivation } from "../src/desktop/bridge.js";
import {
  PolarisError,
  type PolarisAdapter,
  type PolarisState,
} from "../src/core/index.js";
import {
  NOW_SEC,
  emptyBridgeState,
  makeFakeBridge,
  services,
} from "./fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MANAGE =
  "https://key.plrs.im/activate?product=acme&next=free-device&for=Web";

function deviceLimitAdapter(): PolarisAdapter {
  const bridge = makeFakeBridge(emptyBridgeState());
  bridge.submitKey = vi.fn(
    async () =>
      ({
        kind: "device-limit",
        limit: 3,
        deviceCount: 3,
        manageUrl: MANAGE,
      }) as BridgeActivation,
  );
  return desktopAdapter({
    bridge,
    now: () => NOW_SEC,
    expectServices: services(),
  });
}

/** The adapter with one error forced onto the license slot of every snapshot. */
function withLicenseError(
  real: PolarisAdapter,
  error: PolarisError,
): PolarisAdapter {
  let from: PolarisState | null = null;
  let out: PolarisState | null = null;
  const snapshot = (): PolarisState => {
    const s = real.snapshot();
    if (s !== from) {
      from = s;
      out = { ...s, error: { ...s.error, license: error } };
    }
    return out!;
  };
  return Object.assign(Object.create(real) as PolarisAdapter, { snapshot });
}

describe("LicenseGate — a full device limit never dead-ends", () => {
  it("keeps a refused key on the sign-in card, with Replace a device", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const adapter = deviceLimitAdapter();
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <LicenseGate returnUrl="myapp://back">
          <div data-testid="app">APP</div>
        </LicenseGate>
      </PolarisKeyProvider>,
    );
    const input = await waitFor(() => {
      const el = container.querySelector("[data-polaris-key-input]");
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    });
    fireEvent.change(input, { target: { value: "pkey_acme_KEY" } });
    fireEvent.submit(input.closest("form")!);
    const replace = await waitFor(() => {
      const el = container.querySelector("[data-polaris-free-device]");
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    // Still the sign-in card: the key the person typed and the refusal under it.
    expect(container.querySelector('[data-polaris-gate="login"]')).toBeTruthy();
    expect(container.querySelector('[data-polaris-gate="error"]')).toBeNull();
    expect(input.value).toBe("pkey_acme_KEY");
    expect(within(container).getByRole("alert").textContent).toMatch(
      /already on all its devices/i,
    );
    fireEvent.click(replace);
    expect(open).toHaveBeenCalledWith(
      "https://key.plrs.im/activate?product=acme&next=free-device&for=Web&return=myapp%3A%2F%2Fback#key=pkey_acme_KEY",
      "_blank",
      "noopener,noreferrer",
    );
    adapter.dispose();
  });

  it("the error screen leads with Replace a device when the failure carries the portal link", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const real = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => NOW_SEC,
      expectServices: services(),
    });
    const adapter = withLicenseError(
      real,
      new PolarisError(
        "refresh-failed",
        "This license is already on all its devices.",
        "device_limit",
        undefined,
        { manageUrl: MANAGE },
      ),
    );
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <LicenseGate returnUrl="myapp://back">
          <div data-testid="app">APP</div>
        </LicenseGate>
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="error"]'),
      ).toBeTruthy(),
    );
    const dialog = within(container).getByRole("alertdialog");
    const buttons = within(dialog).getAllByRole("button");
    // The main action first (and focused), Try again beside it.
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Replace a device",
      "Try again",
    ]);
    await waitFor(() => expect(document.activeElement).toBe(buttons[0]));
    fireEvent.click(buttons[0]!);
    expect(open).toHaveBeenCalledWith(
      "https://key.plrs.im/activate?product=acme&next=free-device&for=Web&return=myapp%3A%2F%2Fback",
      "_blank",
      "noopener,noreferrer",
    );
    real.dispose();
  });

  it("screenFor: a refused key or sign-in stays on the card; a failed load is the error screen", () => {
    const adapter = deviceLimitAdapter();
    const base = {
      ...adapter.snapshot(),
      phase: "ready",
      status: "needs-activation",
    } as PolarisState;
    adapter.dispose();
    const at = (license: PolarisError | null, identity: PolarisError | null) =>
      screenFor({ ...base, error: { ...base.error, license, identity } });
    const refusal = new PolarisError("sign-in-failed", "limit", "device_limit");
    const keyNetwork = new PolarisError("network", "offline", "network", "", {
      activation: { kind: "error", code: "network" },
    });
    expect(at(refusal, null)).toBe("login");
    expect(at(null, new PolarisError("sign-in-failed", "denied"))).toBe(
      "login",
    );
    // A key submission that could not reach the server is still the card's to retry.
    expect(at(keyNetwork, null)).toBe("login");
    expect(at(new PolarisError("network", "down"), null)).toBe("error");
    expect(at(refusal, new PolarisError("bridge-missing", "no bridge"))).toBe(
      "error",
    );
  });
});

describe("PolarisLogin — the line under the title names the product", () => {
  const both = { signIn: true, key: true };
  it("names the product when the integrator gave its name", () => {
    const theme = mergeTheme({ copy: { productName: "Tidewater" } });
    expect(signInLede(theme, both)).toBe(
      "Sign in or enter a license key to use Tidewater.",
    );
    expect(signInLede(theme, { signIn: true, key: false })).toBe(
      "Sign in to use Tidewater.",
    );
    expect(signInLede(theme, { signIn: false, key: true })).toBe(
      "Enter a license key to use Tidewater.",
    );
  });

  it("says what the card offers when the name is a placeholder", () => {
    expect(signInLede(defaultTheme, both)).toBe(
      "Sign in or use a license key to continue.",
    );
    // "Polaris Key" names the platform, not the product behind the gate.
    expect(signInLede(mergeTheme({ branding: "polaris-key" }), both)).toBe(
      "Sign in or use a license key to continue.",
    );
    expect(signInLede(defaultTheme, { signIn: false, key: true })).toBe(
      "Enter a license key to continue.",
    );
  });

  it("an explicit signInSubtitle wins", () => {
    const theme = mergeTheme({
      copy: { productName: "Tidewater", signInSubtitle: "Welcome back." },
    });
    expect(signInLede(theme, both)).toBe("Welcome back.");
  });

  it("renders it on the card", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => NOW_SEC,
      expectServices: services(),
    });
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        adapter={adapter}
        theme={{ copy: { productName: "Tidewater" } }}
      >
        <PolarisLogin />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(
        container.querySelector("[data-polaris-login-lede]")?.textContent,
      ).toBe("Sign in or enter a license key to use Tidewater."),
    );
    expect(container.textContent).not.toMatch(/Authenticate to unlock/);
    adapter.dispose();
  });
});

describe("Theme — the font never falls back to the browser's serif", () => {
  it("recognises every engine's default font", () => {
    for (const f of [
      '"Times New Roman"',
      "Times New Roman",
      "Times",
      "serif",
      "-webkit-standard",
    ])
      expect(isBrowserDefaultFont(f), f).toBe(true);
    for (const f of ["Inter, sans-serif", "system-ui", '"Rubik", serif'])
      expect(isBrowserDefaultFont(f), f).toBe(false);
  });

  it("an `inherit` font on a page that sets none publishes the system stack", async () => {
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const cs = real(el, pseudo);
      if ((el as Element).hasAttribute?.("data-polaris-key-root"))
        return new Proxy(cs, {
          get: (t, k) =>
            k === "fontFamily" ? '"Times New Roman"' : Reflect.get(t, k),
        });
      return cs;
    });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={deviceLimitAdapter()}>
        <span />
      </PolarisKeyProvider>,
    );
    const root = container.querySelector(
      "[data-polaris-key-root]",
    ) as HTMLElement;
    await waitFor(() =>
      expect(root.style.getPropertyValue("--pk-font-family")).toBe(
        SYSTEM_FONT_STACK,
      ),
    );
  });

  it("a host font, or a theme font, is left alone", () => {
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={deviceLimitAdapter()}>
        <span />
      </PolarisKeyProvider>,
    );
    const root = container.querySelector(
      "[data-polaris-key-root]",
    ) as HTMLElement;
    expect(root.style.getPropertyValue("--pk-font-family")).toBe("inherit");
  });
});

describe("Full-window layout", () => {
  it("bleeds below 35rem of width and is short below 30rem of height", () => {
    expect(windowLayoutOf({ width: 0, height: 0 })).toEqual({
      bleed: false,
      short: false,
    });
    expect(windowLayoutOf({ width: 390 / 16, height: 844 / 16 })).toEqual({
      bleed: true,
      short: false,
    });
    expect(windowLayoutOf({ width: 844 / 16, height: 390 / 16 })).toEqual({
      bleed: false,
      short: true,
    });
    // A 24 px root makes a 768 px window narrow: 32rem of text.
    expect(windowLayoutOf({ width: 768 / 24, height: 1024 / 24 }).bleed).toBe(
      true,
    );
    expect(BLEED_BELOW_REM).toBe(35);
    expect(SHORT_BELOW_REM).toBe(30);
  });

  it("a message screen's actions share one row, the main action first", () => {
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={deviceLimitAdapter()}>
        <MessageScreen
          title="An update is available"
          onRetry={() => undefined}
          retryLabel="Get the update"
          retryVariant="primary"
          secondaryAction={<Button variant="ghost">Not now</Button>}
        />
      </PolarisKeyProvider>,
    );
    const row = container.querySelector(
      "[data-polaris-actions]",
    ) as HTMLElement;
    expect(row.style.display).toBe("grid");
    expect([...row.children].map((b) => b.textContent)).toEqual([
      "Get the update",
      "Not now",
    ]);
  });
});
