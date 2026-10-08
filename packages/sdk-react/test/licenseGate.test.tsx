// @pkey-feature ui.kit
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { LicenseGate } from "../src/components/LicenseGate.js";
import type { LicenseGateSlots } from "../src/components/LicenseGate.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeState } from "../src/desktop/bridge.js";
import type { PartialTheme } from "../src/components/theme.js";
import {
  emptyBridgeState,
  makeDoc,
  makeFakeBridge,
  NOW_SEC,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(cleanup);

function renderGate(
  state: BridgeState,
  opts: {
    slots?: LicenseGateSlots;
    allowGrace?: boolean;
    theme?: PartialTheme;
    expectServices?: ReturnType<typeof services>;
  } = {},
) {
  const adapter = desktopAdapter({
    bridge: makeFakeBridge(state),
    now: () => NOW_SEC,
    expectServices: opts.expectServices ?? services(),
  });
  return render(
    <PolarisKeyProvider productSlug="acme" adapter={adapter} theme={opts.theme}>
      <LicenseGate slots={opts.slots} allowGrace={opts.allowGrace}>
        <div data-testid="app">APP CONTENT</div>
      </LicenseGate>
    </PolarisKeyProvider>,
  );
}

// A doc that is past expiresAt but still within graceUntil at NOW_SEC.
function graceDoc(): BridgeState {
  return okBridgeState({
    doc: makeDoc({
      issuedAt: 100,
      expiresAt: 200,
      graceUntil: NOW_SEC + 10_000,
    }),
  });
}
// A doc fully past graceUntil ⇒ expired.
function expiredDoc(): BridgeState {
  return okBridgeState({
    doc: makeDoc({ issuedAt: 100, expiresAt: 200, graceUntil: 300 }),
  });
}

describe("LicenseGate — ok renders children directly", () => {
  it("renders children unwrapped (no gate chrome) when ok", async () => {
    const { container } = renderGate(okBridgeState());
    await waitFor(() =>
      expect(within(container).getByTestId("app")).toBeTruthy(),
    );
    // ok renders a bare fragment — no data-polaris-gate wrapper.
    expect(container.querySelector("[data-polaris-gate]")).toBeNull();
  });
});

describe("LicenseGate — expired screen", () => {
  it("blocks the app and shows a re-auth (PolarisLogin) panel", async () => {
    const { container } = renderGate(expiredDoc());
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="expired"]'),
      ).toBeTruthy(),
    );
    expect(container.querySelector('[data-testid="app"]')).toBeNull();
    // Expired offers a re-auth login card under the message.
    expect(container.querySelector("[data-polaris-login]")).toBeTruthy();
  });
});

describe("LicenseGate — version-block copy (core gate.*)", () => {
  it("renders the catalog's title and sentence, without a raw range", async () => {
    const { container } = renderGate(
      okBridgeState({
        blocked: {
          reason: "version-too-old",
          allowedRange: { min: "2.0.0", max: "3.0.0" },
        },
      }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="version-block"]'),
      ).toBeTruthy(),
    );
    expect(container.textContent).toContain("Update required");
    expect(container.textContent).toContain(
      "This version is no longer supported. Update the app to continue.",
    );
    expect(container.textContent).not.toContain("allowed:");
    // The update service is off here, so Try again is the only action, as a primary.
    const buttons = within(container).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Try again"]);
  });

  it("uses the version-too-new copy for that reason", async () => {
    const { container } = renderGate(
      okBridgeState({
        blocked: { reason: "version-too-new", allowedRange: { max: "3.0.0" } },
      }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="version-block"]'),
      ).toBeTruthy(),
    );
    expect(container.textContent).toContain("Not available on this license");
    expect(container.textContent).toContain(
      "This build is newer than your license allows.",
    );
    expect(container.textContent).not.toContain("allowed:");
  });

  it("uses the channel-not-entitled copy for that reason", async () => {
    const { container } = renderGate(
      okBridgeState({ blocked: { reason: "channel-not-entitled" } }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="version-block"]'),
      ).toBeTruthy(),
    );
    expect(container.textContent).toContain("Channel not included");
  });
});

describe("LicenseGate — grace banner vs. block", () => {
  it("allowGrace (default) renders the banner + children", async () => {
    const { container } = renderGate(graceDoc());
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="grace"]'),
      ).toBeTruthy(),
    );
    expect(within(container).getByTestId("app")).toBeTruthy();
    // The default grace banner counts down from graceUntil (grace.daysLeft / grace.lastDay).
    expect(container.textContent).toMatch(/Offline · /);
  });

  it("allowGrace=false blocks like a login screen (children hidden)", async () => {
    const { container } = renderGate(graceDoc(), { allowGrace: false });
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="grace"]'),
      ).toBeTruthy(),
    );
    // No app + a login card is shown instead.
    expect(container.querySelector('[data-testid="app"]')).toBeNull();
    expect(container.querySelector("[data-polaris-login]")).toBeTruthy();
  });
});

