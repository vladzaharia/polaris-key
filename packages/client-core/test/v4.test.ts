// Unit proofs for the four pure functions P3-03 imports and the v4 claim helper. The corpus
// (`update-matrix.json#/versionCases`, `feedCases`, `releaseRecordCases`) pins them across
// every SDK through the Node runner; these pin the edges in isolation.
import { describe, expect, it } from "vitest";
import {
  BOOT_CONFIRMATIONS,
  BOOT_OK_SECONDS,
  BOOT_OUTCOMES,
  bootConfirmation,
  compareVersions,
  feedClaims,
  isWireInteger,
  parseVersion,
  releaseRecordClaims,
} from "../src/index.js";

describe("isWireInteger (WIRE-CONTRACT-V4 §3)", () => {
  const none = new Set<string>();
  it("accepts a safe integer at or above the minimum whose pointer is not flagged", () => {
    expect(isWireInteger(0, "/issuedAt", 0, none)).toBe(true);
    expect(isWireInteger(Number.MAX_SAFE_INTEGER, "/seq", 1, none)).toBe(true);
  });
  it("refuses a flagged pointer, a value below the minimum, a boolean, a float and 2^53", () => {
    expect(isWireInteger(7, "/seq", 1, new Set(["/seq"]))).toBe(false);
    expect(isWireInteger(0, "/seq", 1, none)).toBe(false);
    expect(isWireInteger(-1, "/issuedAt", 0, none)).toBe(false);
    expect(isWireInteger(true, "/schemaVersion", 1, none)).toBe(false);
    expect(isWireInteger(7.5, "/seq", 1, none)).toBe(false);
    expect(isWireInteger(2 ** 53, "/seq", 1, none)).toBe(false);
  });
});

describe("parseVersion and compareVersions (plans/P3-01.md §2.8)", () => {
  it("parses whole strings only, with ASCII digits", () => {
    expect(parseVersion("semver", "1.2.3")).not.toBeNull();
    for (const t of ["\n", "\r\n", "\r", "\u0085", "\u2028", "\u2029"])
      expect(parseVersion("semver", `1.2.3${t}`)).toBeNull();
    expect(parseVersion("semver", "١.٢.٣")).toBeNull();
    expect(parseVersion("calver", "2026.10.1")).toBeNull();
  });
  it("orders beyond 2^53 exactly, and mixed prerelease identifiers numerically first", () => {
    expect(
      compareVersions(
        "semver",
        "99999999999999999999.0.0",
        "99999999999999999998.0.0",
      ),
    ).toBe(1);
    expect(compareVersions("semver", "1.0.0-9", "1.0.0-10a")).toBe(-1);
    expect(compareVersions("semver", "1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("semver+build", "1.2.3+45", "1.2.3+9")).toBe(1);
    expect(compareVersions("4part", "1.10.0.0", "1.9.0.0")).toBe(1);
    expect(compareVersions("semver", "1.0.0-01", "1.0.0-1")).toBeNull();
  });
});

describe("bootConfirmation (stage matrix v2)", () => {
  it("covers every outcome with a listed confirmation", () => {
    expect(BOOT_OK_SECONDS).toBe(10);
    for (const outcome of BOOT_OUTCOMES)
      expect(BOOT_CONFIRMATIONS).toContain(bootConfirmation(outcome));
    expect(bootConfirmation("ready")).toBe("after-ok-seconds");
    expect(bootConfirmation("error")).toBe("never");
    expect(bootConfirmation("waiting")).toBe("now");
  });
});

describe("feedClaims and releaseRecordClaims never throw", () => {
  it("answers claims / false on hostile shapes", () => {
    for (const junk of [null, 5, "x", [], { app: { targets: [null] } }]) {
      expect(feedClaims(junk, { expectedAud: "djdl", channel: "stable" })).toBe(
        "claims",
      );
      expect(releaseRecordClaims(junk, { expectedAud: "djdl" })).toBe(false);
    }
  });
});
