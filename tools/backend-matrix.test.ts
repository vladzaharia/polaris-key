// The backend matrix's generator-side checks (plans/SP-53.md §4, WIRE-CONTRACT-V4 §14).
//
// The reference in tools/corpus/reference/backend.ts restates its constants as literals and
// imports nothing it checks; this test holds those literals equal to the published constants,
// proves the reference is not vacuous (a mutated passing row is refused at the step the mutation
// breaks), and checks the committed file's shape. client-core is checked against the file by the
// Node and browser runners and by packages/client-core/test/backend.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BACKEND_AUTH_SCHEME,
  BACKEND_LICENSE_MAX_BYTES,
  HEADER_DEVICE,
  HEADER_LICENSE,
  POLARIS_REQUEST_HEADERS,
} from "@polaris-key/protocol/core";
import { PAIRWISE_SUBJECT_PATTERN } from "@polaris-key/protocol/identity";
import {
  CLOCK_SKEW_SECONDS,
  REFRESH_MARGIN_SECONDS,
} from "@polaris-key/client-core/claims";
import {
  REF_AUTH_SCHEME,
  REF_BACKEND_STATUS,
  REF_HEADER_DEVICE,
  REF_HEADER_LICENSE,
  REF_LICENSE_MAX_BYTES,
  REF_LOCALES,
  REF_REFRESH_MARGIN,
  REF_SUBJECT_RE,
  refBackendLocale,
  refBackendVerdict,
  refClientBackendAction,
  refHeaderElements,
  type RefVerdictInput,
} from "./corpus/reference/backend.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX = JSON.parse(
  readFileSync(
    join(ROOT, "conformance", "corpus", "v2", "backend-matrix.json"),
    "utf8",
  ),
) as {
  backendMatrixVersion: number;
  verdict: {
    id: string;
    input: RefVerdictInput;
    expect: { status: number; code: string | null; context: unknown };
  }[];
  problem: { id: string; input: { code: string; acceptLanguage: string } }[];
  client: { id: string; expect: { action: string } }[];
};

describe("backend-matrix.json: the reference's literals are the published constants", () => {
  it("headers, size, scheme, subject pattern and refresh margin", () => {
    expect(REF_HEADER_LICENSE).toBe(HEADER_LICENSE);
    expect(REF_HEADER_DEVICE).toBe(HEADER_DEVICE);
    expect([REF_HEADER_LICENSE, REF_HEADER_DEVICE]).toEqual([
      ...POLARIS_REQUEST_HEADERS,
    ]);
    expect(REF_LICENSE_MAX_BYTES).toBe(BACKEND_LICENSE_MAX_BYTES);
    expect(REF_AUTH_SCHEME).toBe(BACKEND_AUTH_SCHEME);
    expect(REF_SUBJECT_RE.source).toBe(PAIRWISE_SUBJECT_PATTERN);
    expect(REF_REFRESH_MARGIN).toBe(REFRESH_MARGIN_SECONDS);
    expect(CLOCK_SKEW_SECONDS).toBe(300);
  });

  it("the locales are exactly the copy catalog's files, English first", () => {
    const files = readdirSync(join(ROOT, "conformance", "parity"))
      .filter((f) => /^copy\..+\.json$/.test(f) && f !== "copy.schema.json")
      .map((f) => f.slice("copy.".length, -".json".length))
      .sort();
    expect([...REF_LOCALES].sort()).toEqual(files);
    expect(REF_LOCALES[0]).toBe("en");
  });
});

