/**
 * The CORS row flag against the list it replaced (P0-25b, security-relevant).
 *
 * `CORS_SERVICE_PATHS` was a hand list in `core/cors.ts`; coverage is now a `cors: true` flag on
 * the service route rows (and a `cors` field on the core rows). Nothing may become
 * browser-readable, or stop being so, by the move. This test holds the flagged rows to the old
 * list and the old core kinds, verbatim (`publicRouteOracle.test.ts` pins the per-route answers).
 * A change here is a change to what a web page can read: it needs the same review as one to
 * `web.origins`.
 */

import { describe, expect, it } from "vitest";
import {
  CORE_ROUTES,
  CORS_CORE_KINDS,
  CORS_SERVICE_PATHS,
} from "../../src/publicRoutes.js";
import { SERVICES } from "../../src/mount.js";
import { serviceRoutes } from "../../src/core/http/routes.js";
import { matchRoute } from "../../src/router.js";

const OLD_CORS_SERVICE_PATHS = [
  "license/activate",
  "license/enroll",
  "license/token",
  "license/deauthorize",
  "license/document",
  "config/document",
  "config/schema",
  "config/mint/{mintId}/token",
  "release/changelog",
  // P3-03: a CI-signed release record, and (below) the signed channel feed — what a browser SDK
  // fetches and verifies to decide an update.
  "release/records/{sha256}",
  // P2b-04: all byte delivery is Distribution's (P2-05's byte routes and the legacy download and
  // installer, moved). Their `/release/…` and `/<p>/install.sh` spellings are router aliases
  // that resolve to these same routes, so they are covered exactly when these are. (On the bytes
  // host CORS is applied by its own dispatcher.)
  "distribution/install.sh",
  "distribution/dl/{version}/{asset}",
  "distribution/builds/{selector}/{buildId}",
  "distribution/files/{releaseId}/{name}",
  "distribution/blobs/sha256/{sha256}",
  // P4-18: a pack's decoded container payload (Compression Dictionary Transport), fetched by a
  // page cross-origin under the product's allowlist.
  "distribution/packs/{pack}/{variant}/payload/{sha256}",
  // P2b-05: the public storefront feeds — web tools (source browsers) read them; native clients
  // ignore CORS. The F-Droid relay's one-segment files (`entry.jar`, `index-v2.json`) are
  // covered; the CI route `distribution/feeds/fdroid/{channel}` is not.
  "distribution/altstore/{channel}/source.json",
  "distribution/altstore-pal/{channel}/source.json",
  "distribution/obtainium/{channel}.json",
  "distribution/fdroid/{channel}/repo/{path}",
  "distribution/scoop/{channel}.json",
  "distribution/flathub/{channel}.json",
  // P2b-06: the download page's model, for SDK "get it here" prompts and web pages. The page
  // itself (`distribution/download`, `/<p>`) is HTML on the bytes host and never answers CORS.
  "distribution/download.json",
  // SP-16: the commerce bridge (P6-01) for a bearer-mode page. Both take the device bearer
  // (never ambient), so a listed origin reaches only what that page's own device token already
  // can (THREAT-MODEL, the commerce bridge's browser-pages note). The store hooks beside them stay uncovered.
  "commerce/binding",
  "commerce/claim",
  "update/appcast.xml",
  "update/{channel}/appcast.xml",
  "update/{channel}/feed.jws",
  "update/version",
  "identity/auth/device/start",
  "identity/auth/device/poll",
  // I-08: the token endpoint takes a form body from a listed page, never with credentials: the
  // code and the PKCE verifier are the only proof, and the answer is a device token the page holds.
  "identity/token",
  // I-08b: the pending sign-in grant's four routes, called by the same page that redeemed the code.
  // The grant in the body and the device id are the proof; no ambient credential exists to ride on.
  "identity/choice/licenses",
  "identity/choice/devices",
  "identity/choice/complete",
  "identity/choice/cancel",
  // I-13.2: the native exchange's nonce. The keys in the body are bound, not trusted, and no ambient
  // credential exists to ride on; a web app's automatic sign-in asks for it from a listed page.
  "identity/nonce",
  // I-43.2: the account-link offer. Device bearer only (never ambient), so a listed origin reaches
  // what its own device token already can.
  "identity/link",
  // I-09: the account on the device wire. Each takes the device bearer (never ambient), so a
  // listed origin reaches only what that page's own device token already can.
  "identity/attach",
  "identity/subject",
  "identity/signout",
  // U-05.12, U-05.13: the Cloud Sync pull and push (device bearer, never ambient).
  "sync",
  "sync/ops",
  // U-10.5: the Cloud Sync file routes, as the push: the device bearer, never ambient, so a listed
  // origin reaches only what that page's own device token already can. They answer 404 while the
  // operator's launch gate launch.syncFiles is off.
  "sync/files/{collection}/{id}/begin",
  "sync/files/{collection}/{id}/upload/{uploadId}",
  // CC-06.1: the Cloud Connect roster and the linked-devices list (device bearer, never ambient).
  "connect/identity",
  "connect/relay/ticket",
  "connect/devices",
];

