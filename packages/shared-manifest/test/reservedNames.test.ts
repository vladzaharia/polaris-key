import { describe, expect, it } from "vitest";
import {
  PLATFORM_QUOTA_DEFAULT_BYTES,
  RESERVED_ENTITLEMENT_KEYS,
  platformEntitlements,
} from "../src/reservedNames.js";

const keys = (s: string[]) => platformEntitlements(s).map((k) => k.key);

describe("platform entitlements by service", () => {
  it("every row names a service, a kind and a default", () => {
    for (const k of RESERVED_ENTITLEMENT_KEYS) {
      expect(["license", "sync", "connect"]).toContain(k.service);
      expect(["feature", "quantity"]).toContain(k.kind);
      expect(k.default).not.toBeUndefined();
    }
  });
  it("shows the licence rows only when no other service is on", () => {
    const k = keys([]);
    expect(k).toContain("deviceLimit");
    expect(k).not.toContain("pkey.cloudSync.bytes");
    expect(k).not.toContain("pkey.cloudConnect.relayBytes");
  });
  it("shows the Cloud Sync quota only while sync is on", () => {
    expect(keys(["sync"])).toContain("pkey.cloudSync.bytes");
    expect(keys(["config"])).not.toContain("pkey.cloudSync.bytes");
    expect(keys(["connect"])).toContain("pkey.cloudConnect.relayBytes");
  });
  it("makes the Cloud Sync quota a 256 MiB quantity", () => {
    const row = RESERVED_ENTITLEMENT_KEYS.find(
      (k) => k.key === "pkey.cloudSync.bytes",
    );
    expect(row).toMatchObject({
      kind: "quantity",
      service: "sync",
      default: PLATFORM_QUOTA_DEFAULT_BYTES,
    });
    expect(PLATFORM_QUOTA_DEFAULT_BYTES).toBe(268435456);
  });
});
