/**
 * I-15.3: the redirect URI classes (WIRE-CONTRACT-V5 §12.12), as a pure accept/refuse table.
 * I-15.4 adds the `request` route cases below.
 */
import { describe, expect, it } from "vitest";
import { validateRedirectUri } from "../../src/services/identity/passthrough/redirectUri.js";

const APP = "https://app.example";
const reg = {
  webOrigins: [APP],
  redirectPaths: ["/auth/callback"],
  loopback: true,
  schemes: ["com.tidewater.studio"],
  claimedPaths: ["/open"],
};
const native = (r: typeof reg, uri: unknown) =>
  validateRedirectUri(r, uri, "native");

describe("validateRedirectUri: native classes", () => {
  it.each([
    ["an IPv4 loopback", "http://127.0.0.1:49152/pkey/callback", "loopback"],
    ["an IPv6 loopback", "http://[::1]:8123/pkey/callback", "loopback"],
    ["the top port", "http://127.0.0.1:65535/pkey/callback", "loopback"],
    ["a registered scheme", "com.tidewater.studio:/pkey/callback", "scheme"],
    ["a claimed path", `${APP}/open`, "claimed"],
  ])("accepts %s", (_n, uri, redirect) => {
    expect(native(reg, uri)).toEqual({
      ok: true,
      kind: "native",
      redirect,
      uri,
    });
  });

  it.each([
    ["localhost", "http://localhost:4000/pkey/callback"],
    ["another loopback address", "http://127.0.0.2:4000/pkey/callback"],
    ["https loopback", "https://127.0.0.1:4000/pkey/callback"],
    ["no port", "http://127.0.0.1/pkey/callback"],
    ["port 80", "http://127.0.0.1:80/pkey/callback"],
    ["port 0", "http://127.0.0.1:0/pkey/callback"],
    ["a leading-zero port", "http://127.0.0.1:04000/pkey/callback"],
    ["a port over 65535", "http://127.0.0.1:65536/pkey/callback"],
    ["another path", "http://127.0.0.1:4000/cb"],
    ["a percent-encoded path", "http://127.0.0.1:4000/pkey/%63allback"],
    ["a trailing slash", "http://127.0.0.1:4000/pkey/callback/"],
    ["a query", "http://127.0.0.1:4000/pkey/callback?a=1"],
    ["a fragment", "http://127.0.0.1:4000/pkey/callback#x"],
    ["userinfo", "http://u@127.0.0.1:4000/pkey/callback"],
    ["an IDN host", "http://ｌｏｃａｌｈｏｓｔ:4000/pkey/callback"],
    ["an unregistered scheme", "com.other.app:/pkey/callback"],
    ["a scheme with an authority", "com.tidewater.studio://pkey/callback"],
    ["a scheme with another path", "com.tidewater.studio:/other"],
    ["an upper-case scheme", "COM.TIDEWATER.STUDIO:/pkey/callback"],
    ["an unlisted claimed path", `${APP}/other`],
    ["a claimed path on another origin", "https://evil.example/open"],
    ["a claimed path with a query", `${APP}/open?x=1`],
    ["a web path (not claimed)", `${APP}/auth/callback`],
    ["nothing", ""],
  ])("refuses %s", (_n, uri) => {
    expect(native(reg, uri).ok).toBe(false);
  });

  it("refuses loopback when the product turned it off, and keeps the other classes", () => {
    const off = { ...reg, loopback: false };
    expect(native(off, "http://127.0.0.1:4000/pkey/callback").ok).toBe(false);
    expect(native(off, "com.tidewater.studio:/pkey/callback").ok).toBe(true);
  });

  it("refuses a claimed path that is also a web path", () => {
    const both = { ...reg, claimedPaths: ["/auth/callback"] };
    expect(native(both, `${APP}/auth/callback`).ok).toBe(false);
  });

  it("refuses a scheme when none is registered", () => {
    expect(
      native({ ...reg, schemes: [] }, "com.tidewater.studio:/pkey/callback").ok,
    ).toBe(false);
  });

  it("accepts a native URI only from a caller that asks for native", () => {
    for (const uri of [
      "http://127.0.0.1:4000/pkey/callback",
      "com.tidewater.studio:/pkey/callback",
      `${APP}/open`,
    ])
      expect(validateRedirectUri(reg, uri).ok).toBe(false);
  });

  it("does not take a web URI from a native caller", () => {
    expect(native(reg, `${APP}/auth/callback`).ok).toBe(false);
    expect(validateRedirectUri(reg, `${APP}/auth/callback`).ok).toBe(true);
  });
});