describe("LicenseGate — render-prop slot overrides", () => {
  it("a custom login slot fully replaces the default login screen", async () => {
    const { container } = renderGate(emptyBridgeState(), {
      slots: {
        login: (ctx) => <div data-testid="custom-login">{ctx.status}</div>,
      },
    });
    await waitFor(() =>
      expect(within(container).getByTestId("custom-login")).toBeTruthy(),
    );
    expect(within(container).getByTestId("custom-login").textContent).toBe(
      "needs-activation",
    );
    // The default OIDC button is gone (the slot replaced the whole screen).
    expect(container.querySelector("[data-polaris-oidc]")).toBeNull();
  });

  it("a custom grace slot replaces the banner but children still render", async () => {
    const { container } = renderGate(graceDoc(), {
      slots: { grace: () => <div data-testid="custom-grace">GRACE</div> },
    });
    await waitFor(() =>
      expect(within(container).getByTestId("custom-grace")).toBeTruthy(),
    );
    expect(within(container).getByTestId("app")).toBeTruthy();
  });

  it("a custom versionBlock slot receives the gate context (range available)", async () => {
    const { container } = renderGate(
      okBridgeState({
        blocked: { reason: "version-too-old", allowedRange: { min: "5.0.0" } },
      }),
      {
        slots: {
          versionBlock: (ctx) => (
            <div data-testid="custom-vb">{ctx.gate.allowedRange?.min}</div>
          ),
        },
      },
    );
    await waitFor(() =>
      expect(within(container).getByTestId("custom-vb")).toBeTruthy(),
    );
    expect(within(container).getByTestId("custom-vb").textContent).toBe(
      "5.0.0",
    );
  });
});

describe("LicenseGate — brandable theme tokens", () => {
  it("applies custom theme tokens as --pk-* custom properties on the root", async () => {
    const { container } = renderGate(emptyBridgeState(), {
      theme: { tokens: { accent: "rgb(255, 0, 0)" } },
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="login"]'),
      ).toBeTruthy(),
    );
    const root = container.querySelector(
      "[data-polaris-key-root]",
    ) as HTMLElement;
    expect(root.style.getPropertyValue("--pk-accent")).toBe("rgb(255, 0, 0)");
  });

  it("renders custom copy from the theme on the version-block screen", async () => {
    const { container } = renderGate(
      okBridgeState({ blocked: { reason: "version-too-old" } }),
      { theme: { copy: { versionTooOldTitle: "Please upgrade now" } } },
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="version-block"]'),
      ).toBeTruthy(),
    );
    expect(container.textContent).toContain("Please upgrade now");
  });
});

describe("LicenseGate — error screen", () => {
  it("renders the error screen with a retry when first-load fails", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.getSyncState = async () => {
      throw new Error("ipc broke");
    };
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <LicenseGate>
          <div data-testid="app">APP</div>
        </LicenseGate>
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="error"]'),
      ).toBeTruthy(),
    );
    // First-load failures surface as a `network`-coded PolarisError → the gate shows the
    // clearer, remediation-oriented copy (not the raw IPC message).
    expect(container.textContent).toContain(
      "Can't reach Polaris Key. Check your connection and try again.",
    );
    adapter.dispose();
  });
});

describe("LicenseGate — a product that runs no license service (D-08)", () => {
  it("renders children immediately, with no gate chrome at all", async () => {
    // A config-only product has no license to be missing. The pre-suite gate parked it on a
    // sign-in screen it could never satisfy; `not-applicable` is the fix.
    const configOnly = services("config");
    const { container } = renderGate(
      emptyBridgeState({ capabilities: configOnly }),
      { expectServices: configOnly },
    );
    await waitFor(() =>
      expect(within(container).getByTestId("app")).toBeTruthy(),
    );
    expect(container.querySelector("[data-polaris-gate]")).toBeNull();
    expect(container.querySelector("[data-polaris-login]")).toBeNull();
  });

  it("stays out of the way even when the license transport errors", async () => {
    // An unreachable licensing service is not an error for a product that has none.
    const configOnly = services("config");
    const bridge = makeFakeBridge(
      emptyBridgeState({ capabilities: configOnly }),
    );
    bridge.getSyncState = async () => {
      throw new Error("ipc broke");
    };
    const adapter = desktopAdapter({
      bridge,
      now: () => NOW_SEC,
      expectServices: configOnly,
    });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <LicenseGate>
          <div data-testid="app">APP</div>
        </LicenseGate>
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(within(container).getByTestId("app")).toBeTruthy(),
    );
    expect(container.querySelector('[data-polaris-gate="error"]')).toBeNull();
    adapter.dispose();
  });
});
