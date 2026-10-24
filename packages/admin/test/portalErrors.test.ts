import { describe, expect, it } from "vitest";
import { HttpError } from "../src/portal/api.js";
import { portalErrorCopy } from "../src/portal/errors.js";

describe("portalErrorCopy: the download mint's reasons", () => {
  it("says why a download didn't start instead of the generic not-found copy", () => {
    expect(
      portalErrorCopy(new HttpError(409, { code: "not_hosted" })).title,
    ).toBe("Not available here yet");
    expect(
      portalErrorCopy(new HttpError(403, { code: "license_inactive" })).title,
    ).toBe("Your license isn't active");
    expect(
      portalErrorCopy(new HttpError(403, { code: "not_entitled" })).title,
    ).toBe("Not included");
    expect(
      portalErrorCopy(new HttpError(404, { code: "file_not_found" })).title,
    ).toBe("That file is no longer offered");
  });

  it("keeps the status copy for every other answer, including a stranger's plain 404", () => {
    expect(
      portalErrorCopy(new HttpError(404, { code: "not_found" })).title,
    ).toBe("Not found");
    expect(
      portalErrorCopy(new HttpError(403, { code: "forbidden" })).title,
    ).toBe("Not allowed");
    // An inherited property name is not a reason.
    expect(
      portalErrorCopy(new HttpError(404, { code: "toString" })).title,
    ).toBe("Not found");
  });
});
