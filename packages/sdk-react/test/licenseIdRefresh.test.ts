// @pkey-feature core.sync license.entitlements
// LX-17 (S-19 §7.5, §10.1 risk 1, decision 10): does the React/web SDK tolerate a `licenseId`
// that changes on a PLAIN REFRESH — no key entry, no sign-in, the same session — the way
// `licensing.reanchor: onRefresh` would deliver it?
//
// The browser adapter's three audit surfaces:
//   cache       none to go stale: the cookie session is online-only and the snapshot is
//               re-projected from each session document (`projectState` takes no prior state);
//               an imported offline bundle is superseded by any session (§7);
//   telemetry   `devices.report` is the typed web N/A (`report-unsupported`), so there is no
//               report to carry a stale licence; the current device carries the new id;
//   activation  the session stays the activation (`"token"`), and the gate stays usable.
//
// The desktop adapter projects the Node SDK's sync state, so its behaviour is the Node test's
// (`packages/sdk-node/test/licenseIdRefresh.test.ts`).
//
// Audit result for React / web: PASS.

import { describe, expect, it } from "vitest";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import {
  discoveryBody,
  fuse,
  makeConfig,
  makeDoc,
  NOW_SEC,
  services,
} from "./fixtures.js";

describe("LX-17: a licenseId change on a plain refresh (browser adapter)", () => {
  it("re-projects the new licence, keeps the session activation, and reports the new id", async () => {
    let doc = makeDoc();
    const paths: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      if (url.includes("/.well-known/polaris.json"))
        return new Response(discoveryBody(services()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/identity/session"))
        return Response.json({
          authenticated: true,
          doc: fuse(doc, makeConfig()),
          csrfToken: "c",
        });
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl,
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
    paths.length = 0;
    await adapter.refresh();

    const s = adapter.snapshot();
    // cache: the snapshot is the new licence's
    expect(s.licenseId).toBe("lic-2");
    expect(adapter.isEntitled("beta")).toBe(true);
    expect(s.highWaterMark).toBe(1500);
    // activation: the same session, no key entry, still ok
    expect(paths.some((p) => p.endsWith("/identity/session/license"))).toBe(
      false,
    );
    expect(s.activation).toBe("token");
    expect(s.status).toBe("ok");
    // telemetry: the web N/A stays typed; the current device carries the new id
    await expect(adapter.report()).rejects.toMatchObject({
      code: "report-unsupported",
    });
    expect(adapter.currentDevice()).toMatchObject({
      current: true,
      licenseId: "lic-2",
    });
    adapter.dispose();
  });
});
