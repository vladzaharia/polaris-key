// `detectOutlet`'s edges the matrix rows do not reach (plans/P3-01.md §2.9): the stamp adapter,
// malformed signal values, and identities the stamp does not declare. The rows themselves run
// in `conformance/runners/node/corpusV2.test.ts`.

import { describe, expect, it } from "vitest";
import {
  UNKNOWN_DETECTION,
  WEB_DETECTION_STAMP,
  detectOutlet,
  detectionStamp,
} from "../src/outlet.js";

const IDS = { steamAppId: "3166810", snapName: "diceroll" };

describe("detectionStamp", () => {
  it("reads the kind as resolveUpdateOutlet does: outletKind, else outlet; a non-kind is no stamp", () => {
    expect(
      detectionStamp({ outlet: "steam-beta", outletKind: "steam" }),
    ).toEqual({ outletKind: "steam", subkind: null, outletIds: {} });
    expect(detectionStamp({ outlet: "itch" })).toEqual({
      outletKind: "itch",
      subkind: null,
      outletIds: {},
    });
    expect(detectionStamp({ outlet: "epic-store", outletKind: "epic" })).toBe(
      null,
    );
    expect(detectionStamp({ outlet: "itch-beta" })).toBe(null);
    expect(detectionStamp(null)).toBe(null);
    expect(detectionStamp("direct")).toBe(null);
  });
  it("keeps a valid subkind and only string identities", () => {
    expect(
      detectionStamp({
        outlet: "direct",
        outletSubkind: "flatpak",
        outletIds: { flatpakId: "gg.vlad.Diceroll", steamAppId: 3166810 },
      }),
    ).toEqual({
      outletKind: "direct",
      subkind: "flatpak",
      outletIds: { flatpakId: "gg.vlad.Diceroll" },
    });
    expect(
      detectionStamp({ outlet: "direct", outletSubkind: "brew" })?.subkind,
    ).toBe(null);
  });
  it("the web runtime's synthesised stamp is web", () => {
    expect(WEB_DETECTION_STAMP.outletKind).toBe("web");
  });
});

describe("detectOutlet edges", () => {
  const steam = {
    outletKind: "direct" as const,
    subkind: null,
    outletIds: IDS,
  };

  it("an identity the stamp does not declare never matches", () => {
    const noIds = {
      outletKind: "direct" as const,
      subkind: null,
      outletIds: {},
    };
    expect(
      detectOutlet({
        stamp: noIds,
        signals: { "steam.libraryManifest": undefined },
      }),
    ).toEqual({
      kind: "direct",
      confidence: "stamp",
      source: "stamp",
      subkind: null,
    });
    expect(
      detectOutlet({
        stamp: noIds,
        signals: {
          "windows.packageIdentity": undefined,
          "windows.signatureKind": "Store",
        },
      }).kind,
    ).toBe("direct");
  });
  it("malformed values are no evidence and never throw", () => {
    for (const signals of [
      { "linux.snapEnv": null },
      { "linux.snapEnv": "diceroll" },
      { "steam.appIdEnv": [3166810] },
      { "android.installSource": null },
      { "android.installSource": { installer: 5, initiator: 5 } },
      { "linux.appImageEnv": { appDir: 1, exePath: "/x" } },
      { "node.packageManager": { manager: "yarn", packageMatch: true } },
      { "ios.appDistributor": 7 },
      { "unknown.signal": true },
    ])
      expect(detectOutlet({ stamp: steam, signals }).kind).toBe("direct");
    expect(detectOutlet({ stamp: null, signals: null })).toEqual(
      UNKNOWN_DETECTION,
    );
    expect(
      detectOutlet({ stamp: { outletKind: "epic" } as never, signals: {} }),
    ).toEqual(UNKNOWN_DETECTION);
  });
  it("a fresh unknown each time (the frozen constant is never handed out)", () => {
    const a = detectOutlet({});
    expect(a).toEqual(UNKNOWN_DETECTION);
    expect(a).not.toBe(UNKNOWN_DETECTION);
  });
});
