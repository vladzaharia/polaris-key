// The portal matrix's generator-local reference (plans/DISC-01.md §4) restates the limits rather
// than importing them, so it shares no code with what it checks. This pins the restated values
// to `@polaris-key/protocol`'s, and gives the self-check teeth.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as core from "@polaris-key/protocol/core";
import * as license from "@polaris-key/protocol/license";
import {
  buildPortalMatrix,
  PORTAL_MATRIX_VERSION,
  REF_LIMITS,
  refLink,
  refLinkOk,
  refParse,
} from "./portal-matrix.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const protocol: Record<string, unknown> = { ...core, ...license };

describe("portal-matrix.json's reference", () => {
  it("restates exactly the protocol's limits", () => {
    for (const [name, value] of Object.entries(REF_LIMITS))
      expect(value, name).toEqual(protocol[name]);
  });

  it("is the committed file's version, and the file is ASCII", () => {
    const text = readFileSync(
      join(ROOT, "conformance", "corpus", "v2", "portal-matrix.json"),
      "utf8",
    );
    const file = JSON.parse(text) as { portalMatrixVersion: number };
    expect(file.portalMatrixVersion).toBe(PORTAL_MATRIX_VERSION);
    expect(PORTAL_MATRIX_VERSION).toBe(1);
    // eslint-disable-next-line no-control-regex
    expect(/^[\u0000-\u007f]*$/.test(text)).toBe(true);
    expect(buildPortalMatrix().portalMatrixVersion).toBe(1);
  });

  it("has teeth: the rules it recomputes", () => {
    expect(refLinkOk("https://polaris.locker/activate?product=djdl")).toBe(
      true,
    );
    expect(refLinkOk("http://localhost:8787/x")).toBe(true);
    expect(refLinkOk("http://example.com/x")).toBe(false);
    expect(refLinkOk("https://u@example.com/x")).toBe(false);
    expect(refLinkOk("https://example.com\\@evil/x")).toBe(false);
    expect(refLinkOk("https://example.com/a b")).toBe(false);
    expect(refLinkOk("javascript:alert(1)")).toBe(false);
    expect(refLinkOk(`https://a.example/${"a".repeat(2030)}`)).toBe(true);
    expect(refLinkOk(`https://a.example/${"a".repeat(2031)}`)).toBe(false);
    expect(refParse({ portal: { enabled: "true" } })).toBeNull();
    expect(refParse({ portal: { enabled: false, activate: "x" } })).toEqual({
      enabled: false,
    });
    // The Worker has answered: an unusable link is never replaced by the guess.
    expect(
      refLink(
        null,
        { enabled: true, activate: null },
        "https://key.plrs.im",
        "djdl",
      ),
    ).toBeNull();
    expect(refLink(null, null, "https://key.plrs.im/", "djdl")).toBe(
      "https://polaris.locker/activate?product=djdl",
    );
  });
});
