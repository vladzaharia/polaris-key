// @pkey-feature identity.link
//
// The conflict step's Help link (I-46.13): it names the Polaris Locker host and a section the
// Help page really has.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { JOIN_ACCOUNTS_URL } from "../src/browser/sdk/linkOffer.js";

describe("the link conflict's Help link", () => {
  it("is on the customer host, never the developer one", () => {
    const url = new URL(JOIN_ACCOUNTS_URL);
    expect(url.origin).toBe("https://polaris.locker");
    expect(url.pathname).toBe("/docs/help/join-accounts/");
  });

  it("points at a heading of the page", () => {
    const page = readFileSync(
      new URL(
        "../../docs/src/content/docs/help/join-accounts.mdx",
        import.meta.url,
      ),
      "utf8",
    );
    const anchor = new URL(JOIN_ACCOUNTS_URL).hash.slice(1);
    const slugs = [...page.matchAll(/^## (.+)$/gm)].map((m) =>
      m[1]!
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .trim()
        .replace(/ +/g, "-"),
    );
    expect(slugs).toContain(anchor);
  });
});
