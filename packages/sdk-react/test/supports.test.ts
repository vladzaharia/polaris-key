// @pkey-feature core.caps
// `supports(feature)` on both React adapters (P1b-10, PARITY §2.2). The table is generated from
// packages/sdk-react/parity.json; the browser adapter evaluates it as runtime `web`, the desktop
// adapter as `desktop-bridge`, and both follow their current capability map for `product`.

import { describe, expect, it } from "vitest";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  CAPABILITIES,
  Feature,
  FEATURE_VALUES,
  UnsupportedReason,
} from "../src/constants.generated.js";
import { PolarisError, UnsupportedError } from "../src/index.js";
import {
  makeDoc,
  makeFakeBridge,
  makeFakeFetch,
  NOW_SEC,
  okBridgeState,
  services,
} from "./fixtures.js";
import type { PolarisAdapter } from "../src/core/index.js";

async function ready(adapter: PolarisAdapter): Promise<void> {
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++)
    await new Promise((r) => setTimeout(r, 0));
}

function browser(capabilities = services("license", "config", "update")) {
  return browserAdapter({
    auth: "cookie",
    productSlug: "acme",
    fetchImpl: makeFakeFetch(makeDoc(), { capabilities }),
    now: () => NOW_SEC,
  });
}

describe("supports() — the browser adapter (runtime web)", () => {
  it("config.secret is a runtime N/A", async () => {
    const a = browser();
    await ready(a);
    expect(a.supports(Feature.configSecret)).toMatchObject({
      supported: false,
      feature: "config.secret",
      reason: UnsupportedReason.runtime,
    });
    a.dispose();
  });

  it("getSecret throws the typed Unsupported, not undefined or null", async () => {
    const a = browser();
    await ready(a);
    let thrown: unknown;
    try {
      a.getSecret("api.token");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnsupportedError);
    expect(thrown).toBeInstanceOf(PolarisError);
    const e = thrown as UnsupportedError;
    expect(e.code).toBe("unsupported");
    expect(e.unsupported).toEqual({
      supported: false,
      feature: "config.secret",
      reason: "runtime",
      detail: "Secrets are never delivered to a browser session.",
    });
    a.dispose();
  });

  it("every web N/A of the manifest is Unsupported with its reason", async () => {
    const a = browser();
    await ready(a);
    for (const id of FEATURE_VALUES) {
      const na = CAPABILITIES[id].na.find((n) => n.runtime === "web");
      if (!na) continue;
      expect(a.supports(id), id).toMatchObject({
        supported: false,
        reason: na.reason,
      });
    }
    a.dispose();
  });

  it("device management and telemetry refuse with UnsupportedError, keeping their codes", async () => {
    const a = browser();
    await ready(a);
    await expect(a.listDevices()).rejects.toMatchObject({
      code: "device-management-unsupported",
      feature: "devices.manage",
      reason: "runtime",
    });
    await expect(a.renameDevice("dev-2", "x")).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    await expect(a.report()).rejects.toMatchObject({
      code: "report-unsupported",
      feature: "devices.report",
      reason: "runtime",
    });
    a.dispose();
  });

  it("a service discovery reports off is product; one it reports on is Supported", async () => {
    const off = browser(services("license", "config"));
    await ready(off);
    expect(off.supports(Feature.updateDecide)).toEqual({
      supported: false,
      feature: "update.decide",
      reason: "product",
      detail: "the product does not run the update service",
    });
    off.dispose();

    const on = browser(services("license", "config", "update"));
    await ready(on);
    expect(on.supports(Feature.updateDecide).supported).toBe(true);
    on.dispose();
  });

  it("a planned feature or an unknown id is version", async () => {
    const a = browser();
    await ready(a);
    expect(a.supports(Feature.coreLocal)).toMatchObject({ reason: "version" });
    expect(a.supports("future.feature")).toMatchObject({ reason: "version" });
    a.dispose();
  });

  it("caps() is exactly the Supported ids, in registry order", async () => {
    const a = browser();
    await ready(a);
    expect(a.caps()).toEqual(
      FEATURE_VALUES.filter((id) => a.supports(id).supported),
    );
    expect(a.caps()).toContain("license.gate");
    expect(a.caps()).not.toContain("config.secret");
    a.dispose();
  });
});

describe("supports() — the desktop adapter (runtime desktop-bridge)", () => {
  it("config.secret is a runtime N/A and getSecret throws it", async () => {
    const a = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
      now: () => NOW_SEC,
    });
    await ready(a);
    expect(a.supports(Feature.configSecret)).toMatchObject({
      reason: "runtime",
    });
    expect(() => a.getSecret("api.token")).toThrow(UnsupportedError);
    a.dispose();
  });

  it("devices.manage and devices.report are web-only N/As, so the bridge supports them", async () => {
    const a = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
      now: () => NOW_SEC,
    });
    await ready(a);
    expect(a.supports(Feature.devicesManage).supported).toBe(true);
    expect(a.supports(Feature.devicesReport).supported).toBe(true);
    a.dispose();
  });

  it("product follows the capability map the host reports", async () => {
    const a = desktopAdapter({
      bridge: makeFakeBridge(
        okBridgeState({ capabilities: services("license", "config") }),
      ),
      now: () => NOW_SEC,
    });
    await ready(a);
    expect(a.supports(Feature.updateCheck)).toMatchObject({
      reason: "product",
    });
    a.dispose();
  });
});
