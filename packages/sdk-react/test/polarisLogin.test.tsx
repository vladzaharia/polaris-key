// @pkey-feature ui.kit
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
import {
  emptyBridgeState,
  makeFakeBridge,
  makeFakeFetch,
  services,
} from "./fixtures.js";

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
  it("renders the OIDC button when supported", async () => {
    const browser = browserAdapter({
      auth: "cookie",
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

  it("hides OIDC when discovery or the bridge disables it", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(
        emptyBridgeState({ capabilities: services("license", "config") }),
      ),
      now: () => 2000,
      expectServices: services(),
    });
    const { container } = renderLogin(adapter);
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-key-input]")).toBeTruthy(),
    );
    expect(container.querySelector("[data-polaris-oidc]")).toBeNull();
    adapter.dispose();
  });

  it("clicking OIDC triggers signInWithOidc on the adapter", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    const beginSpy = vi.spyOn(bridge, "beginSignIn");
    const adapter = desktopAdapter({
      bridge,
      now: () => 2000,
      expectServices: services(),
    });
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
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => 2000,
      expectServices: services(),
    });
    const { container } = renderLogin(adapter);
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-key-input]")).toBeTruthy(),
    );
    adapter.dispose();
  });

  it("browser shows the typed-key card", async () => {
    const browser = browserAdapter({
      auth: "cookie",
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

  it("stacks OIDC sign-in above key activation, divided, in one centred column", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => 2000,
      expectServices: services(),
    });
    const { container } = renderLogin(adapter);
    const oidc = await waitFor(
      () => container.querySelector("[data-polaris-oidc]") as HTMLElement,
    );
    const form = container.querySelector("form") as HTMLFormElement;
    const column = oidc.parentElement?.parentElement as HTMLElement;
    expect(column).toBe(form.parentElement);
    expect(column.style.display).toBe("flex");
    expect(column.style.flexDirection).toBe("column");
    // The sign-in button comes first, then an "or" divider (decorative), then the form.
    const children = [...column.children];
    expect(children.indexOf(oidc.parentElement!)).toBeLessThan(
      children.indexOf(form),
    );
    const divider = children[1] as HTMLElement;
    expect(divider.getAttribute("aria-hidden")).toBe("true");
    expect(divider.textContent).toBe("or");
    // The card is a narrow, centred column.
    const card = container.querySelector("[data-polaris-login]") as HTMLElement;
    expect(card.style.margin).toBe("auto");
    expect(card.style.width).toBe("min(440px, 100%)");
    adapter.dispose();
  });

  it("hideKeyEntry hides the card even on desktop", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => 2000,
      expectServices: services(),
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
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.submitKey = vi.fn(async () => ({ kind: "unauthorized" }) as const);
    const adapter = desktopAdapter({
      bridge,
      now: () => 2000,
      expectServices: services(),
    });
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
      expect(alert.textContent).toMatch(/license key wasn't accepted/i);
    });
    adapter.dispose();
  });

  it.each([
    [
      { kind: "refused", code: "license_disabled", message: "device limit" },
      /license has been disabled/i,
    ],
    [
      { kind: "device-limit", limit: 2, deviceCount: 2 },
      /already on all its devices/i,
    ],
  ] as const)(
    "the alert is the copy catalog's sentence for the typed outcome, never the message text (%j)",
    async (outcome, expected) => {
      const bridge = makeFakeBridge(emptyBridgeState());
      bridge.submitKey = vi.fn(async () => outcome as never);
      const adapter = desktopAdapter({
        bridge,
        now: () => 2000,
        expectServices: services(),
      });
      const { container } = renderLogin(adapter);
      const input = (await waitFor(() =>
        container.querySelector("[data-polaris-key-input]"),
      )) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "PK-1" } });
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);
      await waitFor(() => {
        const alert = within(container).getByRole("alert");
        expect(alert.textContent).toMatch(expected);
        // A refusal whose diagnostic message says "device limit" is not the device limit.
        if (outcome.kind === "refused")
          expect(alert.textContent).not.toMatch(/all its devices/i);
      });
      adapter.dispose();
    },
  );

  it("the submit button is disabled while the key field is empty", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => 2000,
      expectServices: services(),
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
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => 2000,
      expectServices: services(),
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
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => 2000,
      expectServices: services(),
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
