/** A CI token is a feed-read credential only with the publish scope or `packages:read`. */
import { describe, expect, it } from "vitest";
import {
  ANONYMOUS,
  CI_FEED_READ_SCOPES,
  principalOf,
  registryPublisher,
} from "../src/core/registry/registryTokens.js";
import { CI_SCOPES } from "../src/core/ciVocabulary.js";
import { DEFAULT_CI_SCOPES } from "../src/core/publisher.js";

const ci = (scopes: string[]) =>
  ({
    kind: "ci",
    product: "acme",
    tokenId: "cit_1",
    scopes,
    ciKind: "oidc",
    subject: "github:x",
  }) as const;

describe("principalOf for CI tokens", () => {
  it("a report-only or promote-only token is no feed credential", () => {
    expect(principalOf(ci(["distribution:report"]))).toBe(ANONYMOUS);
    expect(principalOf(ci(["release:promote"]))).toBe(ANONYMOUS);
  });
  it("a publish-scoped token reads the owner's feeds", () => {
    expect(principalOf(ci(["release:publish"]))).toMatchObject({
      kind: "ci",
      product: "acme",
    });
  });
  it("a packages:read token reads the owner's feeds (F-33b.2) and is opt-in", () => {
    expect(principalOf(ci(["packages:read"]))).toMatchObject({
      kind: "ci",
      product: "acme",
      tokenId: "cit_1",
    });
    expect(CI_FEED_READ_SCOPES).toEqual(["release:publish", "packages:read"]);
    expect(CI_SCOPES).toContain("packages:read");
    expect(DEFAULT_CI_SCOPES).not.toContain("packages:read");
  });
  it("a packages:read token never publishes, natively or by OCI push", () => {
    for (const eco of ["oci", "npm", "pypi", "maven", "swift", "cargo", "go"])
      expect(registryPublisher(ci(["packages:read"]), "acme", eco)).toBeNull();
    // The publish scope still publishes, for its own owner only.
    expect(
      registryPublisher(ci(["release:publish"]), "acme", "oci"),
    ).not.toBeNull();
    expect(
      registryPublisher(ci(["release:publish"]), "other", "oci"),
    ).toBeNull();
  });
});