const OLD_CORS_CORE_KINDS = [
  "discovery",
  "jwks",
  "trustManifest",
  "devices",
  "report",
  "register",
  // U-36.2: the key ring (device bearer, never ambient; a listed page reaches only its own token's ring).
  "keyring",
];

describe("the CORS row flags equal the list they replaced", () => {
  it("flags exactly the old service paths", () => {
    expect([...CORS_SERVICE_PATHS].sort()).toEqual(
      [...OLD_CORS_SERVICE_PATHS].sort(),
    );
  });

  it("flags exactly the old core kinds; attestation and the asset push stay first-party", () => {
    expect([...CORS_CORE_KINDS].sort()).toEqual(
      [...OLD_CORS_CORE_KINDS].sort(),
    );
    for (const kind of ["attestChallenge", "attest", "assetsPush"])
      expect(CORE_ROUTES.find((r) => r.kind === kind)?.cors, kind).toBe(false);
  });

  it("never flags a CI, signature or cookie route", () => {
    for (const d of SERVICES.values())
      for (const r of d.surface)
        if (r.cors)
          expect(r.path).not.toMatch(
            /\/(rollouts|publish|channels|yank|hooks|prune)\b|\/auth\/(start|callback|logout|choose)/,
          );
  });
});

describe("serviceRoutes refuses a CORS flag on a credentialed route", () => {
  const row = (kind: "ci" | "session" | "signature" | "device" | "none") => ({
    path: "x",
    methods: ["GET"] as const,
    cors: true as const,
    auth:
      kind === "ci"
        ? ({ kind, scope: "release:write" } as never)
        : ({ kind } as never),
    handler: async () => new Response(),
  });
  it.each(["ci", "session", "signature"] as const)("%s", (kind) => {
    expect(() => serviceRoutes("license", [row(kind) as never])).toThrow(
      /CORS-flagged/,
    );
  });
  it.each(["device", "none"] as const)("%s is allowed", (kind) => {
    expect(() => serviceRoutes("license", [row(kind) as never])).not.toThrow();
  });
});

describe("CORE_ROUTES", () => {
  it("has one row per kind and documents every one", () => {
    const kinds = CORE_ROUTES.map((r) => r.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const r of CORE_ROUTES)
      expect(r.surface.length, r.kind).toBeGreaterThan(0);
  });
  it("routes each surface path to its own kind", () => {
    for (const r of CORE_ROUTES)
      for (const s of r.surface) {
        const path = s.path
          .replace("{product}", "djdl")
          .replace("{deviceId}", "dev1");
        expect(matchRoute(path).kind, `${r.kind} ${s.path}`).toBe(r.kind);
      }
  });
});
