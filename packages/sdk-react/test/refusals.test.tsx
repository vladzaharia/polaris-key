// @pkey-feature ui.kit license.activate
//
// What the drop-in gate keeps and what it offers (UK-47):
//   * a refused key stays on the sign-in card with the key the person typed and the message
//     under it, across a refresh, and across a refresh that fails;
//   * a refusal means nothing once the licence is usable, and is gone;
//   * revoked is not a dead end: sign in, a different key and Try again are all there, and the
//     bearer transport backs off its 401s while a person's Try again still goes through.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { LicenseGate } from "../src/components/LicenseGate.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeActivation } from "../src/desktop/bridge.js";
import {
  NOW_SEC,
  emptyBridgeState,
  makeFakeBridge,
  okBridgeState,
} from "./fixtures.js";
import { keyField } from "./keyField.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MANAGE = "https://key.plrs.im/activate?product=acme&next=free-device";

function gate(submit: () => BridgeActivation) {
  const bridge = makeFakeBridge(emptyBridgeState());
  bridge.submitKey = vi.fn(async () => submit());
  const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
  const view = render(
    <PolarisKeyProvider productSlug="acme" adapter={adapter}>
      <LicenseGate>
        <div data-testid="app">APP</div>
      </LicenseGate>
    </PolarisKeyProvider>,
  );
  return { bridge, adapter, ...view };
}

async function refuse(container: HTMLElement) {
  const input = await keyField(container);
  fireEvent.change(input, { target: { value: "pkey_acme_WRONG" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() =>
    expect(container.querySelector("[data-polaris-key-error]")).toBeTruthy(),
  );
  return input;
}

describe("a refused key survives a refresh", () => {
  it("keeps the screen, the typed key and the message across a refresh", async () => {
    const { container, adapter } = gate(() => ({ kind: "unauthorized" }));
    const input = await refuse(container);
    const message = container.querySelector(
      "[data-polaris-key-error]",
    )!.textContent;
    expect(message).toBeTruthy();
    await adapter.refresh();
    await adapter.refresh({ force: true });
    expect(container.querySelector('[data-polaris-gate="login"]')).toBeTruthy();
    expect(container.querySelector('[data-polaris-gate="error"]')).toBeNull();
    expect(input.value).toBe("pkey_acme_WRONG");
    expect(
      container.querySelector("[data-polaris-key-error]")!.textContent,
    ).toBe(message);
    expect(adapter.snapshot().error.license?.activation?.kind).toBe(
      "unauthorized",
    );
    adapter.dispose();
  });

  it("keeps a device limit and its Replace a device across a refresh", async () => {
    const { container, adapter } = gate(() => ({
      kind: "device-limit",
      limit: 3,
      deviceCount: 3,
      manageUrl: MANAGE,
    }));
    const input = await keyField(container);
    fireEvent.change(input, { target: { value: "pkey_acme_KEY" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(
        container.querySelector("[data-polaris-free-device]"),
      ).toBeTruthy(),
    );
    await adapter.refresh();
    expect(container.querySelector("[data-polaris-free-device]")).toBeTruthy();
    expect(container.querySelector("[data-polaris-device-limit]")).toBeTruthy();
    adapter.dispose();
  });

  it("a refresh that fails does not replace the refusal with its own failure", async () => {
    const { container, adapter, bridge } = gate(() => ({
      kind: "unauthorized",
    }));
    await refuse(container);
    bridge.refresh = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(adapter.refresh()).rejects.toThrow();
    expect(container.querySelector('[data-polaris-gate="login"]')).toBeTruthy();
    expect(container.querySelector('[data-polaris-gate="error"]')).toBeNull();
    expect(adapter.snapshot().error.license?.activation?.kind).toBe(
      "unauthorized",
    );
    adapter.dispose();
  });

  it("is gone once the licence is usable", async () => {
    const { container, adapter, bridge } = gate(() => ({
      kind: "unauthorized",
    }));
    await refuse(container);
    bridge.push(okBridgeState());
    await waitFor(() =>
      expect(container.querySelector('[data-testid="app"]')).toBeTruthy(),
    );
    await adapter.refresh();
    expect(adapter.snapshot().error.license).toBeNull();
    adapter.dispose();
  });
});

describe("revoked has a way out", () => {
  function revoked() {
    const bridge = makeFakeBridge(
      okBridgeState({ lastSyncUnauthorized: true }),
    );
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    const view = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <LicenseGate>
          <div data-testid="app">APP</div>
        </LicenseGate>
      </PolarisKeyProvider>,
    );
    return { bridge, adapter, ...view };
  }

  it("offers Sign in, a different key and Try again, with one filled primary", async () => {
    const { container, adapter } = revoked();
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="revoked"]'),
      ).toBeTruthy(),
    );
    const labels = [...container.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["Sign in", "Use a different key", "Try again"]);
    // Sign in is the one filled action; the others recede.
    const oidc = container.querySelector("[data-polaris-oidc]") as HTMLElement;
    expect(oidc.style.background).toBe("var(--pk-accent)");
    const filled = [...container.querySelectorAll("button")].filter(
      (b) => (b as HTMLElement).style.background === "var(--pk-accent)",
    );
    expect(filled).toHaveLength(1);
    adapter.dispose();
  });

  it("Try again re-reads the state, and a restored licence lets the person in", async () => {
    const { container, adapter, bridge } = revoked();
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="revoked"]'),
      ).toBeTruthy(),
    );
    const refresh = vi.spyOn(bridge, "refresh");
    bridge.refresh = async () => okBridgeState();
    const retry = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Try again",
    )!;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="app"]')).toBeTruthy(),
    );
    void refresh;
    adapter.dispose();
  });

  it("the different-key button opens the key form", async () => {
    const { container, adapter } = revoked();
    const input = await keyField(container);
    expect(input).toBeTruthy();
    adapter.dispose();
  });
});
