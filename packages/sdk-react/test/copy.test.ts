// @pkey-feature core.errors license.activate core.copy
//
// The error copy catalog (SDK-PARITY-PASS §3.2) and the typed activation table (§3.1).
//
// English is the generated module (src/copy.generated.ts, from conformance/parity/copy.en.json by
// `pnpm gen:constants`); French is the hand-written proof locale until SP-03. Every wire code in
// conformance/parity/errors.json has an English AND a French sentence; an unknown code falls back
// to COPY_FALLBACK naming it, never the server's body.

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
import {
  COPY_ACTIVATION,
  COPY_CODES,
  COPY_FALLBACK,
  COPY_GATE,
  COPY_PLACEHOLDERS,
} from "../src/copy.generated.js";
import { activationMessage, activationTitle } from "../src/core/copy.js";

const COPY_EN = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "conformance",
      "parity",
      "copy.en.json",
    ),
    "utf8",
  ),
) as {
  fallback: { title: string; message: string };
  codes: Record<string, { title: string; message: string }>;
  gate: Record<string, { title: string; message: string }>;
  activation: Record<string, { title: string; message: string }>;
};

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
      "Something went wrong (key_entry_limit). Try again.",
    );
    expect(copyTitle("key_entry_limit")).toBe(COPY_FALLBACK.title);
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
    ).toBe("Activation was refused (key_entry_limit).");
    expect(
      describeError({
        code: "sign-in-failed",
        activation: { kind: "refused", code: "license_owned" },
      }),
    ).toMatch(/already in another Polaris Key account/);
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

describe("core.copy: English is the generated module", () => {
  it("copyMessage and copyTitle read the generated tables, which match copy.en.json", () => {
    // The generated module is checked against copy.en.json by `pnpm gen:constants -- --check`;
    // this pins that the React surface reads it, entry for entry.
    expect(COPY_FALLBACK).toEqual(COPY_EN.fallback);
    for (const [code, e] of Object.entries(COPY_EN.codes)) {
      expect(COPY_CODES[code], code).toEqual(e);
      expect(copyTitle(code), code).toBe(e.title);
      if (!/\{(?!code\})/.test(e.message))
        expect(copyMessage(code), code).toBe(
          e.message.replace(/\{code\}/g, code),
        );
    }
    for (const [status, e] of Object.entries(COPY_EN.gate)) {
      expect(COPY_GATE[status], status).toEqual(e);
      expect(copyMessage(status), status).toBe(e.message);
    }
    for (const [result, e] of Object.entries(COPY_EN.activation)) {
      expect(COPY_ACTIVATION[result], result).toEqual(e);
      expect(activationTitle(result), result).toBe(e.title);
    }
  });

  it("an activation unauthorized reads the activation table, an error unauthorized the error table", () => {
    expect(
      describeError({
        activation: { kind: "unauthorized", code: "unauthorized" },
      }),
    ).toBe(COPY_ACTIVATION.unauthorized!.message);
    expect(activationTitle("unauthorized")).toBe("Key not accepted");
    expect(
      describeError({ code: "sign-in-failed", wireCode: "unauthorized" }),
    ).toBe(COPY_CODES.unauthorized!.message);
    expect(copyTitle("unauthorized")).toBe("Not signed in");
    // Each §3.1 kind reads its activationResult entry, camelCase or kebab.
    expect(activationMessage("deviceLimit")).toBe(
      COPY_ACTIVATION["device-limit"]!.message,
    );
    expect(activationMessage("device-limit")).toBe(
      COPY_ACTIVATION["device-limit"]!.message,
    );
    expect(
      describeError({
        activation: { kind: "rateLimited", code: "rate_limited" },
      }),
    ).toBe(COPY_ACTIVATION["rate-limited"]!.message);
  });

  it("placeholders: only the registered names, {code} filled, an unfilled one dropped", () => {
    for (const e of [
      ...Object.values(COPY_CODES),
      ...Object.values(COPY_GATE),
      ...Object.values(COPY_ACTIVATION),
      COPY_FALLBACK,
    ])
      for (const m of `${e.title} ${e.message}`.matchAll(/\{(\w+)\}/g))
        expect(COPY_PLACEHOLDERS).toContain(m[1]);
    expect(
      copyMessage("license_owned", { params: { product: "DJDL" } }),
    ).toMatch(/^This DJDL license is already/);
    expect(copyMessage("license_owned")).toMatch(/^This license is already/);
    expect(copyMessage("license_owned")).not.toMatch(/\{/);
  });

  it("French keeps its own sentences, and the activation kinds stay keyed by kind", () => {
    expect(
      describeError(
        { activation: { kind: "deviceLimit", code: "device_limit" } },
        "fr",
      ),
    ).toMatch(/limite d'appareils/);
    expect(activationMessage("device-limit", { locale: "fr" })).toMatch(
      /limite d'appareils/,
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

// Last in the file: the English override layer is module-wide.
describe("host English overrides", () => {
  it("win per key over the generated text, which stays the default", () => {
    registerCopyLocale("en", {
      messages: { rate_limited: "Easy there." },
      titles: { rate_limited: "Slow down" },
      generic: "", // empty: keep the generated fallback sentence
    });
    expect(copyMessage("rate_limited")).toBe("Easy there.");
    expect(copyTitle("rate_limited")).toBe("Slow down");
    expect(hasCopy("rate_limited")).toBe(true);
    // A key the host did not name keeps the generated English.
    expect(copyMessage("device_limit")).toBe(COPY_CODES.device_limit!.message);
    expect(copyTitle("device_limit")).toBe(COPY_CODES.device_limit!.title);
    // Activation keeps its own table unless the host overrides the kind.
    expect(
      describeError({
        activation: { kind: "unauthorized", code: "unauthorized" },
      }),
    ).toBe(COPY_ACTIVATION.unauthorized!.message);
  });
});
