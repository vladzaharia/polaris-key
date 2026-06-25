// Accessibility coverage for the drop-in UI: gate dialog roles + focus management, the
// grace banner status region, login keyboard nav (Enter submits), labelled inputs +
// role=alert errors, and the new <PolarisLogout>. These assert the WCAG-AA affordances the
// components promise so a regression (a dropped role, a lost label) fails loudly.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { LicenseGate } from "../src/components/LicenseGate.js";
import { PolarisLogin } from "../src/components/PolarisLogin.js";
import { PolarisLogout } from "../src/components/PolarisLogout.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeState } from "../src/desktop/bridge.js";
import type { PolarisAdapter } from "../src/core/index.js";
import { makeDoc, makeFakeBridge, NOW_SEC } from "./fixtures.js";

afterEach(cleanup);

function renderGate(state: BridgeState, opts: { allowGrace?: boolean } = {}) {
  const adapter = desktopAdapter({
    bridge: makeFakeBridge(state),
    now: () => NOW_SEC,
  });
  const utils = render(
    <PolarisKeyProvider productSlug="acme" adapter={adapter}>
      <LicenseGate allowGrace={opts.allowGrace}>
        <div data-testid="app">APP CONTENT</div>
      </LicenseGate>
    </PolarisKeyProvider>,
  );
  return { ...utils, adapter };
}

function renderLogin(
  adapter: PolarisAdapter,
  props: Parameters<typeof PolarisLogin>[0] = {},
) {
  return render(
    <PolarisKeyProvider productSlug="acme" adapter={adapter}>
      <PolarisLogin {...props} />
    </PolarisKeyProvider>,
  );
}

// expired = past graceUntil → blocking dialog with a re-auth card.
function expiredDoc(): BridgeState {
  return {
    hasToken: true,
    doc: makeDoc({ issuedAt: 100, expiresAt: 200, graceUntil: 300 }),
    lastVerifiedAt: NOW_SEC * 1000,
  };
}
function graceDoc(): BridgeState {
  return {
    hasToken: true,
    doc: makeDoc({
      issuedAt: 100,
      expiresAt: 200,
      graceUntil: NOW_SEC + 10_000,
    }),
    lastVerifiedAt: NOW_SEC * 1000,
  };
}

describe("LicenseGate a11y — dialog roles + accessible names", () => {
  it("the revoked screen is an alertdialog with an accessible name", async () => {
    const { container } = renderGate({
      hasToken: true,
      doc: makeDoc(),
      lastSyncUnauthorized: true,
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="revoked"]'),
      ).toBeTruthy(),
    );
    // Accessible name comes from the title via aria-labelledby → "License revoked".
    // getByRole's `name` option uses the native accessible-name computation.
    expect(
      within(container).getByRole("alertdialog", { name: "License revoked" }),
    ).toBeTruthy();
  });

  it("the version-block screen is an alertdialog with a named retry button", async () => {
    const { container } = renderGate({
      hasToken: true,
      doc: makeDoc(),
      blocked: { reason: "version-too-old", allowedRange: { min: "2.0.0" } },
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="version-block"]'),
      ).toBeTruthy(),
    );
    const dialog = within(container).getByRole("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(
      within(dialog).getByRole("button", { name: /try again/i }),
    ).toBeTruthy();
  });

  it("the login screen exposes an alertdialog wrapper named for sign-in", async () => {
    const { container } = renderGate({ hasToken: false, doc: null });
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="login"]'),
      ).toBeTruthy(),
    );
    expect(
      within(container).getByRole("alertdialog", { name: "Sign in" }),
    ).toBeTruthy();
  });

  it("the error screen is an alertdialog with a retry", async () => {
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
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="error"]'),
      ).toBeTruthy(),
    );
    const dialog = within(container).getByRole("alertdialog");
    expect(
      within(dialog).getByRole("button", { name: /try again/i }),
    ).toBeTruthy();
    adapter.dispose();
  });
});

describe("LicenseGate a11y — focus management", () => {
  it("moves focus to the retry button when a blocking dialog mounts", async () => {
    const { container } = renderGate({
      hasToken: true,
      doc: makeDoc(),
      blocked: { reason: "version-too-old", allowedRange: { min: "2.0.0" } },
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="version-block"]'),
      ).toBeTruthy(),
    );
    const retry = within(container).getByRole("button", { name: /try again/i });
    await waitFor(() => expect(document.activeElement).toBe(retry));
  });

  it("moves focus to the login card's primary action on the login screen", async () => {
    const { container } = renderGate({ hasToken: false, doc: null });
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-oidc]")).toBeTruthy(),
    );
    const oidc = container.querySelector(
      "[data-polaris-oidc]",
    ) as HTMLButtonElement;
    await waitFor(() => expect(document.activeElement).toBe(oidc));
  });
});

