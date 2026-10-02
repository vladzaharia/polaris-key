import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import {
  useEntitlement,
  useLicense,
  useManagedConfig,
  usePolarisAuth,
  usePolarisKey,
} from "../src/react/hooks.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { PolarisAdapter } from "../src/core/index.js";
import {
  makeDoc,
  makeFakeBridge,
  makeFakeFetch,
  NOW_SEC,
  okBridgeState,
} from "./fixtures.js";

afterEach(cleanup);

// A probe component that flattens every hook into stable text nodes so we can compare the
// two transports' rendered output character-for-character.
function Probe(): JSX.Element {
  const pk = usePolarisKey();
  const license = useLicense();
  const cfg = useManagedConfig();
  const auth = usePolarisAuth();
  const vpn = useEntitlement("polarisVpn");
  const beta = useEntitlement("beta");
  return (
    <div>
      <span data-testid="status">{pk.status}</span>
      <span data-testid="usable">{String(pk.usable)}</span>
      <span data-testid="license-status">{license.status}</span>
      <span data-testid="profile">{auth.profile?.email ?? "none"}</span>
      <span data-testid="theme-mode">{cfg.get("theme.mode", "light")}</span>
      <span data-testid="vpn">{String(vpn)}</span>
      <span data-testid="beta">{String(beta)}</span>
      <span data-testid="secret">
        {pk.supports("config.secret").supported ? "available" : "unsupported"}
      </span>
      <span data-testid="supports-oidc">{String(auth.supportsOidcLogin)}</span>
      <span data-testid="supports-key">{String(auth.supportsKeyEntry)}</span>
    </div>
  );
}

async function renderWith(
  adapter: PolarisAdapter,
): Promise<Record<string, string>> {
  // Each render gets its own container + is cleaned up first, so cross-render DOM never
  // leaks into the queries (both probes would otherwise resolve to "ok").
  cleanup();
  const { container } = render(
    <PolarisKeyProvider productSlug="acme" adapter={adapter}>
      <Probe />
    </PolarisKeyProvider>,
  );
  const q = within(container);
  // Wait for the first async snapshot to resolve out of "loading" (status starts blank/needs-activation).
  await waitFor(() => expect(q.getByTestId("status").textContent).toBe("ok"));
  const ids = [
    "status",
    "usable",
    "license-status",
    "profile",
    "theme-mode",
    "vpn",
    "beta",
    "supports-oidc",
    "supports-key",
  ];
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = q.getByTestId(id).textContent ?? "";
  return out;
}

describe("mode parity", () => {
  it("desktop and browser adapters produce identical hook outputs from one fixture", async () => {
    const doc = makeDoc();

    const desktop = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState({ doc })),
      now: () => NOW_SEC,
    });
    const desktopOut = await renderWith(desktop);

    const browser = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(doc),
      now: () => NOW_SEC,
    });
    const browserOut = await renderWith(browser);

    expect(desktopOut).toEqual(browserOut);

    // Sanity on the shared values.
    const desktopShared = desktopOut;
    expect(desktopShared.status).toBe("ok");
    expect(desktopShared.usable).toBe("true");
    expect(desktopShared["theme-mode"]).toBe("dark");
    expect(desktopShared.vpn).toBe("true");
    expect(desktopShared.beta).toBe("false");
    expect(desktopShared.profile).toBe("ada@acme.test");
    expect(desktopShared["supports-key"]).toBe("true");

    desktop.dispose();
    browser.dispose();
  });

  it("browser submitKey activates through the cookie-session exchange", async () => {
    const browser = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc()),
      now: () => NOW_SEC,
    });
    await expect(browser.submitKey("anything")).resolves.toBeUndefined();
    expect(browser.snapshot().status).toBe("ok");
    browser.dispose();
  });

  // @pkey-feature core.caps
  it("browser never exposes secrets", async () => {
    const browser = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc()),
      now: () => NOW_SEC,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(() => browser.getSecret("api.token")).toThrow(
      expect.objectContaining({ code: "unsupported", reason: "runtime" }),
    );
    browser.dispose();
  });
});
