/** A CI token is a feed-read credential only with the publish scope. */
import { describe, expect, it } from "vitest";
import { ANONYMOUS, principalOf } from "../src/core/registry/registryTokens.js";

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
});
