import { describe, expect, it } from "vitest";
import {
  ACTION_GROUPS,
  verbFor,
} from "../src/console/sections/core/model/activityVerbs.js";

/** B-214: the Polaris Locker listing's writes and the legacy Commerce rows read as phrases. */
describe("activity verbs for store writes", () => {
  it("words a Polaris Locker listing write, not 'distribution polaris-key …'", () => {
    expect(verbFor("distribution.polaris-key.writeListingText")).toBe(
      "changed the Polaris Locker listing text of",
    );
    expect(verbFor("distribution.polaris-key.writeListingAssets")).toBe(
      "changed the Polaris Locker listing images of",
    );
    expect(verbFor("distribution.polaris-key.somethingNew")).toBe(
      "changed the Polaris Locker listing of",
    );
  });

  it("keeps the legacy distribution.commerce.* rows worded as Commerce", () => {
    expect(verbFor("distribution.commerce.settings")).toBe(
      "changed store settings",
    );
  });

  it("offers a filter for each prefix those rows were written under", () => {
    const values = ACTION_GROUPS.map((g) => g.value);
    expect(values).toContain("distribution.polaris-key.");
    expect(values).toContain("distribution.commerce.");
  });
});

describe("activity verbs for emailed keys and invitations (LX-27c.2)", () => {
  it("words each send and its failure, not the raw code", () => {
    for (const code of [
      "license.key.send",
      "license.key.send.failed",
      "license.key.send.revoked",
      "license.invite.send",
      "license.invite.send.failed",
    ])
      expect(verbFor(code), code).not.toContain("license.");
    expect(verbFor("license.invite.send")).toBe(
      "emailed an invitation for license",
    );
  });
});

describe("activity verbs for nearby approval (I-40.3)", () => {
  it("words both outcomes, not the raw code", () => {
    expect(verbFor("identity.nearby.approved")).toBe(
      "approved a nearby sign-in on a device",
    );
    expect(verbFor("identity.nearby.denied")).toBe(
      "denied a nearby sign-in on a device",
    );
  });
});

describe("activity verbs for sign-in clients (I-21.14)", () => {
  it("words every client write and the emergency rotation", () => {
    for (const a of [
      "identity.client.created",
      "identity.client.updated",
      "identity.client.deleted",
      "identity.client.disabled",
      "identity.client.enabled",
      "identity.client.secret.created",
      "identity.client.secret.revoked",
      "identity.issuer.key.emergency_rotated",
      "identity.issuer.key.created",
      "identity.issuer.key.published",
      "identity.issuer.key.rotated",
      "identity.issuer.key.dropped",
      "identity.client.continue",
      "identity.client.signin",
      "identity.client.token",
    ])
      expect(verbFor(a)).not.toBe(a);
  });
});
