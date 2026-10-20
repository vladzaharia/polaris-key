// LK-17: an old portal hash with no console route goes to the customer site; a console route never does.
import { describe, expect, it } from "vitest";
import { parseLocation } from "../src/console/routes.js";
import { portalHandOff } from "../src/console/portalHandOff.js";

const CUSTOMER = "https://polaris.locker";
const go = (hash: string, origin: string | null = CUSTOMER) =>
  portalHandOff(parseLocation(hash).route, hash, origin);

describe("portalHandOff", () => {
  it("sends portal-only hashes to the customer site, hash intact", () => {
    for (const hash of [
      "#/library",
      "#/discover",
      "#/discover/djdl",
      "#/account",
      "#/account/methods",
      "#/p/djdl/free-device?license=l1",
    ])
      expect(go(hash), hash).toBe(`${CUSTOMER}/${hash}`);
  });

  it("leaves console routes alone", () => {
    for (const hash of [
      "#/",
      "#/products",
      "#/p/djdl",
      "#/p/djdl/license/licenses",
      "#/nonsense",
    ])
      expect(go(hash), hash).toBeNull();
  });

  it("does nothing without a customer origin", () => {
    expect(go("#/library", null)).toBeNull();
    expect(
      portalHandOff(parseLocation("#/library").route, "#/library", undefined),
    ).toBeNull();
  });
});
