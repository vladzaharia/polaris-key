// @vitest-environment node
// @pkey-feature core.sync license.entitlements
// LX-17 (S-19 §7.5, §10.1 risk 1, decision 10): does the React/web SDK tolerate a `licenseId`
// that changes on a PLAIN REFRESH — no key entry, no sign-in, the same token — the way
// `licensing.reanchor: onRefresh` would deliver it?
//
// The browser adapter's three audit surfaces:
//   cache       none to go stale: the snapshot is re-projected from the verified documents each
//               sync (`projectState` takes no prior state); a token supersedes an imported
//               offline bundle (§7);
//   telemetry   `devices.report` reads the held licence, and the current device carries the
//               new id;
//   activation  the token stays the activation (`"token"`), and the gate stays usable.
//
// The desktop adapter projects the Node SDK's sync state, so its behaviour is the Node test's
// (`packages/sdk-node/test/licenseIdRefresh.test.ts`).
//
// Audit result for React / web: PASS.

import { describe, expect, it, vi } from "vitest";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { fakeWorld, makeDoc, makeFakeFetch, NOW_SEC } from "./fixtures.js";

describe("LX-17: a licenseId change on a plain refresh (browser adapter)", () => {
  it("re-projects the new licence, keeps the session activation, and reports the new id", async () => {
    let doc = makeDoc();
    const fetchImpl = vi.fn(makeFakeFetch(() => doc));
    const adapter = browserAdapter({
      productSlug: "acme",
      ...fakeWorld(() => doc),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
    });
    for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++)
      await new Promise((r) => setTimeout(r, 0));
    expect(adapter.snapshot().licenseId).toBe("lic-1");
    expect(adapter.isEntitled("beta")).toBe(false);

    // The server re-anchors the session's device on another licence.
    doc = makeDoc({
      licenseId: "lic-2",
      issuedAt: 1500,
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: 1500 },
        beta: { state: "enforced", value: true, updatedAt: 1500 },
      },
    });
    fetchImpl.mockClear();
    await adapter.refresh();

    const s = adapter.snapshot();
    // cache: the snapshot is the new licence's
    expect(s.licenseId).toBe("lic-2");
    expect(adapter.isEntitled("beta")).toBe(true);
    expect(s.highWaterMark).toBe(1500);
    // activation: the same token, no key entry, still ok
    expect(
      fetchImpl.mock.calls.some((c) =>
        String(c[0]).includes("/license/activate"),
      ),
    ).toBe(false);
    expect(s.activation).toBe("token");
    expect(s.status).toBe("ok");
    // telemetry: the report carries the new licence; the current device carries the new id
    await expect(adapter.report()).resolves.toBe(true);
    expect(adapter.currentDevice()).toMatchObject({
      current: true,
      licenseId: "lic-2",
    });
    adapter.dispose();
  });
});
