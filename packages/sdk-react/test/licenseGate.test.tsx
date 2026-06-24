import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { LicenseGate } from "../src/components/LicenseGate.js";
import type { LicenseGateSlots } from "../src/components/LicenseGate.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeState } from "../src/desktop/bridge.js";
import type { PartialTheme } from "../src/components/theme.js";
import { makeDoc, makeFakeBridge, NOW_SEC } from "./fixtures.js";

afterEach(cleanup);

function renderGate(
  state: BridgeState,
  opts: { slots?: LicenseGateSlots; allowGrace?: boolean; theme?: PartialTheme } = {},
) {
  const adapter = desktopAdapter({ bridge: makeFakeBridge(state), now: () => NOW_SEC });
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
  return { hasToken: true, doc: makeDoc({ issuedAt: 100, expiresAt: 200, graceUntil: NOW_SEC + 10_000 }), lastVerifiedAt: NOW_SEC * 1000 };
}
// A doc fully past graceUntil ⇒ expired.
function expiredDoc(): BridgeState {
  return { hasToken: true, doc: makeDoc({ issuedAt: 100, expiresAt: 200, graceUntil: 300 }), lastVerifiedAt: NOW_SEC * 1000 };
}

describe("LicenseGate — ok renders children directly", () => {
  it("renders children unwrapped (no gate chrome) when ok", async () => {
    const { container } = renderGate({ hasToken: true, doc: makeDoc(), lastVerifiedAt: NOW_SEC * 1000 });
    await waitFor(() => expect(within(container).getByTestId("app")).toBeTruthy());
    // ok renders a bare fragment — no data-polaris-gate wrapper.
    expect(container.querySelector("[data-polaris-gate]")).toBeNull();
  });
});

describe("LicenseGate — expired screen", () => {
  it("blocks the app and shows a re-auth (PolarisLogin) panel", async () => {
    const { container } = renderGate(expiredDoc());
    await waitFor(() => expect(container.querySelector('[data-polaris-gate="expired"]')).toBeTruthy());
    expect(container.querySelector('[data-testid="app"]')).toBeNull();
    // Expired offers a re-auth login card under the message.
    expect(container.querySelector("[data-polaris-login]")).toBeTruthy();
  });
});

describe("LicenseGate — version-block shows the allowed range", () => {
  it("renders the version-block screen with the allowed range in the body", async () => {
    const { container } = renderGate({
      hasToken: true,
      doc: makeDoc(),
      blocked: { reason: "version-too-old", allowedRange: { min: "2.0.0", max: "3.0.0" } },
    });
    await waitFor(() => expect(container.querySelector('[data-polaris-gate="version-block"]')).toBeTruthy());
    expect(container.textContent).toContain("allowed: 2.0.0 – 3.0.0");
  });

  it("uses the version-too-new copy for that reason", async () => {
    const { container } = renderGate({
      hasToken: true,
      doc: makeDoc(),
      blocked: { reason: "version-too-new", allowedRange: { max: "3.0.0" } },
    });
    await waitFor(() => expect(container.querySelector('[data-polaris-gate="version-block"]')).toBeTruthy());
    expect(container.textContent).toContain("Version not allowed");
    expect(container.textContent).toContain("allowed: * – 3.0.0");
  });

  it("uses the channel-not-entitled copy for that reason", async () => {
    const { container } = renderGate({
      hasToken: true,
      doc: makeDoc(),
      blocked: { reason: "channel-not-entitled" },
    });
    await waitFor(() => expect(container.querySelector('[data-polaris-gate="version-block"]')).toBeTruthy());
    expect(container.textContent).toContain("Channel not entitled");
  });
});

describe("LicenseGate — grace banner vs. block", () => {
  it("allowGrace (default) renders the banner + children", async () => {
    const { container } = renderGate(graceDoc());
    await waitFor(() => expect(container.querySelector('[data-polaris-gate="grace"]')).toBeTruthy());
    expect(within(container).getByTestId("app")).toBeTruthy();
    // The default grace banner shows the grace copy.
    expect(container.textContent).toContain("Offline grace");
  });

  it("allowGrace=false blocks like a login screen (children hidden)", async () => {
    const { container } = renderGate(graceDoc(), { allowGrace: false });
    await waitFor(() => expect(container.querySelector('[data-polaris-gate="grace"]')).toBeTruthy());
    // No app + a login card is shown instead.
    expect(container.querySelector('[data-testid="app"]')).toBeNull();
    expect(container.querySelector("[data-polaris-login]")).toBeTruthy();
  });
});

describe("LicenseGate — render-prop slot overrides", () => {
  it("a custom login slot fully replaces the default login screen", async () => {
    const { container } = renderGate(
      { hasToken: false, doc: null },
      { slots: { login: (ctx) => <div data-testid="custom-login">{ctx.status}</div> } },
    );
    await waitFor(() => expect(within(container).getByTestId("custom-login")).toBeTruthy());
    expect(within(container).getByTestId("custom-login").textContent).toBe("needs-enroll");
    // The default OIDC button is gone (the slot replaced the whole screen).
    expect(container.querySelector("[data-polaris-oidc]")).toBeNull();
  });

  it("a custom grace slot replaces the banner but children still render", async () => {
    const { container } = renderGate(graceDoc(), {
      slots: { grace: () => <div data-testid="custom-grace">GRACE</div> },
    });
    await waitFor(() => expect(within(container).getByTestId("custom-grace")).toBeTruthy());
    expect(within(container).getByTestId("app")).toBeTruthy();
  });

  it("a custom versionBlock slot receives the gate context (range available)", async () => {
    const { container } = renderGate(
      { hasToken: true, doc: makeDoc(), blocked: { reason: "version-too-old", allowedRange: { min: "5.0.0" } } },
      { slots: { versionBlock: (ctx) => <div data-testid="custom-vb">{ctx.gate.allowedRange?.min}</div> } },
    );
    await waitFor(() => expect(within(container).getByTestId("custom-vb")).toBeTruthy());
    expect(within(container).getByTestId("custom-vb").textContent).toBe("5.0.0");
  });
});

describe("LicenseGate — brandable theme tokens", () => {
  it("applies custom theme tokens as --pk-* custom properties on the root", async () => {
    const { container } = renderGate(
      { hasToken: false, doc: null },
      { theme: { tokens: { accent: "rgb(255, 0, 0)" } } },
    );
    await waitFor(() => expect(container.querySelector('[data-polaris-gate="login"]')).toBeTruthy());
    const root = container.querySelector("[data-polaris-key-root]") as HTMLElement;
    expect(root.style.getPropertyValue("--pk-accent")).toBe("rgb(255, 0, 0)");
  });

  it("renders custom copy from the theme on the version-block screen", async () => {
    const { container } = renderGate(
      { hasToken: true, doc: makeDoc(), blocked: { reason: "version-too-old" } },
      { theme: { copy: { versionTooOldTitle: "Please upgrade now" } } },
    );
    await waitFor(() => expect(container.querySelector('[data-polaris-gate="version-block"]')).toBeTruthy());
    expect(container.textContent).toContain("Please upgrade now");
  });
});

describe("LicenseGate — error screen", () => {
  it("renders the error screen with a retry when first-load fails", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    bridge.getState = async () => {
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
    await waitFor(() => expect(container.querySelector('[data-polaris-gate="error"]')).toBeTruthy());
    // First-load failures surface as a `network`-coded PolarisError → the gate shows the
    // clearer, remediation-oriented copy (not the raw IPC message).
    expect(container.textContent).toContain("couldn't reach the licensing service");
    adapter.dispose();
  });
});
