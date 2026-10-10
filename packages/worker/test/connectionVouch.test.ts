import { describe, expect, it } from "vitest";
import {
  connectionVouchesForEmail,
  providerVouchesForEmail,
} from "../src/services/identity/providers/vouch.js";

// I-30 (plans/I-27.md §2.3 "Trust in `email_verified`"): a connection's `email_verified` counts
// only inside its DNS-verified domains, exactly, and only for a platform connection. Homographs,
// subdomains and suffix lookalikes never vouch.

const platform = { scope: "platform", status: "active" as const };
const verified = ["example.com"];
const id = (email: string | null, emailVerified = true) => ({
  email,
  emailVerified,
});

describe("connectionVouchesForEmail", () => {
  it("vouches for an address inside a verified domain", () => {
    expect(
      connectionVouchesForEmail(platform, id("ada@example.com"), verified),
    ).toBe(true);
    expect(
      connectionVouchesForEmail(platform, id("Ada@EXAMPLE.com"), verified),
    ).toBe(true);
  });

  it("never without email_verified, an address, or a verified domain", () => {
    expect(
      connectionVouchesForEmail(
        platform,
        id("ada@example.com", false),
        verified,
      ),
    ).toBe(false);
    expect(connectionVouchesForEmail(platform, id(null), verified)).toBe(false);
    // An unverified domain is simply not in the list.
    expect(connectionVouchesForEmail(platform, id("ada@example.com"), [])).toBe(
      false,
    );
  });

  it("subdomains and suffix lookalikes are not covered", () => {
    for (const email of [
      "ada@sub.example.com",
      "ada@evil-example.com",
      "ada@example.com.evil.net",
      "ada@xample.com",
      "ada@example.co",
      "ada@example.com.",
    ]) {
      expect(
        connectionVouchesForEmail(platform, id(email), verified),
        email,
      ).toBe(false);
    }
  });

  it("homographs never vouch: Kelvin sign, Cyrillic, punycode", () => {
    // U+212A KELVIN SIGN lower-cases to ASCII "k": "\u212Aey.com" would fold onto "key.com".
    expect("\u212Aey.com".toLowerCase()).toBe("key.com");
    expect(
      connectionVouchesForEmail(platform, id("ada@\u212Aey.com"), ["key.com"]),
    ).toBe(false);
    expect(
      connectionVouchesForEmail(platform, id("\u212Aate@key.com"), ["key.com"]),
    ).toBe(false);
    // U+0430 CYRILLIC SMALL LETTER A.
    expect(
      connectionVouchesForEmail(platform, id("ada@ex\u0430mple.com"), verified),
    ).toBe(false);
    // The punycode form of that lookalike is a different domain.
    expect(
      connectionVouchesForEmail(
        platform,
        id("ada@xn--exmple-4nf.com"),
        verified,
      ),
    ).toBe(false);
  });

  it("a product connection never vouches; a disabled one vouches for nothing", () => {
    expect(
      connectionVouchesForEmail(
        { scope: "product:acme", status: "active" },
        id("ada@example.com"),
        verified,
      ),
    ).toBe(false);
    expect(
      connectionVouchesForEmail(
        { scope: "platform", status: "disabled" },
        id("ada@example.com"),
        verified,
      ),
    ).toBe(false);
  });

  it("the legacy rule is unchanged (the legacy product engine keeps it until I-32b)", () => {
    expect(
      providerVouchesForEmail(
        { kind: "oidc", email: "ada@anywhere.example", emailVerified: true },
        null,
      ),
    ).toBe(true);
  });
});
