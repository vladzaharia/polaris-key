// @pkey-feature core.copy
// The copy catalog (SDK parity pass §3.2): `copy` serves the generated English module
// (src/copy.generated.ts, `pnpm gen:constants` from conformance/parity/copy.en.json), its
// fallback names an unknown code and never a raw body, placeholders never show raw, and a
// registered locale falls back to the generated English per key.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copy, registerCopy } from "../src/core/copy.js";
import {
  COPY_ACTIVATION,
  COPY_CODES,
  COPY_FALLBACK,
  COPY_GATE,
} from "../src/copy.generated.js";

type Table = Record<string, { title: string; message: string }>;
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
  codes: Table;
  gate: Table;
  activation: Table;
};

describe("core.copy: the generated English catalog", () => {
  it("the generated module is copy.en.json", () => {
    expect(COPY_CODES).toEqual(COPY_EN.codes);
    expect(COPY_GATE).toEqual(COPY_EN.gate);
    expect(COPY_ACTIVATION).toEqual(COPY_EN.activation);
    expect(COPY_FALLBACK).toEqual(COPY_EN.fallback);
  });

  it("every error code reads its generated sentence and title", () => {
    for (const [code, entry] of Object.entries(COPY_CODES)) {
      expect(copy.has(code)).toBe(true);
      expect(copy.title(code)).toBe(entry.title);
      if (!/\{(?!code\})\w+\}/.test(entry.message))
        expect(copy.message(code)).toBe(entry.message.replace("{code}", code));
    }
    expect(copy.codes()).toEqual(Object.keys(COPY_CODES));
  });

  it("every gate status reads the gate table", () => {
    for (const [status, entry] of Object.entries(COPY_GATE))
      if (!Object.hasOwn(COPY_CODES, status))
        expect(copy.message(status)).toBe(entry.message);
  });

  it("an activation result reads the activation table, never the error-code table", () => {
    for (const [kind, entry] of Object.entries(COPY_ACTIVATION))
      expect(copy.activation(kind, { code: "x_code" })).toBe(
        entry.message.replace("{code}", "x_code"),
      );
    // The two `unauthorized` entries differ on purpose.
    expect(copy.activation("unauthorized")).toBe(
      COPY_ACTIVATION.unauthorized!.message,
    );
    expect(copy.message("unauthorized")).toBe(COPY_CODES.unauthorized!.message);
    // A §3.1 kind in either spelling reaches the same sentence.
    expect(copy.activation("deviceLimit")).toBe(
      COPY_ACTIVATION["device-limit"]!.message,
    );
  });

  it("an unknown code is COPY_FALLBACK naming it, never a body", () => {
    expect(copy.message("brand_new_code")).toBe(
      COPY_FALLBACK.message.replace("{code}", "brand_new_code"),
    );
    expect(copy.title("brand_new_code")).toBe(COPY_FALLBACK.title);
    expect(copy.has("brand_new_code")).toBe(false);
  });

  it("placeholders: {code} is filled, an unfilled one is dropped, detail goes in parentheses", () => {
    expect(copy.activation("refused", { code: "license_owned" })).toBe(
      "Activation was refused (license_owned).",
    );
    for (const code of Object.keys(COPY_CODES))
      expect(copy.message(code), code).not.toMatch(/\{\w+\}/);
    const productCode = Object.entries(COPY_CODES).find(([, e]) =>
      e.message.includes("{product}"),
    );
    if (productCode) expect(copy.message(productCode[0])).not.toContain("{");
    expect(copy.message("device_limit", "3/3 devices in use")).toBe(
      `${COPY_CODES.device_limit!.message.slice(0, -1)} (3/3 devices in use).`,
    );
  });

  it("a registered locale falls back to the generated English per key", () => {
    registerCopy("xx", {
      device_limit: { title: "XX title", message: "XX sentence." },
    });
    expect(copy.message("device_limit", undefined, "xx-YY")).toBe(
      "XX sentence.",
    );
    expect(copy.title("device-limit", "xx")).toBe("XX title");
    expect(copy.message("rate_limited", undefined, "xx")).toBe(
      COPY_CODES.rate_limited!.message,
    );
    // English itself is generated and cannot be replaced.
    registerCopy("en", { rate_limited: { title: "t", message: "m" } });
    expect(copy.message("rate_limited")).toBe(COPY_CODES.rate_limited!.message);
  });
});
