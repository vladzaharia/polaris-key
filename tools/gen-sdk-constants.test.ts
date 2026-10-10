import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STORE_BACKENDS,
  STORE_DEGRADED_REASONS,
} from "@polaris-key/client-core/store";
import { ARCH_SPELLINGS, PLATFORM_SPELLINGS } from "@polaris-key/protocol/core";
import type { LicenseStatus } from "@polaris-key/protocol/license";
import {
  buildModel,
  camelName,
  CHANNEL_EXPORT,
  SPELLINGS_EXPORT,
  checkCoverage,
  checkStageCoverage,
  compileSchema,
  COPY_PLACEHOLDERS,
  COPY_TARGETS,
  loadSources,
  pascalToUpper,
  readWorkerSource,
  renderAll,
  renderCopyGdscript,
  renderCopyKotlin,
  renderCopyPython,
  renderCopySwift,
  renderCopyTs,
  renderGdscript,
  renderKotlin,
  ktq,
  renderPython,
  renderSwift,
  renderTs,
  run,
  scanStageMatrix,
  scanWorkerSource,
  TARGETS,
  upperName,
  validateCopy,
  validateCopyLocale,
  validateEnums,
  validateErrors,
  VALUES_ONLY_ENUMS,
  words,
  type CopyDoc,
  type Sources,
} from "./gen-sdk-constants.js";
import { capabilityDigest } from "./capabilities.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARITY = join(ROOT, "conformance", "parity");
const SOURCES = loadSources();
const MODEL = buildModel(SOURCES);
const RENDERERS = {
  ts: renderTs,
  python: renderPython,
  swift: renderSwift,
  gdscript: renderGdscript,
  kotlin: renderKotlin,
};

const withSources = (patch: Partial<Sources>): Sources => ({
  ...SOURCES,
  ...patch,
});

