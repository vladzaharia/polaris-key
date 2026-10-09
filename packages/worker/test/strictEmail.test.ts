import { describe, expect, it } from "vitest";
import { parseEmail } from "../src/services/identity/card/http.js";

describe("parseEmail", () => {
  it("accepts a bare addr-spec, normalised", () => {
    expect(parseEmail("  User+x@Example.COM ")).toBe("user+x@example.com");
  });
  it("refuses wrapping, lists, quoting and header metacharacters", () => {
    for (const bad of [
      "Name<victim@x.com>",
      "<victim@x.com>",
      "a@x.com,b@y.com",
      "a@x.com;b@y.com",
      '"a b"@x.com',
      "a@x.com>",
      "a(c)@x.com",
      "a@x.com\r\nBcc: z@y.com",
      "a@@x.com",
      "a@x..com",
      "a@-x.com",
      "ünï@x.com",
    ])
      expect(parseEmail(bad), bad).toBeNull();
  });
});
