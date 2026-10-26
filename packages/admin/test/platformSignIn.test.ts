// I-42.2: the Platform sign-in card's pure parts: the outlet bundle ids read from the channels row
// and the one status line per kind.

import { describe, expect, it } from "vitest";
import {
  outletBundleIds,
  platformSignInStatus,
} from "../src/console/sections/identity/components/PlatformSignIn.js";

const WEB = "1234-web.apps.googleusercontent.com";

describe("outletBundleIds", () => {
  it("takes the App Store and TestFlight bundle ids from a list or a keyed object", () => {
    const list = [
      { id: "a", kind: "app-store", identity: { bundleId: "com.x" } },
      { id: "b", kind: "testflight", identity: { bundleId: "com.x.beta" } },
      { id: "c", kind: "play", identity: { bundleId: "com.play" } },
    ];
    expect(outletBundleIds(list)).toEqual(["com.x", "com.x.beta"]);
    expect(
      outletBundleIds({ "app-store": { identity: { bundleId: "com.x" } } }),
    ).toEqual(["com.x"]);
    expect(outletBundleIds(null)).toEqual([]);
  });
});

describe("platformSignInStatus", () => {
  const at = (v: Record<string, unknown>) => (k: string) => v[k];
  it("says what the values in force make work", () => {
    expect(platformSignInStatus(at({}), [])).toEqual({
      google: "Not set up",
      apple: "Not set up",
    });
    expect(
      platformSignInStatus(
        at({
          "identity.platformSignIn.google.serverClientId": WEB,
          "identity.platformSignIn.apple.teamId": "ABCDE12345",
        }),
        ["com.x"],
      ),
    ).toEqual({ google: "Ready on the web", apple: "Ready" });
  });
});