describe("the sources", () => {
  it("errors.json and enums.json satisfy their schemas and rules", () => {
    const errors = JSON.parse(
      readFileSync(join(PARITY, "errors.json"), "utf8"),
    );
    const enums = JSON.parse(readFileSync(join(PARITY, "enums.json"), "utf8"));
    expect(compileSchema(join(PARITY, "errors.schema.json"))(errors)).toEqual(
      [],
    );
    expect(compileSchema(join(PARITY, "enums.schema.json"))(enums)).toEqual([]);
    expect(validateErrors(errors)).toEqual([]);
    expect(validateEnums(enums)).toEqual([]);
  });

  it("the schemas reject a bad kind, a bad code and an empty enum", () => {
    const errorsSchema = compileSchema(join(PARITY, "errors.schema.json"));
    const entry = {
      code: "x",
      kind: "wire",
      service: "core",
      description: "d",
    };
    const doc = (e: object) => ({ registryVersion: 1, codes: [e] });
    expect(errorsSchema(doc(entry))).toEqual([]);
    expect(errorsSchema(doc({ ...entry, kind: "server" }))).not.toEqual([]);
    expect(errorsSchema(doc({ ...entry, code: "Not_A_Code" }))).not.toEqual([]);
    expect(errorsSchema(doc({ ...entry, service: "admin" }))).not.toEqual([]);
    const enumsSchema = compileSchema(join(PARITY, "enums.schema.json"));
    expect(
      enumsSchema({ enums: [{ name: "x", description: "d", values: [] }] }),
    ).not.toEqual([]);
  });

  it("rejects a duplicate code or enum", () => {
    const e = { code: "x", kind: "wire", service: "core", description: "d" };
    expect(
      validateErrors({ registryVersion: 1, codes: [e, { ...e }] as never }),
    ).toEqual(['duplicate code "x"']);
    const d = { name: "x", description: "d", values: ["a"] };
    expect(validateEnums({ enums: [d, d] })).toEqual(['duplicate enum "x"']);
  });

  it("platform and arch are README §3.1's header values, without universal and any", () => {
    const byName = Object.fromEntries(
      SOURCES.enums.map((e) => [e.name, e.values]),
    );
    expect(byName.platform).toEqual([
      "macos",
      "ios",
      "android",
      "windows",
      "linux",
      "web",
      "tvos",
      "visionos",
      "watchos",
    ]);
    expect(byName.arch).toEqual(["arm64", "x86_64", "armv7", "wasm32"]);
  });

  it("platform and arch equal the values of PLATFORM_SPELLINGS and ARCH_SPELLINGS, each mapping to itself (§5.2)", () => {
    const byName = Object.fromEntries(
      SOURCES.enums.map((e) => [e.name, e.values]),
    );
    for (const [name, table] of [
      ["platform", PLATFORM_SPELLINGS],
      ["arch", ARCH_SPELLINGS],
    ] as const) {
      const values: Record<string, string> = table;
      expect(new Set(Object.values(values))).toEqual(new Set(byName[name]));
      for (const v of byName[name]!) expect(values[v]).toBe(v);
    }
    expect(byName.sdkId).toEqual([
      "node",
      "react",
      "python",
      "swift",
      "godot",
      "kotlin",
    ]);
  });

  it("storeBackend and storeDegradedReason equal client-core's STORE_BACKENDS and STORE_DEGRADED_REASONS", () => {
    const byName = Object.fromEntries(
      SOURCES.enums.map((e) => [e.name, e.values]),
    );
    expect(byName.storeBackend).toEqual([...STORE_BACKENDS]);
    expect(byName.storeDegradedReason).toEqual([...STORE_DEGRADED_REASONS]);
  });

  it("licenseStatus equals LicenseStatus (@polaris-key/protocol/license), through an exhaustive map", () => {
    // A LicenseStatus member added or removed fails to compile here, and a value in enums.json
    // that is not a member fails the comparison.
    const EVERY: { [K in LicenseStatus]: true } = {
      ok: true,
      grace: true,
      expired: true,
      revoked: true,
      "needs-activation": true,
      "version-too-old": true,
      "version-too-new": true,
      "channel-not-entitled": true,
      "not-applicable": true,
    };
    const byName = Object.fromEntries(
      SOURCES.enums.map((e) => [e.name, e.values]),
    );
    expect([...byName.licenseStatus!].sort()).toEqual(
      Object.keys(EVERY).sort(),
    );
  });

  it("activationResult is SDK-PARITY-PASS §3.1's thirteen kinds and PX-W9's key-entry-limit, in kebab form", () => {
    const byName = Object.fromEntries(
      SOURCES.enums.map((e) => [e.name, e.values]),
    );
    expect(byName.activationResult).toEqual([
      "ok",
      "device-limit",
      "fingerprint-required",
      "hardware-mismatch",
      "enroll-claimed",
      "license-disabled",
      "license-expired",
      "attestation-required",
      "rate-limited",
      "unauthorized",
      "enroll-disabled",
      // PX-W9 (WIRE-CONTRACT-V4 §12.2): the `key_entry_limit` refusal.
      "key-entry-limit",
      "refused",
      "error",
    ]);
  });

  it("reads the corpus versions and the protocol version", () => {
    expect(SOURCES.corpus).toEqual({
      corpusVersion: 2,
      gateMatrixVersion: 2,
      fingerprintVersion: 1,
      stageMatrixVersion: 3,
      updateMatrixVersion: 1,
      outletMatrixVersion: 1,
      planMatrixVersion: 2,
      syncScenariosVersion: 2,
      deviceLabelVersion: 1,
      presentationMatrixVersion: 1,
      uiMatrixVersion: 1,
      contentCorpusVersion: 2,
    });
    expect(SOURCES.protocol.PROTOCOL_VERSION).toBe(4);
    // PX-W13: the identity subpath's constants ride along with core's.
    expect(SOURCES.protocol.DEVICE_LABEL_MAX_CODEPOINTS).toBe(64);
    expect(SOURCES.protocol.REQUEST_HANDLE_TTL_SECONDS).toBe(600);
    expect(SOURCES.protocol.MAX_WIRE_INTEGER).toBe(Number.MAX_SAFE_INTEGER);
    expect(SOURCES.protocol.MAX_JSON_DEPTH).toBe(64);
    expect(SOURCES.protocol.MAX_RECORD_JWS_BYTES).toBe(88844);
    // HA-12: the presentation limits (WIRE-CONTRACT-V4 §5.5).
    expect(SOURCES.protocol.PRESENTATION_TEXT_MAX_BYTES).toBe(1024);
    expect(SOURCES.protocol.PRESENTATION_ICON_TYPES).toEqual([
      "image/avif",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });
});

describe("the source test: errors.json against the Worker", () => {
  const SRC = readWorkerSource();

  it("every wire code the Worker emits is registered, and every registered wire code is emitted", () => {
    const scanned = scanWorkerSource(SRC);
    // The three sources gen-reference.mjs reads, plus the call sites.
    for (const code of [
      "license_expired", // PolarisErrorCode only
      "managed_by_admin", // the Worker's ErrorCode only
      "oidc_error", // an errorResponse(…) call site only
      "registration_closed", // a wireError(…) call site
      "upstream_rate_limited", // an `error:` literal
    ])
      expect(scanned.has(code), code).toBe(true);
    expect(checkCoverage(SOURCES.errors, scanned)).toEqual([]);
  });

  it('fails when a new errorResponse(…, "new_code") appears without an entry (fixture)', () => {
    const fixture = {
      path: "packages/worker/src/services/license/fixture.ts",
      text: [
        "export function handler(): Response {",
        '  if (a) return errorResponse(409, "new_code", "a new refusal");',
        "  if (b)",
        "    return wireError(",
        "      418,",
        '      "another_new_code",',
        "    );",
        '  return errorResponse(400, "bad_request");',
        "}",
      ].join("\n"),
    };
    const problems = checkCoverage(
      SOURCES.errors,
      scanWorkerSource({ ...SRC, files: [...SRC.files, fixture] }),
    );
    expect(problems).toEqual([
      expect.stringContaining(
        `emits "new_code" (packages/worker/src/services/license/fixture.ts:2)`,
      ),
      expect.stringContaining(
        `emits "another_new_code" (packages/worker/src/services/license/fixture.ts:4)`,
      ),
    ]);
  });

  it("resolves ErrorCode.<Member> call sites, and refuses an unknown member", () => {
    const call = (member: string) => ({
      path: "f.ts",
      text: `return errorResponse(403, ErrorCode.${member});`,
    });
    const scanned = scanWorkerSource({
      ...SRC,
      files: [call("EnrollClaimed")],
    });
    expect(scanned.get("enroll_claimed")).toContain("f.ts:1");
    expect(() =>
      scanWorkerSource({ ...SRC, files: [call("NoSuchMember")] }),
    ).toThrow(/ErrorCode\.NoSuchMember is not a member/);
  });

  it("fails when a wire entry is no longer emitted, or a wire code is marked client", () => {
    const scanned = scanWorkerSource(SRC);
    const stale = [
      ...SOURCES.errors,
      {
        code: "retired_code",
        kind: "wire" as const,
        service: "core",
        description: "d",
      },
    ];
    expect(checkCoverage(stale, scanned)).toEqual([
      expect.stringContaining(`wire code "retired_code"`),
    ]);
    const mislabelled = SOURCES.errors.map((e) =>
      e.code === "not_found" ? { ...e, kind: "client" as const } : e,
    );
    expect(checkCoverage(mislabelled, scanned)).toEqual([
      expect.stringContaining(`"not_found" is emitted by the Worker`),
    ]);
  });
});

describe("the source test: errors.json against the boot stage machine", () => {
  const MATRIX = JSON.parse(
    readFileSync(
      join(ROOT, "conformance", "corpus", "v2", "stage-matrix.json"),
      "utf8",
    ),
  ) as { rows: unknown[] };
  const failRow = (code: string, emitted: string) => ({
    name: "fixture",
    init: {},
    steps: [
      {
        event: { type: "fail", code },
        emits: [
          { type: "stage_changed", stage: "error", previous: "sync" },
          { type: "error", code: emitted },
        ],
      },
    ],
    expect: {},
  });

  it("every code the stage machine originates is registered as a client code", () => {
    const scanned = scanStageMatrix(MATRIX);
    expect([...scanned.keys()].sort()).toEqual(["fetch-failed", "sync-failed"]);
    expect(checkStageCoverage(SOURCES.errors, scanned)).toEqual([]);
  });

  it("a host's fail code echoed back is the host's, not the SDK's", () => {
    const scanned = scanStageMatrix({ rows: [failRow("my-code", "my-code")] });
    expect(scanned.size).toBe(0);
  });

  it("fails when a new stage error code appears without an entry, or is marked wire (fixture)", () => {
    const scanned = scanStageMatrix({
      rows: [...MATRIX.rows, failRow("host-code", "pack-failed")],
    });
    expect(checkStageCoverage(SOURCES.errors, scanned)).toEqual([
      expect.stringContaining(
        `emits "pack-failed" (stage-matrix.json rows[${MATRIX.rows.length}].steps[0])`,
      ),
    ]);
    const mislabelled = SOURCES.errors.map((e) =>
      e.code === "sync-failed" ? { ...e, kind: "wire" as const } : e,
    );
    expect(checkStageCoverage(mislabelled, scanStageMatrix(MATRIX))).toEqual([
      expect.stringContaining(
        `"sync-failed" is emitted by the boot stage machine`,
      ),
    ]);
  });
});

describe("identifiers", () => {
  it("map deterministically", () => {
    expect(words("license.channels")).toEqual(["license", "channels"]);
    expect(camelName(words("service-unavailable"))).toBe("serviceUnavailable");
    expect(camelName(words("device_limit"))).toBe("deviceLimit");
    expect(camelName(words("core.errors"))).toBe("coreErrors");
    expect(camelName(words("x86_64"))).toBe("x86_64");
    expect(upperName(words("sign-in-failed"))).toBe("SIGN_IN_FAILED");
    expect(upperName(words("license.channels"))).toBe("LICENSE_CHANNELS");
    expect(pascalToUpper("UnsupportedReason")).toBe("UNSUPPORTED_REASON");
  });

  it("the generator fails on a collision", () => {
    const errors = [
      ...SOURCES.errors,
      {
        code: "sign_in_failed",
        kind: "client" as const,
        service: "identity",
        description: "d",
      },
    ];
    expect(() => buildModel(withSources({ errors }))).toThrow(
      /ErrorCode: "sign-in-failed" and "sign_in_failed" both map to the camelCase identifier "signInFailed"/,
    );
    const enums = [
      ...SOURCES.enums,
      { name: "platform", description: "again", values: ["a"] },
    ];
    expect(() => buildModel(withSources({ enums }))).toThrow(
      /two groups are named Platform/,
    );
  });

  it("writes a member that would shadow a Godot native class with a trailing underscore, in GDScript only", () => {
    const enums = [{ name: "ext", description: "d", values: ["json", "csv"] }];
    const model = buildModel(withSources({ enums }));
    const gd = renderGdscript(model);
    expect(gd).toContain('const JSON_ := "json"');
    expect(gd).not.toContain('const JSON := "json"');
    expect(renderPython(model)).toContain('JSON: Final = "json"');
  });

  it("refuses a GDScript built-in constant", () => {
    const enums = [{ name: "number", description: "d", values: ["inf"] }];
    expect(() => buildModel(withSources({ enums }))).toThrow(
      /GDScript built-in/,
    );
  });
});

describe("renderers", () => {
  it("carry the GENERATED banner", () => {
    for (const render of Object.values(RENDERERS))
      expect(render(MODEL)).toContain("GENERATED FILE — do not edit by hand.");
  });

  it("name members per PARITY §2.1: camelCase in TS and Swift, UPPER_SNAKE in Python and GDScript", () => {
    const ts = renderTs(MODEL);
    expect(ts).toContain('serviceUnavailable: "service-unavailable",');
    expect(ts).toContain('licenseChannels: "license.channels",');
    expect(ts).toContain('macos: "macos",');
    expect(ts).toContain('x86_64: "x86_64",');
    expect(ts).toContain('sdkName: "X-PKey-SDK",');
    expect(ts).toContain("export const PROTOCOL_VERSION = 4;");
    expect(ts).toContain('"local-only": "client",');

    const py = renderPython(MODEL);
    expect(py).toContain(
      '    SERVICE_UNAVAILABLE: Final = "service-unavailable"',
    );
    expect(py).toContain('    LICENSE_CHANNELS: Final = "license.channels"');
    expect(py).toContain('    SDK_NAME: Final = "X-PKey-SDK"');
    expect(py).toContain("PROTOCOL_VERSION: Final[int] = 4");

    const swift = renderSwift(MODEL);
    expect(swift).toContain(
      'public static let serviceUnavailable = "service-unavailable"',
    );
    expect(swift).toContain('public static let x86_64 = "x86_64"');
    expect(swift).toContain("public let PROTOCOL_VERSION = 4");

    const kt = renderKotlin(MODEL);
    expect(kt).toContain("package im.plrs.key.core");
    expect(kt).toContain(
      '    public const val serviceUnavailable: String = "service-unavailable"',
    );
    expect(kt).toContain('    public const val x86_64: String = "x86_64"');
    expect(kt).toContain("public const val PROTOCOL_VERSION: Int = 4");
    expect(kt).toContain(
      "public const val MAX_WIRE_INTEGER: Long = 9007199254740991L",
    );

    const gd = renderGdscript(MODEL);
    expect(gd).toContain("class_name PKeyConstants");
    expect(gd).toContain(
      '\tconst SERVICE_UNAVAILABLE := "service-unavailable"',
    );
    expect(gd).toContain("const PROTOCOL_VERSION := 4");
  });

  it("Swift leaves StoreBackend and StoreDegradedReason to Store.swift; the others emit them", () => {
    for (const name of ["StoreBackend", "StoreDegradedReason"]) {
      expect(renderSwift(MODEL)).not.toMatch(
        new RegExp(`public enum ${name} `),
      );
      expect(renderTs(MODEL)).toContain(`export const ${name} = {`);
      expect(renderPython(MODEL)).toContain(`class ${name}:`);
      expect(renderGdscript(MODEL)).toContain(`class ${name}:`);
    }
  });

  it("a values-only enum emits its *_VALUES list and no type, in every language", () => {
    expect([...VALUES_ONLY_ENUMS]).toEqual([
      "licenseStatus",
      "activationResult",
    ]);
    for (const [name, list] of [
      ["LicenseStatus", "LICENSE_STATUS_VALUES"],
      ["ActivationResult", "ACTIVATION_RESULT_VALUES"],
    ] as const) {
      const ts = renderTs(MODEL);
      expect(ts).toContain(`export const ${list}: readonly string[] = [`);
      expect(ts).not.toMatch(new RegExp(`export (const|type) ${name}\\b`));
      const py = renderPython(MODEL);
      expect(py).toContain(`${list}: Tuple[str, ...] = (`);
      expect(py).not.toContain(`class ${name}:`);
      expect(py).not.toContain(`"${name}",`);
      expect(renderSwift(MODEL)).toContain(`public let ${list}: [String] = [`);
      expect(renderSwift(MODEL)).not.toMatch(new RegExp(`enum ${name}\\b`));
      expect(renderGdscript(MODEL)).toContain(`const ${list} := [`);
      expect(renderGdscript(MODEL)).not.toContain(`class ${name}:`);
      expect(renderKotlin(MODEL)).toContain(
        `public val ${list}: List<String> = listOf(`,
      );
      expect(renderKotlin(MODEL)).not.toMatch(new RegExp(`object ${name}\\b`));
    }
  });

  it("Swift and Kotlin leave ServiceSlug to their gen services files; the others emit it", () => {
    expect(renderSwift(MODEL)).not.toMatch(/public enum ServiceSlug/);
    expect(renderKotlin(MODEL)).not.toMatch(/public object ServiceSlug/);
    expect(renderKotlin(MODEL)).toContain("public object StoreBackend {");
    expect(renderTs(MODEL)).toContain("export const ServiceSlug = {");
    expect(renderPython(MODEL)).toContain("class ServiceSlug:");
    expect(renderGdscript(MODEL)).toContain("class ServiceSlug:");
  });

  it("back-ticks a Kotlin keyword and escapes a Kotlin template", () => {
    const enums = [{ name: "mode", description: "d", values: ["in"] }];
    const kt = renderKotlin(buildModel(withSources({ enums })));
    expect(kt).toContain('public const val `in`: String = "in"');
    expect(ktq("^[a-z]$")).toBe('"^[a-z]\\$"');
    expect(renderKotlin(MODEL)).toContain(
      'public const val CHANNEL_NAME_PATTERN: String = "^[a-z0-9][a-z0-9-]{0,63}\\$"',
    );
  });

  it("back-ticks a Swift keyword", () => {
    const enums = [{ name: "mode", description: "d", values: ["default"] }];
    expect(renderSwift(buildModel(withSources({ enums })))).toContain(
      'public static let `default` = "default"',
    );
  });

  it("a new error code or enum value reaches every language", () => {
    const errors = [
      ...SOURCES.errors,
      {
        code: "chunks.hash-mismatch",
        kind: "client" as const,
        service: "distribution",
        description: "d",
      },
    ];
    // A new code needs its copy too (validateCopy refuses the gap at load).
    const copy = {
      ...SOURCES.copy!,
      codes: {
        ...SOURCES.copy!.codes,
        "chunks.hash-mismatch": { title: "T", message: "M" },
      },
    };
    const model = buildModel(withSources({ errors, copy }));
    expect(renderTs(model)).toContain(
      'chunksHashMismatch: "chunks.hash-mismatch"',
    );
    expect(renderCopyTs(model)).toContain('"chunks.hash-mismatch": {');
    expect(renderPython(model)).toContain(
      'CHUNKS_HASH_MISMATCH: Final = "chunks.hash-mismatch"',
    );
    expect(renderSwift(model)).toContain(
      'static let chunksHashMismatch = "chunks.hash-mismatch"',
    );
    expect(renderGdscript(model)).toContain(
      'const CHUNKS_HASH_MISMATCH := "chunks.hash-mismatch"',
    );
  });

  it("P0-04's channel constants flow through from @polaris-key/protocol/core", () => {
    const protocol = {
      ...SOURCES.protocol,
      CHANNEL_STABLE: "stable",
      CHANNEL_ALIASES: { staging: "beta", latest: "stable" },
      CHANNEL_NAME_PATTERN: "^[a-z0-9][a-z0-9-]{0,63}$",
      PR_CHANNEL_PATTERN: "^pr-?([0-9]+)$",
      PR_NUMBER_MAX_DIGITS: 7,
    };
    const model = buildModel(withSources({ protocol }));
    const ts = renderTs(model);
    expect(ts).toContain('export const CHANNEL_STABLE = "stable";');
    expect(ts).toContain("export const PR_NUMBER_MAX_DIGITS = 7;");
    expect(ts).toContain('"staging": "beta",');
    expect(ts).toContain(
      'export const CHANNEL_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";',
    );
    expect(renderPython(model)).toContain(
      "CHANNEL_ALIASES: Mapping[str, str] = MappingProxyType(",
    );
    expect(renderSwift(model)).toContain(
      'public let PR_CHANNEL_PATTERN = "^pr-?([0-9]+)$"',
    );
    expect(renderGdscript(model)).toContain("const PR_NUMBER_MAX_DIGITS := 7");
    // HEADER_CHANNEL is a header, not a channel constant.
    expect(CHANNEL_EXPORT.test("HEADER_CHANNEL")).toBe(false);
    expect(() =>
      buildModel(
        withSources({ protocol: { ...protocol, CHANNEL_FN: () => "x" } }),
      ),
    ).toThrow(/cannot render/);
  });
});

describe("the capability table (P1b-10)", () => {
  it("every target carries its own SDK's table, and the digest parity:check recomputes", () => {
    const registry = JSON.parse(
      readFileSync(join(PARITY, "features.json"), "utf8"),
    ) as { sdks: { id: string; manifest: string }[] };
    expect(TARGETS.map((t) => t.sdk).sort()).toEqual(
      registry.sdks.map((s) => s.id).sort(),
    );
    for (const target of TARGETS) {
      const caps = MODEL.capabilities[target.sdk];
      expect(caps, target.sdk).toBeDefined();
      const text = target.render(MODEL, caps);
      expect(text).toContain(capabilityDigest(caps!));
      expect(text).toContain(`CAPABILITY_SDK`);
      expect(text).toMatch(/CAPABILITIES|static func capabilities\(\)/);
    }
  });

  it("renders a row per registry feature, with its N/As, in every language", () => {
    const caps = MODEL.capabilities["react"]!;
    expect(caps.rows.map((r) => r.feature)).toEqual(SOURCES.features);
    const secret = caps.rows.find((r) => r.feature === "config.secret")!;
    expect(secret).toEqual({
      feature: "config.secret",
      status: "na",
      service: "config",
      na: [
        { runtime: "web", reason: "runtime" },
        { runtime: "desktop-bridge", reason: "runtime" },
      ],
    });
    expect(renderTs(MODEL, caps)).toContain(
      `"config.secret": { status: "na", service: "config", na: [{ runtime: "web", reason: "runtime" }, { runtime: "desktop-bridge", reason: "runtime" }] },`,
    );
    expect(renderPython(MODEL, caps)).toContain(
      `"config.secret": CapabilityRow("na", "config", (CapabilityNa("web", "runtime"), CapabilityNa("desktop-bridge", "runtime"),)),`,
    );
    expect(renderSwift(MODEL, caps)).toContain(
      `"config.secret": CapabilityRow(status: "na", service: "config", na: [CapabilityNa(runtime: "web", reason: "runtime"), CapabilityNa(runtime: "desktop-bridge", reason: "runtime")]),`,
    );
    expect(renderGdscript(MODEL, caps)).toContain(
      `"config.secret": {"status": "na", "service": "config", "na": [{"runtime": "web", "reason": "runtime"}, {"runtime": "desktop-bridge", "reason": "runtime"}]},`,
    );
  });

  it("a renderer without a table emits none", () => {
    for (const render of Object.values(RENDERERS))
      expect(render(MODEL)).not.toContain("CAPABILITY_DIGEST");
  });
});

describe("the header-value tables and SdkId", () => {
  it("reach every renderer", () => {
    expect(SPELLINGS_EXPORT.test("PLATFORM_SPELLINGS")).toBe(true);
    expect(SPELLINGS_EXPORT.test("ARCH_SPELLINGS")).toBe(true);
    expect(SPELLINGS_EXPORT.test("CHANNEL_ALIASES")).toBe(false);
    const ts = renderTs(MODEL);
    expect(ts).toContain("export const PLATFORM_SPELLINGS = {");
    expect(ts).toContain('"darwin": "macos",');
    expect(ts).toContain("export const ARCH_SPELLINGS = {");
    expect(ts).toContain('"x64": "x86_64",');
    expect(ts).toContain("export const SdkId = {");
    expect(ts).toContain('  node: "node",');
    const py = renderPython(MODEL);
    expect(py).toContain(
      "PLATFORM_SPELLINGS: Mapping[str, str] = MappingProxyType(",
    );
    expect(py).toContain(
      "ARCH_SPELLINGS: Mapping[str, str] = MappingProxyType(",
    );
    expect(py).toContain("class SdkId");
    const swift = renderSwift(MODEL);
    expect(swift).toContain("public let PLATFORM_SPELLINGS");
    expect(swift).toContain("public let ARCH_SPELLINGS");
    expect(swift).toContain("SdkId");
    const gd = renderGdscript(MODEL);
    expect(gd).toContain("const PLATFORM_SPELLINGS");
    expect(gd).toContain("const ARCH_SPELLINGS");
    expect(gd).toContain("SdkId");
  });
});

describe("gen constants --check", () => {
  it("the committed files are up to date", async () => {
    expect(await run({ check: true })).toEqual([]);
  });

  it("reports a hand edit to any generated file, and does not write under --check", async () => {
    const root = mkdtempSync(join(tmpdir(), "gen-constants-"));
    mkdirSync(join(root, "sdks/godot/addons/polaris_key"), { recursive: true });
    const rendered = await renderAll(MODEL, root);
    expect([...rendered.keys()]).toEqual(
      [...TARGETS, ...COPY_TARGETS].map((t) => t.path),
    );
    for (const [path, content] of rendered) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    expect(await run({ check: true, root, model: MODEL })).toEqual([]);

    // One hand edit in every generated file at once, then one --check run and one write run:
    // each run must name every edited file (so no family's edit goes unreported), --check must
    // leave every edit in place, and the write run must restore every original byte.
    const all = [...TARGETS, ...COPY_TARGETS];
    const originals = new Map<string, string>();
    for (const target of all) {
      const abs = join(root, target.path);
      const original = readFileSync(abs, "utf8");
      const edited = original.replace("service-unavailable", "service-gone");
      expect(edited, target.path).not.toBe(original);
      originals.set(target.path, original);
      writeFileSync(abs, edited);
    }
    const paths = all.map((t) => t.path);
    expect(await run({ check: true, root, model: MODEL })).toEqual(paths);
    for (const [path, original] of originals) {
      expect(readFileSync(join(root, path), "utf8"), path).not.toBe(original);
    }
    expect(await run({ check: false, root, model: MODEL })).toEqual(paths);
    for (const [path, original] of originals) {
      expect(readFileSync(join(root, path), "utf8"), path).toBe(original);
    }
  }, 30_000);

  it("skips the GDScript module while sdks/godot/addons/polaris_key does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "gen-constants-nogodot-"));
    const rendered = await renderAll(MODEL, root);
    expect([...rendered.keys()]).not.toContain(
      "sdks/godot/addons/polaris_key/core/constants_generated.gd",
    );
    expect([...rendered.keys()]).not.toContain(
      "sdks/godot/addons/polaris_key/core/copy_generated.gd",
    );
    expect(rendered.size).toBe(TARGETS.length + COPY_TARGETS.length - 2);
  });
});

describe("the translated core packs (plans/UK-02.md D4)", () => {
  const COPY = SOURCES.copy!;
  const pack = () => ({
    ...(JSON.parse(JSON.stringify(COPY)) as CopyDoc),
    locale: "de",
    reviewed: false,
  });

  it("accepts every committed copy.<locale>.json (loadSources checks them all)", () => {
    expect(() => loadSources()).not.toThrow();
  });

  it("accepts a pack with English's keys and placeholders", () => {
    expect(validateCopyLocale(pack(), COPY, "de")).toEqual([]);
  });

  it("refuses a wrong locale, a missing reviewed flag, a missing key and a changed placeholder", () => {
    const bad = pack() as CopyDoc & { reviewed?: boolean };
    bad.locale = "fr";
    delete bad.reviewed;
    delete bad.codes.device_limit;
    bad.fallback = { ...bad.fallback, message: "Fehler ({detail})." };
    expect(validateCopyLocale(bad, COPY, "de")).toEqual([
      'locale is "fr", not "de"',
      "a translated pack states reviewed: true or false",
      "fallback.message: placeholders {detail} differ from English {code}",
      'codes: no entry for "device_limit" (copy.en.json)',
    ]);
  });
});

describe("the core copy (core.copy, plans/SP-00.md §4)", () => {
  const COPY = SOURCES.copy!;
  const clone = (): CopyDoc => JSON.parse(JSON.stringify(COPY)) as CopyDoc;
  const check = (doc: CopyDoc): string[] =>
    validateCopy(doc, {
      codes: SOURCES.errors.map((e) => e.code),
      enums: SOURCES.enums,
    });

  it("copy.en.json satisfies its schema and covers every code, licenseStatus and activationResult", () => {
    expect(
      compileSchema(join(PARITY, "copy.schema.json"))(
        JSON.parse(readFileSync(join(PARITY, "copy.en.json"), "utf8")),
      ),
    ).toEqual([]);
    expect(check(COPY)).toEqual([]);
    expect(Object.keys(COPY.codes).sort()).toEqual(
      SOURCES.errors.map((e) => e.code).sort(),
    );
  });

  it("refuses a missing or an extra code", () => {
    const missing = clone();
    delete missing.codes.device_limit;
    expect(check(missing)).toEqual([
      'codes: no entry for "device_limit" (errors.json)',
    ]);
    const extra = clone();
    extra.codes.made_up = { title: "T", message: "M" };
    expect(check(extra)).toEqual(['codes: "made_up" is not in errors.json']);
  });

  it("refuses gate keys that are not licenseStatus, and activation keys that are not activationResult", () => {
    const gate = clone();
    delete gate.gate.grace;
    gate.gate.lapsed = { title: "T", message: "M" };
    expect(check(gate)).toEqual([
      'gate: no entry for "grace" (enums.json licenseStatus)',
      'gate: "lapsed" is not in enums.json licenseStatus',
    ]);
    const activation = clone();
    delete activation.activation["rate-limited"];
    expect(check(activation)).toEqual([
      'activation: no entry for "rate-limited" (enums.json activationResult)',
    ]);
  });

  it("allows only the closed placeholder set, and no stray brace", () => {
    expect([...COPY_PLACEHOLDERS]).toEqual([
      "code",
      "detail",
      "limit",
      "deviceCount",
      "retryAfterSeconds",
      "product",
    ]);
    const ok = clone();
    ok.activation["device-limit"]!.message =
      "{product}: {deviceCount} of {limit} devices; wait {retryAfterSeconds}s ({code}, {detail}).";
    expect(check(ok)).toEqual([]);
    const bad = clone();
    bad.codes.device_limit!.message = "Used {seats} of {limit}.";
    bad.gate.ok!.title = "Active }";
    expect(check(bad)).toEqual([
      "codes.device_limit.message: unknown placeholder {seats} (allowed: {code}, {detail}, {limit}, {deviceCount}, {retryAfterSeconds}, {product})",
      "gate.ok.title: a brace that is not part of a {placeholder}",
    ]);
  });

  it("one separate copy module per SDK, at the paths the plan names", () => {
    expect(COPY_TARGETS.map((t) => [t.sdk, t.path])).toEqual([
      ["node", "packages/sdk-node/src/copy.generated.ts"],
      ["react", "packages/sdk-react/src/copy.generated.ts"],
      ["python", "sdks/python/src/polaris_key/copy_generated.py"],
      ["swift", "sdks/swift/Sources/PolarisKeyCore/Copy.generated.swift"],
      ["godot", "sdks/godot/addons/polaris_key/core/copy_generated.gd"],
      [
        "kotlin",
        "sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/Copy.generated.kt",
      ],
    ]);
  });

  it("every module carries every entry, in its language's names", () => {
    const sample = COPY.codes.device_limit!;
    const renders = {
      ts: renderCopyTs(MODEL),
      python: renderCopyPython(MODEL),
      swift: renderCopySwift(MODEL),
      gdscript: renderCopyGdscript(MODEL),
      kotlin: renderCopyKotlin(MODEL),
    };
    for (const [lang, text] of Object.entries(renders)) {
      expect(text, lang).toContain("GENERATED FILE");
      for (const name of [
        "COPY_VERSION",
        "COPY_LOCALE",
        "COPY_PLACEHOLDERS",
        "COPY_FALLBACK",
        "COPY_CODES",
        "COPY_GATE",
        "COPY_ACTIVATION",
      ])
        expect(text, `${lang} ${name}`).toContain(name);
      for (const code of SOURCES.errors.map((e) => e.code))
        expect(text, `${lang} ${code}`).toContain(JSON.stringify(code));
      expect(text, lang).toContain(JSON.stringify(sample.message));
    }
    expect(renders.ts).toContain(
      `"device_limit": { title: ${JSON.stringify(sample.title)}, message: ${JSON.stringify(sample.message)} },`,
    );
    expect(renders.python).toContain(
      `"device_limit": CopyEntry(${JSON.stringify(sample.title)}, ${JSON.stringify(sample.message)}),`,
    );
    expect(renders.swift).toContain(
      `"device_limit": CopyEntry(title: ${JSON.stringify(sample.title)}, message: ${JSON.stringify(sample.message)}),`,
    );
    expect(renders.gdscript).toContain("class_name PKeyCoreCopy");
    expect(renders.kotlin).toContain("package im.plrs.key.core");
    expect(renders.kotlin).toContain(
      `"device_limit" to CopyEntry(${JSON.stringify(sample.title)}, ${JSON.stringify(sample.message)}),`,
    );
  });

  it("a model without copy renders no copy module", async () => {
    const { copy: _copy, ...rest } = MODEL;
    const root = mkdtempSync(join(tmpdir(), "gen-constants-nocopy-"));
    const rendered = await renderAll(rest, root);
    expect([...rendered.keys()].some((p) => /copy/i.test(p))).toBe(false);
    expect(() => renderCopyTs(rest)).toThrow(/no core copy/);
  });
});
