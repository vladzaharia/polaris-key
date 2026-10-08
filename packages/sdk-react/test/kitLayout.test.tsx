// @pkey-feature ui.kit ui.kit.manage
//
// The drop-in kit's fixes ahead of UK-05: a full device limit never dead-ends the gate, the
// sign-in card's errors sit by the control they belong to, the kit never falls back to the
// browser's serif, and the full-window layout switches on the window's size. The real-browser half (overflow, first
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
import { PolarisLogin, signInTitle } from "../src/components/PolarisLogin.js";
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
import { keyField } from "./keyField.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MANAGE =
  "https://key.plrs.im/activate?product=acme&next=free-device&for=Web";

function deviceLimitAdapter(
  submitKey: () => Promise<BridgeActivation> = async () =>
    ({
      kind: "device-limit",
      limit: 3,
      deviceCount: 3,
      manageUrl: MANAGE,
    }) as BridgeActivation,
): PolarisAdapter {
  const bridge = makeFakeBridge(emptyBridgeState());
  bridge.submitKey = vi.fn(submitKey);
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
  it("keeps a refused key on the sign-in card: a neutral callout and Replace a device, focused", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const submitKey = vi.fn(
      async () =>
        ({
          kind: "device-limit",
          limit: 3,
          deviceCount: 3,
          manageUrl: MANAGE,
        }) as BridgeActivation,
    );
    const adapter = deviceLimitAdapter(submitKey);
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        adapter={adapter}
        theme={{ copy: { productName: "Tidewater" } }}
      >
        <LicenseGate returnUrl="myapp://back">
          <div data-testid="app">APP</div>
        </LicenseGate>
      </PolarisKeyProvider>,
    );
    const input = await keyField(container);
    fireEvent.change(input, { target: { value: "pkey_acme_KEY" } });
    fireEvent.submit(input.closest("form")!);
    const replace = await waitFor(() => {
      const el = container.querySelector("[data-polaris-free-device]");
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    // Still the sign-in card: the key the person typed, and the limit under it.
    expect(container.querySelector('[data-polaris-gate="login"]')).toBeTruthy();
    expect(container.querySelector('[data-polaris-gate="error"]')).toBeNull();
    expect(input.value).toBe("pkey_acme_KEY");
    const callout = container.querySelector(
      "[data-polaris-device-limit]",
    ) as HTMLElement;
    expect(callout.textContent).toBe(
      "Your license is on 3 of 3 devices" +
        "Replace a device in your browser. Tidewater continues when you're done.",
    );
    // Not an error: the key is good. No alert, no invalid field.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
    // The way out is the one filled action, focused, describing where it goes.
    await waitFor(() => expect(document.activeElement).toBe(replace));
    const described = replace.getAttribute("aria-describedby")!;
    expect(document.getElementById(described)?.textContent).toMatch(
      /^Replace a device in your browser/,
    );
    const oidc = container.querySelector("[data-polaris-oidc]") as HTMLElement;
    expect(oidc.style.background).toBe("transparent");
    fireEvent.click(replace);
    expect(open).toHaveBeenCalledWith(
      "https://key.plrs.im/activate?product=acme&next=free-device&for=Web&return=myapp%3A%2F%2Fback#key=pkey_acme_KEY",
      "_blank",
      "noopener,noreferrer",
    );
    // Back from the portal: the key in the field is tried again, once.
    expect(submitKey).toHaveBeenCalledTimes(1);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(submitKey).toHaveBeenCalledTimes(2));
    fireEvent(window, new Event("focus"));
    await new Promise((r) => setTimeout(r, 20));
    expect(submitKey).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });

  it("a sign-in failure sits under Sign in and never marks the key field", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.beginSignIn = async () => {
      throw new Error("browser closed");
    };
    const adapter = desktopAdapter({
      bridge,
      now: () => NOW_SEC,
      expectServices: services(),
    });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <PolarisLogin />
      </PolarisKeyProvider>,
    );
    const oidc = await waitFor(() => {
      const el = container.querySelector("[data-polaris-oidc]");
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    fireEvent.click(oidc);
    const alert = await waitFor(() => {
      const el = container.querySelector("[data-polaris-signin-error]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(alert.textContent).toBe("Sign-in didn't finish. Try again.");
    expect(oidc.getAttribute("aria-describedby")).toBe(alert.id);
    expect(alert.previousElementSibling).toBe(oidc);
    adapter.dispose();
  });

  it("an unknown refusal code is never shown raw, and typing clears the refusal", async () => {
    const adapter = deviceLimitAdapter(
      async () =>
        ({
          kind: "refused",
          code: "license_suspended",
          message: "nope",
        }) as BridgeActivation,
    );
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <PolarisLogin />
      </PolarisKeyProvider>,
    );
    const input = await keyField(container);
    fireEvent.change(input, { target: { value: "k" } });
    fireEvent.submit(input.closest("form")!);
    const alert = await waitFor(() => within(container).getByRole("alert"));
    expect(alert.textContent).toBe("Something went wrong. Try again.");
    // A refused key is not a wrong key: the field is not marked invalid.
    expect(input.getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(input, { target: { value: "k2" } });
    expect(container.querySelector('[role="alert"]')).toBeNull();
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
    // The catalog's limit title, and where Replace goes.
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "Device limit reached",
    );
    expect(dialog.textContent).toContain("Replace a device in your browser.");
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

describe("PolarisLogin — the title names the product", () => {
  it("is Welcome to {product} once the name is set, else Sign in", () => {
    expect(
      signInTitle(mergeTheme({ copy: { productName: "Tidewater" } })),
    ).toBe("Welcome to Tidewater");
    expect(signInTitle(defaultTheme)).toBe("Sign in");
    // "Polaris Key" names the platform, not the product behind the gate.
    expect(signInTitle(mergeTheme({ branding: "polaris-key" }))).toBe(
      "Sign in",
    );
  });

  it("renders no lede by default, and the integrator's when set", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => NOW_SEC,
      expectServices: services(),
    });
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        adapter={adapter}
        theme={{ copy: { signInSubtitle: "Welcome back." } }}
      >
        <PolarisLogin />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector("h2 + p")?.textContent).toBe(
        "Welcome back.",
      ),
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
      twoColumn: false,
      sheet: false,
    });
    expect(windowLayoutOf({ width: 390 / 16, height: 844 / 16 })).toEqual({
      bleed: true,
      short: false,
      twoColumn: false,
      sheet: false,
    });
    // A phone on its side: two columns, the title beside the controls.
    expect(windowLayoutOf({ width: 844 / 16, height: 390 / 16 })).toEqual({
      bleed: false,
      short: true,
      twoColumn: true,
      sheet: false,
    });
    // A dismissible dialog on a phone is a bottom sheet over the app.
    expect(
      windowLayoutOf({ width: 390 / 16, height: 844 / 16 }, { scrim: true }),
    ).toEqual({ bleed: false, short: false, twoColumn: false, sheet: true });
    // A 24 px root makes a 768 px window narrow: 32rem of text.
    expect(windowLayoutOf({ width: 768 / 24, height: 1024 / 24 }).bleed).toBe(
      true,
    );
    expect(BLEED_BELOW_REM).toBe(35);
    expect(SHORT_BELOW_REM).toBe(30);
  });

  it("a message screen's actions stack, the main action first", () => {
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={deviceLimitAdapter()}>
        <MessageScreen
          title="An update is available"
          onRetry={() => undefined}
          retryLabel="Get the update"
          retryVariant="primary"
          secondaryAction={<Button variant="secondary">Later</Button>}
        />
      </PolarisKeyProvider>,
    );
    const row = container.querySelector(
      "[data-polaris-actions]",
    ) as HTMLElement;
    expect(row.style.display).toBe("grid");
    expect(row.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect([...row.children].map((b) => b.textContent)).toEqual([
      "Get the update",
      "Later",
    ]);
  });
});
