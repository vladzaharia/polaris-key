/**
 * `sameOriginPost` (core/accounts/browserRequestGuard.ts): the rule the device pages and the
 * console's `pkey login` card share. Lifted from the device flow (ST-34.6, UX 1): a page served
 * with `referrer-policy: no-referrer` gets `Origin: null` on its own form post.
 */
import { describe, expect, it } from "vitest";
import { sameOriginPost } from "../src/core/accounts/browserRequestGuard.js";

const post = (headers: Record<string, string>) =>
  sameOriginPost(
    new Request("https://key.plrs.im/manage/device", {
      method: "POST",
      headers,
    }),
  );

describe("sameOriginPost", () => {
  it("accepts Origin null with Sec-Fetch-Site same-origin (the browser's real post)", () => {
    expect(post({ origin: "null", "sec-fetch-site": "same-origin" })).toBe(
      true,
    );
  });
  it("accepts a request with no headers (a non-browser client; the CSRF field still applies)", () => {
    expect(post({})).toBe(true);
  });
  it("without fetch metadata accepts a missing, null or this host's Origin", () => {
    expect(post({ origin: "null" })).toBe(true);
    expect(post({ origin: "https://key.plrs.im" })).toBe(true);
  });
  it("refuses another origin, and any Sec-Fetch-Site but same-origin", () => {
    expect(post({ origin: "https://evil.example" })).toBe(false);
    for (const site of ["cross-site", "same-site", "none"]) {
      expect(post({ "sec-fetch-site": site })).toBe(false);
      expect(post({ "sec-fetch-site": site, origin: "null" })).toBe(false);
    }
  });
});
