/**
 * The portal API's route table (P0-25b-2): which row takes which `/api` path, and the gates every
 * row carries. `portalApiOracle.test.ts` proves the answers did not change; this reads the table
 * itself, so a gate cannot move without this file saying so.
 */

import { describe, expect, it } from "vitest";
import { PORTAL_API_ROUTES } from "../../../src/services/identity/portal/api.js";
import { bestRow } from "../../../src/core/http/routes.js";

function rowFor(path: string) {
  const segments = path.split("/").filter(Boolean);
  return bestRow(PORTAL_API_ROUTES, segments, (r) =>
    r.accept ? r.accept(segments) : true,
  )!.row;
}

describe("PORTAL_API_ROUTES: path to row", () => {
  const cases: [string, string][] = [
    ["/", "**"],
    ["/nope", "**"],
    ["/capabilities", "capabilities/**"],
    ["/capabilities/x/y", "capabilities/**"],
    ["/magic/start", "magic/start/**"],
    ["/magic/start/x", "magic/start/**"],
    ["/magic", "**"],
    ["/magic/x", "**"],
    ["/signin", "signin/**"],
    ["/signin/email/start", "signin/**"],
    ["/signin/flow", "signin/**"],
    ["/signin/requests", "**"],
    ["/signin/requests/rq", "signin/requests/:request"],
    ["/signin/requests/rq/consent", "signin/requests/:request/consent"],
    ["/signin/requests/rq/consent/x", "**"],
    ["/signin/requests/rq/licenses", "signin/requests/:request/licenses"],
    [
      "/signin/requests/rq/licenses/l/devices",
      "signin/requests/:request/licenses/:license/devices",
    ],
    ["/signin/requests/rq/licenses/l", "**"],
    ["/signin/requests/rq/continue", "signin/requests/:request/continue"],
    ["/signin/requests/rq/cancel", "signin/requests/:request/cancel"],
    ["/signin/requests/rq/other", "**"],
    ["/key/preview", "key/preview"],
    ["/key", "**"],
    ["/key/preview/x", "**"],
    ["/device-login", "**"],
    ["/device-login/start", "device-login/start"],
    ["/device-login/lookup", "device-login/lookup"],
    ["/device-login/approve", "device-login/approve"],
    ["/device-login/ABCD-EFGH", "device-login/:code"],
    ["/device-login/lookup/x", "**"],
    ["/me", "me"],
    ["/me/x", "**"],
    ["/me/export", "me/export"],
    ["/me/export/x", "**"],
    ["/me/deletion", "**"],
    ["/me/deletion/cancel", "me/deletion/cancel"],
    ["/me/passkeys", "me/passkeys/**"],
    ["/me/passkeys/a/b", "me/passkeys/**"],
    ["/me/methods", "me/methods/**"],
    ["/me/link/start", "me/link/**"],
    ["/me/tokens", "me/tokens/**"],
    ["/me/profile", "me/profile/**"],
    ["/me/profile/picture", "me/profile/**"],
    ["/sessions", "sessions/**"],
    ["/sessions/sign-out-everywhere", "sessions/**"],
    ["/licenses", "licenses/**"],
    ["/licenses/p", "licenses/**"],
    ["/licenses/p/l", "licenses/:product/:license"],
    ["/licenses/p/l/other", "licenses/**"],
    ["/licenses/p/l/keys", "licenses/:product/:license/keys"],
    ["/licenses/p/l/keys/x", "licenses/**"],
    ["/licenses/p/l/devices", "licenses/**"],
    [
      "/licenses/p/l/devices/d",
      "licenses/:product/:license/devices/:device/**",
    ],
    [
      "/licenses/p/l/devices/d/x",
      "licenses/:product/:license/devices/:device/**",
    ],
    [
      "/licenses/p/l/registry-tokens",
      "licenses/:product/:license/registry-tokens",
    ],
    [
      "/licenses/p/l/registry-tokens/t",
      "licenses/:product/:license/registry-tokens/:token",
    ],
    ["/licenses/p/l/registry-tokens/t/x", "licenses/**"],
    ["/claim", "**"],
    ["/claim/license-key", "claim/license-key/**"],
    ["/activate", "**"],
    ["/activate/preview", "activate/preview"],
    ["/releases", "releases/**"],
    ["/releases/p/x", "releases/**"],
    ["/library", "library"],
    ["/library/p", "library/:product"],
    ["/library/p/x", "**"],
    ["/discover", "discover"],
    ["/discover/p", "discover/:product"],
    ["/discover/p/claim", "discover/:product/claim"],
    ["/discover/p/x", "**"],
    ["/products", "**"],
    ["/products/p", "products/:product"],
    ["/products/p/downloads", "products/:product/downloads"],
    ["/products/p/email-download", "products/:product/email-download"],
    ["/products/p/export", "products/:product/export"],
    ["/products/p/export/x", "**"],
    ["/products/p/data", "products/:product/data"],
    ["/products/p/support-code", "products/:product/support-code"],
    ["/products/p/nope", "**"],
  ];
  it.each(cases)("%s is taken by %s", (path, row) => {
    expect(rowFor(path).path).toBe(row);
  });

  it("has no duplicate path", () => {
    const paths = PORTAL_API_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("PORTAL_API_ROUTES: the gates", () => {
  /** `auth csrf sweep` per row, as a reviewer reads them off the table. */
  function gate(r: (typeof PORTAL_API_ROUTES)[number]): string {
    if (r.auth === "none") return "none";
    const sweep =
      typeof r.sweep === "boolean"
        ? String(r.sweep)
        : `except ${r.sweep.except}`;
    return `session csrf:${r.csrf} sweep:${sweep}`;
  }

  it("is exactly this, row by row", () => {
    const table = Object.fromEntries(
      PORTAL_API_ROUTES.map((r) => [r.path, gate(r)]),
    );
    expect(table).toEqual({
      "capabilities/**": "none",
      "magic/start/**": "none",
      "storefront/:product": "none",
      "signin/requests/:request": "none",
      "signin/**": "none",
      "key/preview": "none",
      "device-login/start": "none",
      "device-login/:code": "none",
      "device-login/lookup": "session csrf:change sweep:false",
      "device-login/approve": "session csrf:change sweep:false",
      me: "session csrf:change sweep:except DELETE",
      "me/deletion/cancel": "session csrf:change sweep:except POST",
      "me/passkeys/**": "session csrf:change sweep:false",
      "me/methods/**": "session csrf:change sweep:false",
      "me/link/**": "session csrf:change sweep:false",
      "me/tokens/**": "session csrf:change sweep:false",
      "me/profile/**": "session csrf:change sweep:true",
      "me/export": "session csrf:always sweep:true",
      "sessions/**": "session csrf:change sweep:true",
      "signin/requests/:request/consent": "session csrf:change sweep:true",
      "signin/requests/:request/licenses": "session csrf:change sweep:true",
      "signin/requests/:request/licenses/:license/devices":
        "session csrf:change sweep:true",
      "signin/requests/:request/continue": "session csrf:change sweep:true",
      "signin/requests/:request/cancel": "session csrf:change sweep:true",
      "licenses/:product/:license/devices/:device/**":
        "session csrf:change sweep:true",
      "licenses/:product/:license/keys": "session csrf:change sweep:true",
      "licenses/:product/:license/registry-tokens":
        "session csrf:change sweep:true",
      "licenses/:product/:license/registry-tokens/:token":
        "session csrf:change sweep:true",
      "licenses/:product/:license": "session csrf:change sweep:true",
      "licenses/**": "session csrf:change sweep:true",
      "claim/license-key/**": "session csrf:change sweep:true",
      "activate/preview": "session csrf:change sweep:true",
      "releases/**": "session csrf:change sweep:true",
      library: "session csrf:change sweep:true",
      "library/:product": "session csrf:change sweep:true",
      discover: "session csrf:change sweep:true",
      "discover/:product": "session csrf:change sweep:true",
      "discover/:product/claim": "session csrf:change sweep:true",
      "products/:product": "session csrf:change sweep:true",
      "products/:product/downloads": "session csrf:change sweep:true",
      "products/:product/email-download": "session csrf:change sweep:true",
      "products/:product/export": "session csrf:always sweep:true",
      "products/:product/data": "session csrf:change sweep:true",
      "products/:product/support-code": "session csrf:change sweep:true",
      "**": "session csrf:change sweep:true",
    });
  });
});
