import { describe, expect, it } from "vitest";
import type { PolarisKeyClient } from "../../src/client.js";
import { portalUrl } from "../../src/cli/flows.js";

const client = (baseUrl: string) =>
  ({ core: { baseUrl }, product: "djdl" }) as unknown as PolarisKeyClient;

describe("portalUrl (customer-facing activate link)", () => {
  it("maps the platform default base to the customer origin", () => {
    expect(portalUrl(client("https://key.plrs.im/"))).toBe(
      "https://polaris.locker/activate?product=djdl",
    );
  });
  it("keeps a self-hosted base's own host", () => {
    expect(portalUrl(client("https://keys.example.com"))).toBe(
      "https://keys.example.com/activate?product=djdl",
    );
  });
  it("prefers the server's link", () => {
    expect(
      portalUrl(client("https://key.plrs.im"), "https://polaris.locker/x"),
    ).toBe("https://polaris.locker/x");
  });
});
