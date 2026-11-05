/**
 * The platform entitlements a product shows are the reserved keys of the services it has on:
 * licensing's always, Cloud Sync's and Cloud Connect's only while that service is enabled.
 */

import { describe, expect, it } from "vitest";
import { SERVICE_SLUGS, type ServicesMap } from "../../src/core/services.js";
import { platformEntitlementsFor } from "../../src/core/licensing/reservedNames.js";

function services(on: readonly string[]): ServicesMap {
  const out = {} as ServicesMap;
  for (const slug of SERVICE_SLUGS) out[slug] = { enabled: on.includes(slug) };
  return out;
}

const keys = (on: readonly string[]) =>
  platformEntitlementsFor({ services: services(on) }).map((e) => e.key);

describe("platformEntitlementsFor", () => {
  it("always includes the licensing keys, even with every service off", () => {
    const got = keys([]);
    expect(got).toContain("deviceLimit");
    expect(got).toContain("license.tier");
    expect(got).not.toContain("pkey.cloudSync.bytes");
    expect(got).not.toContain("pkey.cloudConnect.relayBytes");
  });

  it("adds the Cloud Sync quota only while Cloud Sync is on", () => {
    expect(keys(["license", "sync"])).toContain("pkey.cloudSync.bytes");
    expect(keys(["license"])).not.toContain("pkey.cloudSync.bytes");
  });

  it("adds the relay quota only while Cloud Connect is on", () => {
    expect(keys(["license", "connect"])).toContain(
      "pkey.cloudConnect.relayBytes",
    );
    expect(keys(["license", "sync"])).not.toContain(
      "pkey.cloudConnect.relayBytes",
    );
  });
});
