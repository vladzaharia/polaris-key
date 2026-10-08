import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { LicenseGate } from "../src/components/LicenseGate.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeState } from "../src/desktop/bridge.js";
import {
  emptyBridgeState,
  makeDoc,
  makeFakeBridge,
  NOW_SEC,
  okBridgeState,
} from "./fixtures.js";

afterEach(cleanup);

// A render helper that returns the container for query-by-attribute (scoped per render).
function renderGate(state: BridgeState) {
  const adapter = desktopAdapter({
    bridge: makeFakeBridge(state),
    now: () => NOW_SEC,
  });
  return render(
    <PolarisKeyProvider productSlug="acme" adapter={adapter}>
      <LicenseGate>
        <div data-testid="app">APP CONTENT</div>
      </LicenseGate>
    </PolarisKeyProvider>,
  );
}

describe("LicenseGate screen selection", () => {
  it("renders children when ok", async () => {
    const { container } = renderGate(okBridgeState());
    await waitFor(() =>
      expect(within(container).getByTestId("app")).toBeTruthy(),
    );
  });

  it("renders the login screen when needs-activation", async () => {
    const { container } = renderGate(emptyBridgeState());
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="login"]'),
      ).toBeTruthy(),
    );
    expect(container.querySelector('[data-testid="app"]')).toBeNull();
    // The OIDC button is present.
    expect(container.querySelector("[data-polaris-oidc]")).toBeTruthy();
    // Desktop offers key entry, behind "Use a license key".
    expect(container.querySelector("[data-polaris-use-key]")).toBeTruthy();
  });

  it("renders the revoked screen on a hard 401", async () => {
    const { container } = renderGate(
      okBridgeState({ lastSyncUnauthorized: true }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="revoked"]'),
      ).toBeTruthy(),
    );
    expect(container.querySelector('[data-testid="app"]')).toBeNull();
  });

  it("renders a version-block screen on a 403 block", async () => {
    const { container } = renderGate(
      okBridgeState({
        blocked: { reason: "version-too-old", allowedRange: { min: "2.0.0" } },
      }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="version-block"]'),
      ).toBeTruthy(),
    );
    expect(container.querySelector('[data-testid="app"]')).toBeNull();
  });

  it("renders children behind a grace banner when in grace", async () => {
    const { container } = renderGate(
      okBridgeState({
        doc: makeDoc({
          issuedAt: 100,
          expiresAt: 200,
          graceUntil: NOW_SEC + 10_000,
        }),
      }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="grace"]'),
      ).toBeTruthy(),
    );
    // Grace still renders the app underneath the banner.
    expect(within(container).getByTestId("app")).toBeTruthy();
  });
});
