import { describe, expect, it } from "vitest";
import {
  allowedReturn,
  cardReturn,
  carriesKey,
  MAX_RETURN_LENGTH,
} from "../src/portal/model/returnUrl.js";

const DECLARED = {
  origins: ["https://app.tidewater.example", "http://127.0.0.1:8123"],
  schemes: ["tidewater"],
};

describe("return-URL allowlist (§3.3, PX-10)", () => {
  it.each([
    [
      "https://app.tidewater.example/after?x=1",
      "https://app.tidewater.example/after?x=1",
    ],
    ["https://APP.tidewater.example", "https://app.tidewater.example/"],
    ["http://127.0.0.1:8123/done", "http://127.0.0.1:8123/done"],
    ["tidewater://signed-in", "tidewater://signed-in"],
    ["TideWater:retry", "tidewater:retry"],
  ])("follows a declared target: %s", (raw, expected) => {
    expect(allowedReturn(raw, DECLARED)).toBe(expected);
  });

  it.each([
    ["another origin", "https://evil.example/"],
    ["a look-alike subdomain", "https://app.tidewater.example.evil.example/"],
    ["the right host on another port", "https://app.tidewater.example:8443/"],
    ["the right host over http", "http://app.tidewater.example/"],
    ["loopback on another port", "http://127.0.0.1:9999/"],
    ["an undeclared scheme", "otherapp://open"],
    ["javascript, even if declared", "javascript:alert(1)"],
    ["a data URL", "data:text/html,<p>hi</p>"],
  ])("refuses an undeclared target: %s", (_, raw) => {
    expect(
      allowedReturn(raw, {
        ...DECLARED,
        schemes: [...DECLARED.schemes, "javascript", "data"],
      }),
    ).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["not a URL", "not a url"],
    ["relative", "/p/tidewater"],
    ["protocol-relative", "//app.tidewater.example/"],
    ["credentials", "https://user:pw@app.tidewater.example/"],
    ["a control character", "https://app.tidewater.example/\u0000x"],
    ["an embedded newline", "https://app.tidewater.example/\nx"],
    ["a space", "https://app.tidewater.example/a b"],
    [
      "too long",
      `https://app.tidewater.example/${"a".repeat(MAX_RETURN_LENGTH)}`,
    ],
  ])("refuses a malformed value: %s", (_, raw) => {
    expect(allowedReturn(raw, DECLARED)).toBeNull();
  });

  it("follows nothing when the product declares nothing, or the Worker didn't say", () => {
    expect(
      allowedReturn("https://app.tidewater.example/", {
        origins: [],
        schemes: [],
      }),
    ).toBeNull();
    expect(
      allowedReturn("https://app.tidewater.example/", undefined),
    ).toBeNull();
    expect(allowedReturn(null, DECLARED)).toBeNull();
  });

  it("ignores a malformed declared origin instead of matching it loosely", () => {
    expect(
      allowedReturn("https://app.example/", {
        origins: ["app.example", "*.example"],
        schemes: [],
      }),
    ).toBeNull();
  });
});

const KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";

describe("a return URL never carries a license key (PX-17)", () => {
  it("spots a key anywhere in the value", () => {
    expect(carriesKey(KEY)).toBe(true);
    expect(carriesKey(`tidewater://back?k=${KEY}`)).toBe(true);
    expect(carriesKey("tidewater://back?k=pkey_mossgarden_short")).toBe(false);
    expect(carriesKey("/signin?request=rq_0123456789abcdef")).toBe(false);
  });

  it("refuses a declared target that carries one", () => {
    expect(allowedReturn(`tidewater://back?k=${KEY}`, DECLARED)).toBeNull();
    expect(
      allowedReturn(`https://app.tidewater.example/#${KEY}`, DECLARED),
    ).toBeNull();
  });
});

describe("the login card as a return target (PX-17; plans/I-04.md owner decision)", () => {
  const ORIGIN = "https://key.plrs.im";

  it.each([
    [
      "/signin?request=rq_0123456789abcdef",
      "/signin?request=rq_0123456789abcdef",
    ],
    ["/signin/?request=rq_1", "/signin/?request=rq_1"],
    ["https://key.plrs.im/signin?request=rq_1", "/signin?request=rq_1"],
    ["/signin", "/signin"],
  ])("follows the card on this origin: %s", (raw, expected) => {
    expect(cardReturn(raw, ORIGIN)).toBe(expected);
  });

  it.each([
    ["another origin", "https://evil.example/signin?request=rq_1"],
    ["protocol-relative", "//evil.example/signin"],
    ["a backslash", "/\\evil.example/signin"],
    ["another page on this origin", "/download/tok_1"],
    ["the Library", "/#/p/mossgarden"],
    ["a dot-segment out of the card", "/signin/../logout"],
    ["javascript", "javascript:alert(1)"],
    ["credentials", "https://u:p@key.plrs.im/signin"],
    ["a control character", "/signin?\u0000"],
    ["a space", "/signin?a b"],
    ["a key", `/signin?request=rq_1&k=${KEY}`],
    ["too long", `/signin?request=${"a".repeat(MAX_RETURN_LENGTH)}`],
    ["empty", ""],
  ])("refuses %s", (_, raw) => {
    expect(cardReturn(raw, ORIGIN)).toBeNull();
  });

  it("is not an app target: the declared-target check refuses a path", () => {
    expect(allowedReturn("/signin?request=rq_1", DECLARED)).toBeNull();
  });
});
