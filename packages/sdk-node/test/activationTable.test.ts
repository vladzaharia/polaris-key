// @pkey-feature license.activate license.enroll
// SDK parity pass §3.1: the typed activation table. Every refusal carries the server's code and
// is mapped by that code, never by the status alone; an unknown 4xx is `refused{code}`.

import { describe, expect, it } from "vitest";
import { activationRefusal } from "../src/license/endpoints.js";
import { copy } from "../src/core/copy.js";

const ROWS: [number, unknown, string, Record<string, unknown>][] = [
  [
    403,
    { error: "device_limit", limit: 2, deviceCount: 2 },
    "device-limit",
    { limit: 2, deviceCount: 2 },
  ],
  [
    403,
    { error: { code: "device_limit", limit: 1 } },
    "device-limit",
    { limit: 1 },
  ],
  [403, { error: "fingerprint_required" }, "fingerprint-required", {}],
  [
    409,
    { error: "hardware_mismatch", drift: 2, changed: ["cpuModel"] },
    "hardware-mismatch",
    { drift: 2, changed: ["cpuModel"] },
  ],
  [
    403,
    { error: "enroll_claimed", message: "sign in to use it" },
    "enroll-claimed",
    {},
  ],
  [403, { error: "license_disabled" }, "license-disabled", {}],
  [403, { error: "license_expired" }, "license-expired", {}],
  [
    403,
    { error: { code: "attestation_required" } },
    "attestation-required",
    {},
  ],
  [429, { error: "rate_limited" }, "rate-limited", {}],
  [401, { error: "unauthorized" }, "unauthorized", {}],
  [401, {}, "unauthorized", {}],
  [404, { error: "enroll_disabled" }, "enroll-disabled", {}],
];

describe("activation refusals (§3.1)", () => {
  for (const [status, body, kind, fields] of ROWS) {
    it(`${status} ${JSON.stringify(body)} → ${kind}`, () => {
      const r = activationRefusal(status, body as never);
      expect(r.kind).toBe(kind);
      expect(typeof r.code).toBe("string");
      expect(r.code.length).toBeGreaterThan(0);
      expect(r).toMatchObject(fields);
    });
  }

  it("an unknown 403 is refused with the server's code, never a device limit (I-09 is additive)", () => {
    for (const code of ["license_owned", "key_entry_limit", "brand_new_code"]) {
      expect(activationRefusal(403, { error: { code, message: "m" } })).toEqual(
        { kind: "refused", code, status: 403, message: "m" },
      );
    }
  });

  it("a 5xx is error{server}", () => {
    expect(activationRefusal(503, {})).toMatchObject({
      kind: "error",
      code: "server",
      status: 503,
    });
  });

  it("Retry-After becomes retryAfterSeconds", () => {
    expect(activationRefusal(429, { error: "rate_limited" }, "30")).toEqual({
      kind: "rate-limited",
      code: "rate_limited",
      retryAfterSeconds: 30,
    });
  });

  it("every kind has copy, and unknown codes fall back to a generic sentence naming the code", () => {
    for (const [, , kind] of ROWS) expect(copy.has(kind)).toBe(true);
    expect(copy.message("brand_new_code")).toContain("brand_new_code");
    expect(copy.message("device_limit", "3/3")).toContain("(3/3)");
  });
});
