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
      gameCenter: "Off",
      playGames: "Not set up",
    });
    expect(
      platformSignInStatus(
        at({
          "identity.platformSignIn.google.serverClientId": WEB,
          "identity.platformSignIn.apple.teamId": "ABCDE12345",
        }),
        ["com.x"],
      ),
    ).toEqual({
      google: "Ready on the web",
      apple: "Ready",
      gameCenter: "Off",
      playGames: "Not set up",
    });
  });

  it("reports Game Center and Play Games", () => {
    const base = {
      "identity.platformSignIn.apple.teamId": "ABCDE12345",
      "identity.platformSignIn.apple.bundleIds": ["com.x", "com.y"],
      "identity.platformSignIn.gameCenter": true,
    };
    expect(platformSignInStatus(at(base), ["com.x", "com.z"]).gameCenter).toBe(
      "Uses team ABCDE12345 and 3 bundle ids",
    );
    expect(
      platformSignInStatus(
        at({ "identity.platformSignIn.gameCenter": true }),
        [],
      ).gameCenter,
    ).toBe("Needs the Apple team id");
    const play = {
      "identity.platformSignIn.playGames.applicationId": "123456789012",
      "identity.platformSignIn.playGames.serverClientId": WEB,
    };
    expect(platformSignInStatus(at(play), [], "missing").playGames).toBe(
      "Needs the server credential",
    );
    expect(platformSignInStatus(at(play), [], "set").playGames).toBe("Ready");
    expect(platformSignInStatus(at(play), []).playGames).toBe("Ready");
  });
});
