// @pkey-feature core.errors license.activate
//
// The error copy catalog (SDK-PARITY-PASS §3.2) and the typed activation table (§3.1).
//
// Every wire code in conformance/parity/errors.json has an English AND a French sentence, so the
// generated `copy.en.json` (SP-00/SP-03) can replace this table key for key; an unknown code
// falls back to a generic sentence that names it, never the server's body.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  copyMessage,
  copyTitle,
  describeError,
  hasCopy,
  registerCopyLocale,
} from "../src/core/copy.js";
import { classifyActivation } from "../src/core/activation.js";

const ERRORS = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "conformance",
      "parity",
      "errors.json",
    ),
    "utf8",
  ),
) as { codes: { code: string; kind: string }[] };

const KINDS = [
  "deviceLimit",
  "fingerprintRequired",
  "hardwareMismatch",
  "enrollClaimed",
  "licenseDisabled",
  "licenseExpired",
  "attestationRequired",
  "rateLimited",
  "enrollDisabled",
  "refused",
  "error",
];

describe("copy catalog (§3.2)", () => {
  it("every registered wire code and every §3.1 kind has English and French copy", () => {
    const keys = [
      ...ERRORS.codes.filter((c) => c.kind === "wire").map((c) => c.code),
      ...KINDS,
    ];
    expect(keys.filter((k) => !hasCopy(k, "en"))).toEqual([]);
    expect(keys.filter((k) => !hasCopy(k, "fr"))).toEqual([]);
  });

  it("every gate status has copy", () => {
    for (const s of [
      "ok",
      "grace",
      "expired",
      "revoked",
      "needs-activation",
      "version-too-old",
      "version-too-new",
      "channel-not-entitled",
      "not-applicable",
    ])
      expect(hasCopy(s), s).toBe(true);
  });

  it("an unknown code falls back to a generic sentence naming it", () => {
    expect(copyMessage("key_entry_limit")).toBe(
      "Something went wrong (key_entry_limit). Please try again.",
    );
    expect(copyMessage("key_entry_limit", { locale: "fr-CA" })).toMatch(
      /key_entry_limit/,
    );
  });

  it("locales resolve by language and fall back to English per key", () => {
    expect(copyMessage("device_limit", { locale: "fr-CA" })).toMatch(
      /limite d'appareils/,
    );
    expect(copyTitle("device_limit", "fr")).toBe("Limite d'appareils atteinte");
    registerCopyLocale("de", {
      generic: "Fehler ({code}).",
      messages: { device_limit: "Gerätelimit." },
    });
    expect(copyMessage("device_limit", { locale: "de" })).toBe("Gerätelimit.");
    expect(copyMessage("license_disabled", { locale: "de" })).toMatch(
      /disabled/,
    );
  });

  it("describeError prefers the activation kind, then the server's code, then the SDK's", () => {
    expect(
      describeError({
        code: "sign-in-failed",
        activation: { kind: "refused", code: "key_entry_limit" },
      }),
    ).toBe("The licensing service refused this request (key_entry_limit).");
    expect(
      describeError({
        code: "sign-in-failed",
        activation: { kind: "refused", code: "license_owned" },
      }),
    ).toMatch(/another account/);
    expect(
      describeError({
        code: "release-refused",
        wireCode: "channel_not_allowed",
      }),
    ).toMatch(/release channel/);
    expect(describeError({ code: "network" }, "fr")).toMatch(
      /Impossible de joindre/,
    );
  });
});

describe("activation table (§3.1)", () => {
  it.each([
    [
      403,
      { error: { code: "device_limit", limit: 3, deviceCount: 3 } },
      "deviceLimit",
    ],
    [403, { error: "fingerprint_required" }, "fingerprintRequired"],
    [409, { error: { code: "hardware_mismatch" } }, "hardwareMismatch"],
    [409, {}, "hardwareMismatch"],
    [403, { error: { code: "enroll_claimed" } }, "enrollClaimed"],
    [403, { error: { code: "license_disabled" } }, "licenseDisabled"],
    [403, { error: { code: "license_expired" } }, "licenseExpired"],
    [403, { error: { code: "attestation_required" } }, "attestationRequired"],
    [429, { error: { code: "rate_limited" } }, "rateLimited"],
    [429, null, "rateLimited"],
    [401, { error: "unauthorized" }, "unauthorized"],
    [401, null, "unauthorized"],
    [404, { error: { code: "enroll_disabled" } }, "enrollDisabled"],
    [403, { error: { code: "license_owned" } }, "refused"],
    [403, null, "refused"],
    [500, null, "error"],
  ])("%i %j → %s", (status, body, kind) => {
    expect(classifyActivation(status, body).kind).toBe(kind);
  });

  it("an unknown 403 is never the device limit, and keeps the server's code", () => {
    expect(
      classifyActivation(403, { error: { code: "key_entry_limit" } }),
    ).toEqual({
      kind: "refused",
      code: "key_entry_limit",
      status: 403,
    });
    expect(classifyActivation(403, null).code).toBe("http-error");
  });

  it("carries limit, deviceCount and Retry-After", () => {
    expect(
      classifyActivation(403, {
        error: { code: "device_limit" },
        limit: 2,
        deviceCount: 2,
      }),
    ).toMatchObject({
      limit: 2,
      deviceCount: 2,
    });
    expect(
      classifyActivation(429, { error: "rate_limited" }, "30")
        .retryAfterSeconds,
    ).toBe(30);
  });
});
