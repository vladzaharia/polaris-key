import { describe, expect, it } from "vitest";
import {
  ACTION_LEVELS,
  confirmFor,
  levelOf,
  type ActionId,
} from "../../src/lib/actions.js";

/** ADMIN.md §5.2's examples column, by level. */
const SPEC: Record<0 | 1 | 2 | 3, ActionId[]> = {
  0: ["attention.dismiss", "preferences.save", "filters.clear"],
  1: [
    "signing.prepare",
    "signing.activate",
    "license.disable",
    "rollout.pause",
    "rollout.resume",
    "channel.unpin",
    "channel.markCritical",
    "channel.clearCritical",
    "channel.setMinSupported",
    "channel.promote",
    "channel.pin",
    "manifest.revert",
    "service.disable",
    "repo.resync",
    "sentry.dismiss",
    "rollout.setPercentage",
    "storeApp.assign",
    "storeApp.release",
    "connector.versionCreate",
    "connector.testflightGroups",
    "connector.cancelSubmission",
    "connector.iapCreate",
    "connector.iapPrice",
    "user.undoRelink",
    "setting.manifestAuthoritative",
  ],
  2: [
    "key.revoke",
    "device.deauthorize",
    "sentry.confirm",
    "release.yank",
    "rollout.halt",
    "rollout.complete",
    "edgeMint.revoke",
    "tier.delete",
    "profile.delete",
    "outletCredential.delete",
    "ciToken.revoke",
    "signing.retire",
    "readiness.override",
    "catalog.publishRemovingKeys",
    "connector.exportCompliance",
    "user.detachLicense",
    "user.relink",
    "setting.breakGlass",
  ],
  3: [
    "product.delete",
    "signing.revoke",
    "signing.breakGlassActivate",
    "kek.reseal",
    "portalAccount.delete",
    "license.delete",
    "connector.releaseVersion",
    "connector.phasedComplete",
    "connector.iapAvailability",
    "connector.submitReview",
    "connector.iapPriceChange",
    "user.deleteData",
  ],
};

describe("destructive-action levels (ADMIN.md §5.2)", () => {
  it("assigns every action in the spec its level", () => {
    for (const [level, actions] of Object.entries(SPEC)) {
      for (const a of actions) expect(levelOf(a), a).toBe(Number(level));
    }
  });

  it("has a level for every action it declares", () => {
    for (const a of Object.keys(ACTION_LEVELS) as ActionId[]) {
      expect([0, 1, 2, 3]).toContain(levelOf(a));
    }
  });

  it("maps levels to confirm intents", () => {
    expect(confirmFor("filters.clear")).toMatchObject({
      intent: "none",
      typedConfirmation: false,
    });
    expect(confirmFor("license.disable")).toMatchObject({
      intent: "caution",
      typedConfirmation: false,
    });
    expect(confirmFor("release.yank")).toMatchObject({
      intent: "danger",
      typedConfirmation: false,
    });
    expect(confirmFor("product.delete")).toMatchObject({
      intent: "danger",
      typedConfirmation: true,
      typed: "slug",
    });
  });

  it("requires typed confirmation for every L3 action, with what to type", () => {
    for (const a of SPEC[3]) {
      const p = confirmFor(a);
      expect(p.typedConfirmation).toBe(true);
      expect(p.typed).toBeTruthy();
    }
    expect(confirmFor("signing.revoke").typed).toBe("kid");
    expect(confirmFor("kek.reseal").typed).toBe("reseal");
    expect(confirmFor("portalAccount.delete").typed).toBe("delete");
    expect(confirmFor("connector.releaseVersion").typed).toBe("appName");
    expect(confirmFor("connector.phasedComplete").typed).toBe("appName");
    expect(confirmFor("connector.iapAvailability").typed).toBe("appName");
  });

  it("visual weight follows severity: pause is not danger, halt is (MTX-10)", () => {
    expect(confirmFor("rollout.pause").intent).toBe("caution");
    expect(confirmFor("rollout.halt").intent).toBe("danger");
  });
});
