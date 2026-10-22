// @pkey-feature ui.kit
//
// The browser module both web kits share (UI-KITS.md DL18): the config object `<pk-gate config>`
// takes, the one link validator, and a client that does no I/O until started.

import { describe, expect, it, vi } from "vitest";

import {
  createBrowserClient,
  parseGateConfig,
  safeLink,
} from "../src/browser/index.js";

describe("parseGateConfig", () => {
  it("reads the attribute's JSON and the object alike", () => {
    const o = {
      product: "acme",
      baseUrl: "https://key.plrs.im",
      version: "1.2.3",
      auth: "cookie",
      expectedServices: ["license", "config"],
      returnUrl: "https://app.example/",
    };
    expect(parseGateConfig(JSON.stringify(o))).toEqual(o);
    expect(parseGateConfig(o)).toEqual(o);
    expect(parseGateConfig({ productSlug: "acme" })).toEqual({
      product: "acme",
    });
  });

  it.each([
    ["not json", "config is not valid JSON"],
    [[], "config must be an object"],
    [{}, "config.product is required"],
    [
      { product: "a", auth: "magic" },
      "config.auth must be cookie, bearer or auto",
    ],
    [
      { product: "a", expectedServices: ["nope"] },
      "config.expectedServices has an unknown service: nope",
    ],
    [{ product: 3 }, "config.product must be a string"],
  ])("refuses %j", (raw, message) => {
    expect(() => parseGateConfig(raw)).toThrow(
      expect.objectContaining({ code: "invalid-options", message }),
    );
  });
});

describe("safeLink", () => {
  it("passes https and loopback http, and drops the rest", () => {
    expect(safeLink("https://key.plrs.im/a")).toBe("https://key.plrs.im/a");
    expect(safeLink("http://localhost:8787/a")).toBe("http://localhost:8787/a");
    expect(safeLink("http://example.test/")).toBeNull();
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("https://u:p@example.test/")).toBeNull();
    expect(safeLink(undefined)).toBeNull();
  });
});

describe("createBrowserClient", () => {
  it("does no I/O until started", () => {
    const fetchImpl = vi.fn();
    const client = createBrowserClient(
      { product: "acme", baseUrl: "https://key.plrs.im" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    client.dispose();
  });
});
