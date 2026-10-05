import { describe, expect, it } from "vitest";
import {
  allowedReturn,
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
