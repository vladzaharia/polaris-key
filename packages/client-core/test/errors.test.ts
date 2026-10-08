// @pkey-feature core.errors
// `PolarisError`'s optional transport details (SP-46): the HTTP status, `Retry-After` in seconds,
// the server's own code under the SDK's class for the answer, and the chained cause. A refusal
// decided locally carries none of them.

import { describe, expect, it } from "vitest";
import { PolarisError, UnsupportedError } from "../src/index.js";

describe("PolarisError details (SP-46)", () => {
  it("carries status, retryAfterSeconds, wireCode and cause when given", () => {
    const cause = new TypeError("fetch failed");
    const e = new PolarisError("server-error", "the server says no", {
      status: 503,
      retryAfterSeconds: 30,
      wireCode: "misconfigured",
      cause,
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("server-error");
    expect(e.message).toBe("the server says no");
    expect(e.status).toBe(503);
    expect(e.retryAfterSeconds).toBe(30);
    expect(e.wireCode).toBe("misconfigured");
    expect(e.cause).toBe(cause);
  });

  it("a local refusal has none of them, not even as undefined own properties", () => {
    const e = new PolarisError("local-only", "refused");
    for (const k of ["status", "retryAfterSeconds", "wireCode", "cause"])
      expect(Object.prototype.hasOwnProperty.call(e, k), k).toBe(false);
    expect({ ...e }).toEqual({ name: "PolarisError", code: "local-only" });
  });

  it("subclasses keep their two-argument constructors", () => {
    const e = new UnsupportedError({
      supported: false,
      feature: "core.store",
      reason: "runtime",
      detail: "no store",
    });
    expect(e).toBeInstanceOf(PolarisError);
    expect(e.status).toBeUndefined();
  });
});