describe("LicenseGate a11y — grace banner is a status region", () => {
  it("renders the grace banner as role=status (non-blocking) with the app behind it", async () => {
    const { container } = renderGate(graceDoc());
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="grace"]'),
      ).toBeTruthy(),
    );
    const status = within(container).getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Offline grace");
    // It's a status, not a dialog — the app stays usable underneath.
    expect(within(container).getByTestId("app")).toBeTruthy();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });
});

describe("LicenseGate a11y — loading is a polite status, not a dialog", () => {
  it("renders the loading screen as role=status (transient, no focus steal)", async () => {
    // A slow bridge keeps the gate in the loading phase long enough to assert on it.
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    let resolveState: (s: BridgeState) => void = () => {};
    bridge.getState = () =>
      new Promise<BridgeState>((res) => (resolveState = res));
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
        container.querySelector('[data-polaris-gate="loading"]'),
      ).toBeTruthy(),
    );
    const status = within(container).getByRole("status");
    expect(status.textContent).toContain("Checking your license");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    // Let the pending load settle inside act() so the post-loading state update is flushed.
    await act(async () => {
      resolveState({ hasToken: false, doc: null });
    });
    adapter.dispose();
  });
});

describe("PolarisLogin a11y — keyboard + labels + alerts", () => {
  it("auto-focuses the OIDC button on mount", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge({ hasToken: false, doc: null }),
      now: () => 2000,
    });
    const { container } = renderLogin(adapter);
    const oidc = (await waitFor(() =>
      container.querySelector("[data-polaris-oidc]"),
    )) as HTMLButtonElement;
    await waitFor(() => expect(document.activeElement).toBe(oidc));
    adapter.dispose();
  });

  it("submits the key form on Enter and the input is labelled", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    bridge.submitKey = vi.fn(async () => ({ kind: "ok" }) as const);
    const adapter = desktopAdapter({ bridge, now: () => 2000 });
    const { container } = renderLogin(adapter);
    const input = (await waitFor(() =>
      container.querySelector("[data-polaris-key-input]"),
    )) as HTMLInputElement;
    // The input has an associated <label> → accessible by its name.
    const labelled = within(container).getByLabelText(/license key/i);
    expect(labelled).toBe(input);
    fireEvent.change(input, { target: { value: "PK-ENTER" } });
    // Pressing Enter in the field submits the form (no explicit button click).
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(bridge.submitKey).toHaveBeenCalledWith("PK-ENTER"),
    );
    adapter.dispose();
  });

  it("wires the input to its error via aria-describedby and announces role=alert", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    bridge.submitKey = vi.fn(async () => ({ kind: "unauthorized" }) as const);
    const adapter = desktopAdapter({ bridge, now: () => 2000 });
    const { container } = renderLogin(adapter);
    const input = (await waitFor(() =>
      container.querySelector("[data-polaris-key-input]"),
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    const alert = await waitFor(() => within(container).getByRole("alert"));
    // The clearer, code-derived message is surfaced.
    expect(alert.textContent).toMatch(/not accepted/i);
    // aria-invalid + aria-describedby point the input at the alert.
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    adapter.dispose();
  });

  it("announces the busy state on the primary action (aria-busy)", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    // Keep beginSignIn pending so busy stays true.
    bridge.beginSignIn = () => new Promise(() => {});
    const adapter = desktopAdapter({ bridge, now: () => 2000 });
    const { container } = renderLogin(adapter);
    const oidc = (await waitFor(() =>
      container.querySelector("[data-polaris-oidc]"),
    )) as HTMLButtonElement;
    fireEvent.click(oidc);
    await waitFor(() => expect(oidc.getAttribute("aria-busy")).toBe("true"));
    // It keeps an accessible name even while the busy glyph shows (aria-label is set).
    expect(
      within(container).getByRole("button", { name: /continue with polaris/i }),
    ).toBe(oidc);
    adapter.dispose();
  });
});

describe("PolarisLogout", () => {
  it("renders a branded button and calls signOut on click", async () => {
    const bridge = makeFakeBridge({
      hasToken: true,
      doc: makeDoc(),
      lastVerifiedAt: 2000 * 1000,
    });
    const signOutSpy = vi.spyOn(bridge, "signOut");
    const adapter = desktopAdapter({ bridge, now: () => 2000 });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <PolarisLogout />
      </PolarisKeyProvider>,
    );
    const btn = await waitFor(
      () =>
        within(container).getByRole("button", {
          name: /sign out/i,
        }) as HTMLButtonElement,
    );
    expect(btn.getAttribute("data-polaris-logout")).toBe("");
    fireEvent.click(btn);
    await waitFor(() => expect(signOutSpy).toHaveBeenCalledTimes(1));
    adapter.dispose();
  });

  it("honours a custom label", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge({
        hasToken: true,
        doc: makeDoc(),
        lastVerifiedAt: 2000 * 1000,
      }),
      now: () => 2000,
    });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <PolarisLogout label="Log out of Acme" />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(
        within(container).getByRole("button", { name: "Log out of Acme" }),
      ).toBeTruthy(),
    );
    adapter.dispose();
  });
});