describe("backend-matrix.json: the committed file", () => {
  it("is version 1 with every code, every locale and every action", () => {
    expect(MATRIX.backendMatrixVersion).toBe(1);
    for (const code of Object.keys(REF_BACKEND_STATUS)) {
      expect(
        MATRIX.verdict.some((r) => r.expect.code === code),
        code,
      ).toBe(true);
      for (const locale of REF_LOCALES)
        expect(
          MATRIX.problem.some(
            (r) => r.input.code === code && r.input.acceptLanguage === locale,
          ),
          `${code} ${locale}`,
        ).toBe(true);
    }
    for (const action of [
      "send",
      "refresh-then-send",
      "refresh-and-retry",
      "surface",
    ])
      expect(MATRIX.client.some((r) => r.expect.action === action)).toBe(true);
  });

  it("every verdict row still agrees with the reference", () => {
    for (const row of MATRIX.verdict)
      expect(refBackendVerdict(row.input), row.id).toEqual(row.expect);
  });
});

describe("backend-matrix.json: the reference is not vacuous (negative controls)", () => {
  const passing = MATRIX.verdict.filter(
    (r) => r.expect.status === 200 && !r.input.options.maxAgeSeconds,
  );
  const licenseOf = (r: RefVerdictInput) =>
    refHeaderElements(r.headers, REF_HEADER_LICENSE)[0]!;
  const withLicense = (r: RefVerdictInput, value: string): RefVerdictInput => ({
    ...r,
    headers: [
      ...r.headers.filter(([n]) => n.toLowerCase() !== "x-pkey-license"),
      [REF_HEADER_LICENSE, value],
    ],
  });

  it("has passing rows to mutate", () => {
    expect(passing.length).toBeGreaterThan(10);
  });

  for (const row of passing) {
    it(`${row.id}: a changed signature, a second field, a spoofed device and an expired clock are each refused`, () => {
      const jws = licenseOf(row.input);
      const [h, p, s] = jws.split(".") as [string, string, string];
      const flipped = `${h}.${p}.${s.slice(0, 20)}${s[20] === "A" ? "B" : "A"}${s.slice(21)}`;
      expect(refBackendVerdict(withLicense(row.input, flipped)).code).toBe(
        "license_invalid",
      );
      expect(
        refBackendVerdict({
          ...row.input,
          headers: [...row.input.headers, [REF_HEADER_LICENSE, jws]],
        }).code,
      ).toBe("license_invalid");
      expect(
        refBackendVerdict({
          ...row.input,
          headers: [
            ...row.input.headers.filter(
              ([n]) => n.toLowerCase() !== "x-pkey-device",
            ),
            [REF_HEADER_DEVICE, "dev_attacker"],
          ],
        }).code,
      ).toBe("license_invalid");
      const issuedAt = (row.expect.context as { license: { issuedAt: number } })
        .license.issuedAt;
      expect(
        refBackendVerdict({ ...row.input, now: issuedAt + 3600 * 24 * 400 })
          .code,
      ).toBe("license_stale");
      // Another product's trust set never verifies it.
      expect(
        refBackendVerdict({
          ...row.input,
          options: { ...row.input.options, products: ["nobody"] },
          trust: { nobody: Object.values(row.input.trust)[0]! },
        }).code,
      ).toBe("license_invalid");
    });
  }
});

describe("the reference's locale and client rules", () => {
  it("negotiates Accept-Language", () => {
    expect(refBackendLocale(null)).toBe("en");
    expect(refBackendLocale("de-CH, en;q=0.1")).toBe("de");
    expect(refBackendLocale("zh-HK")).toBe("en");
    expect(refBackendLocale("zh-Hans-CN")).toBe("zh-Hans");
    expect(refBackendLocale("ko;q=0.001, ja;q=0.002")).toBe("ja");
    expect(refBackendLocale("ja;q=1.0001")).toBe("en");
  });

  it("retries once and only on a 401 with a stale or invalid licence", () => {
    const base = {
      document: { issuedAt: 0, expiresAt: 3600 },
      now: 100,
      retried: false,
    };
    expect(
      refClientBackendAction({
        ...base,
        response: { status: 401, code: "license_invalid" },
      }),
    ).toBe("refresh-and-retry");
    expect(
      refClientBackendAction({
        ...base,
        response: { status: 403, code: "sign_in_required" },
      }),
    ).toBe("surface");
  });
});
