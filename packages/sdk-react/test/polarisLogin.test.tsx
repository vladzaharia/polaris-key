import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { PolarisLogin } from "../src/components/PolarisLogin.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { PolarisBridge } from "../src/desktop/bridge.js";
import type { PolarisAdapter } from "../src/core/index.js";
import { makeFakeBridge, makeFakeFetch } from "./fixtures.js";

afterEach(cleanup);

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

describe("PolarisLogin — OIDC button", () => {
  it("always renders the OIDC button (both modes)", async () => {
    const browser = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(null),
      now: () => 2000,
    });
    const { container } = renderLogin(browser);
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-oidc]")).toBeTruthy(),
    );
    browser.dispose();
  });

  it("clicking OIDC triggers signInWithOidc on the adapter", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    const beginSpy = vi.spyOn(bridge, "beginSignIn");
    const adapter = desktopAdapter({ bridge, now: () => 2000 });
    const { container } = renderLogin(adapter);
    const btn = await waitFor(
      () => container.querySelector("[data-polaris-oidc]") as HTMLButtonElement,
    );
    fireEvent.click(btn);
    await waitFor(() => expect(beginSpy).toHaveBeenCalledTimes(1));
    adapter.dispose();
  });
});

describe("PolarisLogin — key card visibility", () => {
  it("desktop shows the typed-key card", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge({ hasToken: false, doc: null }),
      now: () => 2000,
    });
    const { container } = renderLogin(adapter);
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-key-input]")).toBeTruthy(),
    );
    adapter.dispose();
  });

  it("browser shows the typed-key card", async () => {
    const browser = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(null),
      now: () => 2000,
    });
    const { container } = renderLogin(browser);
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-oidc]")).toBeTruthy(),
    );
    expect(container.querySelector("[data-polaris-key-input]")).toBeTruthy();
    browser.dispose();
  });

  it("hideKeyEntry hides the card even on desktop", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge({ hasToken: false, doc: null }),
      now: () => 2000,
    });
    const { container } = renderLogin(adapter, { hideKeyEntry: true });
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-oidc]")).toBeTruthy(),
    );
    expect(container.querySelector("[data-polaris-key-input]")).toBeNull();
    adapter.dispose();
  });
});

describe("PolarisLogin — key submission", () => {
  it("submits a trimmed key and surfaces the bridge's rejection as an alert", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    bridge.submitKey = vi.fn(async () => ({ kind: "unauthorized" }) as const);
    const adapter = desktopAdapter({ bridge, now: () => 2000 });
    const { container } = renderLogin(adapter);
    const input = (await waitFor(() =>
      container.querySelector("[data-polaris-key-input]"),
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  PK-12345  " } });
    const form = container.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);
    // The bridge sees the trimmed key, and the rejection surfaces as a role=alert message.
    await waitFor(() =>
      expect(bridge.submitKey).toHaveBeenCalledWith("PK-12345"),
    );
    await waitFor(() => {
      const alert = within(container).getByRole("alert");
      expect(alert.textContent).toMatch(/not accepted/i);
    });
    adapter.dispose();
  });

  it("the submit button is disabled while the key field is empty", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge({ hasToken: false, doc: null }),
      now: () => 2000,
    });
    const { container } = renderLogin(adapter);
    const input = (await waitFor(() =>
      container.querySelector("[data-polaris-key-input]"),
    )) as HTMLInputElement;
    const submit = within(container).getByRole("button", {
      name: /activate/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "key" } });
    expect(submit.disabled).toBe(false);
    adapter.dispose();
  });
});

describe("PolarisLogin — theme copy + logo", () => {
  it("renders the themed sign-in title + OIDC label", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge({ hasToken: false, doc: null }),
      now: () => 2000,
    });
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        adapter={adapter}
        theme={{
          copy: { signInTitle: "Welcome back", oidcButtonLabel: "Use SSO" },
        }}
      >
        <PolarisLogin />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(container.textContent).toContain("Welcome back"),
    );
    expect(container.querySelector("[data-polaris-oidc]")?.textContent).toBe(
      "Use SSO",
    );
    adapter.dispose();
  });

  it("an instance logo prop renders above the card", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge({ hasToken: false, doc: null }),
      now: () => 2000,
    });
    const { container } = renderLogin(adapter, {
      logo: <span data-testid="brand-logo">LOGO</span>,
    });
    await waitFor(() =>
      expect(within(container).getByTestId("brand-logo")).toBeTruthy(),
    );
    adapter.dispose();
  });
});
