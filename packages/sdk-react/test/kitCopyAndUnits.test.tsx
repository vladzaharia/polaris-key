// @pkey-feature ui.kit core.copy
//
// Small contracts of the fix round (UK-47): the kit's copy defaults are the catalogs' words (a
// string the kit writes itself is a string the catalog lacks), the copy helpers are reachable
// from the package root, `lastVerifiedAt` is epoch seconds everywhere a device carries it, and
// a product with no accent gets an ink primary.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import * as root from "../src/index.js";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { PolarisLogin } from "../src/components/PolarisLogin.js";
import { DeviceManager } from "../src/components/DeviceManager.js";
import { defaultTheme, mergeTheme } from "../src/components/theme.js";
import { currentDeviceFromState } from "../src/core/adapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  NOW_SEC,
  emptyBridgeState,
  makeFakeBridge,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(cleanup);

const CATALOG = (
  JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../brand/kit-copy/en.json",
      ),
      "utf8",
    ),
  ) as { messages: Record<string, { value: string }> }
).messages;

describe("the kit's copy defaults are the catalog's words", () => {
  // theme.copy key → catalog key. These are the hand-off, the status screens and the sign-in
  // card's last hard-coded sentence.
  const KEYS: Record<string, string> = {
    noMethodsLabel: "signin.off.any",
    differentKeyLabel: "signin.key.differentKey",
    handoffTitle: "signin.handoff.title",
    handoffCheck: "signin.handoff.check",
    handoffCodeLabel: "part.code.label",
    handoffUrl: "signin.handoff.url",
    handoffExpires: "signin.handoff.expires",
    handoffOpenLabel: "signin.handoff.openBrowser",
    handoffCopyLabel: "common.copy",
    handoffCopiedLabel: "common.copied",
    handoffCancelLabel: "common.cancel",
    handoffExpiredTitle: "signin.expired.title",
    handoffExpiredBody: "signin.expired.body",
    handoffAgainLabel: "signin.again",
    oidcButtonLabel: "welcome.signIn",
    useKeyLabel: "welcome.useKey",
    retryLabel: "common.tryAgain",
    signOutLabel: "common.signOut",
  };
  for (const [copyKey, catalogKey] of Object.entries(KEYS))
    it(`${copyKey} is ${catalogKey}`, () => {
      expect(CATALOG[catalogKey], catalogKey).toBeTruthy();
      expect(
        (defaultTheme.copy as unknown as Record<string, string>)[copyKey],
      ).toBe(CATALOG[catalogKey]!.value);
    });

  it("the sign-in card with no methods says the catalog's sentence, and an override wins", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(
        emptyBridgeState({ capabilities: services("update") }),
      ),
      now: () => NOW_SEC,
      expectServices: services("update"),
    });
    const { container, rerender } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <PolarisLogin />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(container.textContent).toContain(
        "Sign-in is unavailable. Try again later.",
      ),
    );
    rerender(
      <PolarisKeyProvider
        productSlug="acme"
        adapter={adapter}
        theme={{ copy: { noMethodsLabel: "Nothing to sign in to." } }}
      >
        <PolarisLogin />
      </PolarisKeyProvider>,
    );
    expect(container.textContent).toContain("Nothing to sign in to.");
    adapter.dispose();
  });
});

describe("the copy helpers are exported from the package root", () => {
  it("exports the same functions as ./core", () => {
    for (const name of [
      "activationMessage",
      "activationTitle",
      "copyLocales",
      "copyMessage",
      "copyTitle",
      "describeError",
      "hasCopy",
      "registerCopyLocale",
    ] as const)
      expect(typeof root[name], name).toBe("function");
    expect(root.copyTitle("device_limit")).toBe("Device limit reached");
    expect(root.hasCopy("device_limit")).toBe(true);
    expect(root.activationTitle("unauthorized")).toBeTruthy();
  });
});

describe("lastVerifiedAt is epoch seconds", () => {
  it("a device read from state carries seconds, not the gate's milliseconds", () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState({ lastVerifiedAt: NOW_SEC * 1000 })),
      now: () => NOW_SEC,
    });
    return waitFor(() => expect(adapter.snapshot().phase).toBe("ready")).then(
      () => {
        const device = currentDeviceFromState(adapter.snapshot());
        expect(device?.lastVerifiedAt).toBe(NOW_SEC);
        expect(adapter.currentDevice()?.lastVerifiedAt).toBe(NOW_SEC);
        adapter.dispose();
      },
    );
  });

  it("the device list reads 'last seen' from seconds (not '20,713,544 days')", async () => {
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86_400;
    const bridge = makeFakeBridge(okBridgeState());
    bridge.invoke = (async (_s: string, method: string) =>
      method === "list"
        ? [
            {
              id: "dev-1",
              current: true,
              status: "ok",
              label: "Laptop",
              platform: "macos",
              lastVerifiedAt: twoDaysAgo,
            },
          ]
        : undefined) as never;
    const adapter = desktopAdapter({
      bridge,
      now: () => NOW_SEC,
      expectServices: services(),
    });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <DeviceManager />
      </PolarisKeyProvider>,
    );
    await waitFor(() => expect(container.textContent).toMatch(/last seen/));
    expect(container.textContent).toMatch(/2 days ago/);
    expect(container.textContent).not.toMatch(/\d{1,3}(,\d{3})+ days/);
    adapter.dispose();
  });
});

describe("a product with no accent gets an ink primary", () => {
  it("polaris-key branding resolves the primary to ink, not violet, in both schemes", () => {
    const dark = mergeTheme({ branding: "polaris-key" }, "dark").tokens;
    const light = mergeTheme({ branding: "polaris-key" }, "light").tokens;
    expect([dark.accent, dark.accentText]).toEqual(["#f4f4f5", "#18181b"]);
    expect([light.accent, light.accentText]).toEqual(["#18181b", "#ffffff"]);
  });

  it("a product's own accent still wins over ink", () => {
    const t = mergeTheme(
      { branding: "polaris-key", tokens: { accent: "#0a7d5a" } },
      "light",
    ).tokens;
    expect(t.accent).toBe("#0a7d5a");
  });

  it("the Welcome primary reads 'Sign in' under the brand too", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => NOW_SEC,
      expectServices: services(),
    });
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        adapter={adapter}
        branding="polaris-key"
        theme={{ copy: { productName: "Tidewater" } }}
      >
        <PolarisLogin />
      </PolarisKeyProvider>,
    );
    const btn = await waitFor(() => {
      const el = container.querySelector("[data-polaris-oidc]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(btn.textContent).toBe("Sign in");
    expect(container.textContent).not.toMatch(/Polaris Key/);
    adapter.dispose();
  });
});
