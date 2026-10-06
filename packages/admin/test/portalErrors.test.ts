import { describe, expect, it } from "vitest";
import { PortalApiError } from "../src/portal/api.js";
import { portalErrorCopy } from "../src/portal/errors.js";

describe("portalErrorCopy: the download mint's reasons", () => {
  it("says why a download didn't start instead of the generic not-found copy", () => {
    expect(portalErrorCopy(new PortalApiError(409, "not_hosted")).title).toBe(
      "Not available here yet",
    );
    expect(
      portalErrorCopy(new PortalApiError(403, "license_inactive")).title,
    ).toBe("Your license isn't active");
    expect(portalErrorCopy(new PortalApiError(403, "not_entitled")).title).toBe(
      "Your license doesn't include this version",
    );
    expect(
      portalErrorCopy(new PortalApiError(404, "file_not_found")).title,
    ).toBe("That file is no longer offered");
  });

  it("keeps the status copy for every other answer, including a stranger's plain 404", () => {
    expect(portalErrorCopy(new PortalApiError(404, "not_found")).title).toBe(
      "That isn't here",
    );
    expect(portalErrorCopy(new PortalApiError(403, "forbidden")).title).toBe(
      "That didn't go through",
    );
    // An inherited property name is not a reason.
    expect(portalErrorCopy(new PortalApiError(404, "toString")).title).toBe(
      "That isn't here",
    );
  });
});
