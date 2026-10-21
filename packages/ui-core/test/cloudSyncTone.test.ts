// @pkey-feature ui.settings ui.activate
//
// CloudSyncStatus has no ui-matrix family, so its rules are pinned here (bug package H2, B-127 and
// B-128 of the v0.9.15 ledger): Review shows only when the host handles it, a signed-out sync
// error says so in a neutral tone, and a refused key is a neutral callout unless the key itself
// is wrong (UI-KITS DL6, DL7).

import { describe, expect, it } from "vitest";

import { viewOf, type UiInput } from "../src/index.js";

const base: UiInput = {
  services: ["license", "sync"],
  presentation: { name: "Tidewater Studio", icon: true },
};

describe("CloudSyncStatus", () => {
  it("offers Review for a conflict only when the host handles it", () => {
    const without = viewOf("CloudSyncStatus", {
      ...base,
      cloudSync: { state: "conflict" },
    });
    expect(without.copy).toEqual(["cloudSync.conflict"]);
    expect(without.decisions.primary).toBeNull();
    const handled = viewOf("CloudSyncStatus", {
      ...base,
      cloudSync: { state: "conflict", canReview: true },
    });
    expect(handled.copy).toEqual(["cloudSync.conflict", "common.review"]);
    expect(handled.decisions.primary).toBe("common.review");
  });

  it("says a signed-out sync error once, with Sign in to sync, in a neutral tone", () => {
    const v = viewOf("CloudSyncStatus", {
      ...base,
      cloudSync: { state: "error", signedIn: false },
    });
    expect([...v.copy].sort()).toEqual([
      "cloudSync.signIn",
      "cloudSync.signedOut",
    ]);
    expect(v.decisions.primary).toBe("cloudSync.signIn");
    expect(v.decisions.tone).toBe("neutral");
  });

  it("keeps the error line, in danger, for a signed-in failure", () => {
    const v = viewOf("CloudSyncStatus", {
      ...base,
      cloudSync: { state: "error", signedIn: true },
    });
    expect(v.copy).toEqual(["cloudSync.error"]);
    expect(v.decisions.tone).toBe("danger");
    expect(v.decisions.primary).toBeNull();
  });
});

describe("Activate's refusal tone", () => {
  const key = "pkey_tidewater_AbCdEfGhIjKlMnOpQrStUv";
  const tone = (result: string) =>
    viewOf("Activate", {
      ...base,
      keyField: { text: key, submitted: true },
      activation: { result },
    }).decisions.tone;
  it("is danger for a key the service does not know and for a failed check", () => {
    expect(tone("unauthorized")).toBe("danger");
    expect(tone("error")).toBe("danger");
  });
  it("is a neutral callout for a refusal of a well-formed key", () => {
    for (const r of ["license-disabled", "license-expired", "key-entry-limit"])
      expect(tone(r)).toBe("neutral");
  });
});
