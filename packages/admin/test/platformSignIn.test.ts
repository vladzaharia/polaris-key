// I-42.2: the Platform sign-in card's pure parts: the outlet bundle ids read from the channels row
// and the one status line per kind.

import { describe, expect, it } from "vitest";
import type { OutletCredentialInfo } from "../src/api.js";
import {
  PLATFORM_SIGN_IN_KEYS,
  credentialStanding,
  outletBundleIds,
  platformSignInStatus,
} from "../src/console/sections/identity/components/PlatformSignIn.js";

const WEB = "1234-web.apps.googleusercontent.com";

describe("the section's rows", () => {
  it("lists the nearby and silent-restore switches after the audiences", () => {
    expect(PLATFORM_SIGN_IN_KEYS.slice(-2)).toEqual([
      "identity.nearby",
      "identity.restore",
    ]);
  });
});

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

describe("credentialStanding", () => {
  const cred = (over: Partial<OutletCredentialInfo>): OutletCredentialInfo => ({
    id: "play-games-server",
    kind: "pgs-server-client",
    outletId: null,
    meta: { serverClientId: WEB },
    status: "active",
    createdAt: 0,
    createdBy: "u",
    rotatedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    lastOkAt: null,
    lastError: null,
    ...over,
  });
  it("is set only for an active credential pinned to the setting", () => {
    expect(credentialStanding([cred({})], false, WEB).state).toBe("set");
    expect(credentialStanding([], false, WEB).state).toBe("missing");
    expect(
      credentialStanding(
        [cred({ meta: { serverClientId: "9-x" } })],
        false,
        WEB,
      ).state,
    ).toBe("mismatch");
    expect(
      credentialStanding([cred({ status: "revoked" })], false, WEB).state,
    ).toBe("failing");
    expect(
      credentialStanding([cred({ lastError: "401" })], false, WEB).state,
    ).toBe("failing");
    expect(credentialStanding(undefined, true, WEB).state).toBe("loading");
    expect(credentialStanding(undefined, false, WEB).state).toBe("unknown");
  });
});

describe("platformSignInStatus", () => {
  const at = (v: Record<string, unknown>) => (k: string) => v[k];
  const labels = (s: ReturnType<typeof platformSignInStatus>) => ({
    google: s.google.label,
    apple: s.apple.label,
    gameCenter: s.gameCenter.label,
    playGames: s.playGames.label,
  });
  it("says what the values in force make work", () => {
    expect(labels(platformSignInStatus(at({}), []))).toEqual({
      google: "Not set up",
      apple: "Not set up",
      gameCenter: "Off",
      playGames: "Not set up",
    });
    const s = platformSignInStatus(
      at({
        "identity.platformSignIn.google.serverClientId": WEB,
        "identity.platformSignIn.apple.teamId": "ABCDE12345",
      }),
      ["com.x"],
    );
    expect(labels(s)).toEqual({
      google: "Ready",
      apple: "Ready",
      gameCenter: "Off",
      playGames: "Not set up",
    });
    expect(s.google.detail).toBe("On the web");
  });

  it("reports Game Center", () => {
    const base = {
      "identity.platformSignIn.apple.teamId": "ABCDE12345",
      "identity.platformSignIn.apple.bundleIds": ["com.x", "com.y"],
      "identity.platformSignIn.gameCenter": true,
    };
    const gc = platformSignInStatus(at(base), ["com.x", "com.z"]).gameCenter;
    expect(gc.label).toBe("Ready");
    expect(gc.detail).toBe("Team ABCDE12345, 3 bundle ids");
    expect(
      platformSignInStatus(
        at({
          "identity.platformSignIn.apple.teamId": "ABCDE12345",
          "identity.platformSignIn.gameCenter": true,
        }),
        [],
      ).gameCenter.label,
    ).toBe("Needs a bundle id");
    expect(
      platformSignInStatus(
        at({ "identity.platformSignIn.gameCenter": true }),
        [],
      ).gameCenter.label,
    ).toBe("Needs the Apple team id");
  });

  it("reports Play Games by the credential's standing, never Ready while unknown", () => {
    const play = {
      "identity.platformSignIn.playGames.applicationId": "123456789012",
      "identity.platformSignIn.playGames.serverClientId": WEB,
    };
    const of = (c: Parameters<typeof platformSignInStatus>[2]) =>
      platformSignInStatus(at(play), [], c).playGames;
    expect(of("missing")).toMatchObject({
      label: "Needs a server credential",
      detail: `for ${WEB}`,
      action: "set",
    });
    expect(of("mismatch")).toMatchObject({ action: "open", tone: "warning" });
    expect(of("failing").label).toBe("Server credential failing");
    expect(of("set")).toMatchObject({ label: "Ready", action: "open" });
    expect(of("unknown").label).toBe("Ids set");
    expect(of("loading").hold).toBe(true);
    expect(platformSignInStatus(at({}), [], "missing").playGames.label).toBe(
      "Not set up",
    );
  });
});
