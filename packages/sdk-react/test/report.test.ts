// Device telemetry from React (P1b-07, PARITY §5.4 `devices.report`).
//
// @pkey-feature devices.report
//
// Desktop reaches the host's Node client through `invoke("devices", "report")`; the request it
// makes there is the telemetry-report transcript, replayed by the Node runner. A browser holds a
// cookie session and no device bearer, so its `report()` throws `report-unsupported` — the web
// `runtime` N/A the parity registry allows — rather than skipping the call silently.

import { describe, expect, it } from "vitest";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  makeFakeBridge,
  makeFakeFetch,
  NOW_SEC,
  okBridgeState,
} from "./fixtures.js";

describe("report()", () => {
  it(`desktop: reaches the bridge's invoke("devices", "report")`, async () => {
    const calls: [string, string, unknown][] = [];
    const adapter = desktopAdapter({
      bridge: {
        ...makeFakeBridge(okBridgeState()),
        async invoke(service: string, method: string, args?: unknown) {
          calls.push([service, method, args]);
          return true;
        },
      },
      now: () => NOW_SEC,
    });
    await expect(adapter.report()).resolves.toBe(true);
    expect(calls).toEqual([["devices", "report", undefined]]);
    adapter.dispose();
  });

  it("desktop: a host without invoke reports telemetry unsupported", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
      now: () => NOW_SEC,
    });
    await expect(adapter.report()).rejects.toMatchObject({
      code: "report-unsupported",
    });
    adapter.dispose();
  });

  it("browser: the typed N/A, not a silent no-op", async () => {
    let requests = 0;
    const inner = makeFakeFetch(null);
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/devices/report")) requests += 1;
        return inner(input, init);
      }) as typeof fetch,
      now: () => NOW_SEC,
      offlineStore: null,
    });
    await expect(adapter.report()).rejects.toMatchObject({
      code: "report-unsupported",
    });
    expect(requests).toBe(0);
  });
});
