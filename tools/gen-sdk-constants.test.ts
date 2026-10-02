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
import {
  buildModel,
  camelName,
  CHANNEL_EXPORT,
  SPELLINGS_EXPORT,
  checkCoverage,
  checkStageCoverage,
  compileSchema,
  loadSources,
  pascalToUpper,
  readWorkerSource,
  renderAll,
  renderGdscript,
  renderPython,
  renderSwift,
  renderTs,
  run,
  scanStageMatrix,
  scanWorkerSource,
  TARGETS,
  upperName,
  validateEnums,
  validateErrors,
  words,
  type Sources,
} from "./gen-sdk-constants.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARITY = join(ROOT, "conformance", "parity");
const SOURCES = loadSources();
const MODEL = buildModel(SOURCES);
const RENDERERS = {
  ts: renderTs,
  python: renderPython,
  swift: renderSwift,
  gdscript: renderGdscript,
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
    expect(byName.sdkId).toEqual(["node", "react", "python", "swift", "godot"]);
  });

  it("storeBackend and storeDegradedReason equal client-core's STORE_BACKENDS and STORE_DEGRADED_REASONS", () => {
    const byName = Object.fromEntries(
      SOURCES.enums.map((e) => [e.name, e.values]),
    );
    expect(byName.storeBackend).toEqual([...STORE_BACKENDS]);
    expect(byName.storeDegradedReason).toEqual([...STORE_DEGRADED_REASONS]);
  });

  it("reads the corpus versions and the protocol version", () => {
    expect(SOURCES.corpus).toEqual({
      corpusVersion: 2,
      gateMatrixVersion: 2,
      fingerprintVersion: 1,
      stageMatrixVersion: 3,
      updateMatrixVersion: 1,
      outletMatrixVersion: 1,
      planMatrixVersion: 1,
      contentCorpusVersion: 1,
    });
    expect(SOURCES.protocol.PROTOCOL_VERSION).toBe(4);
    expect(SOURCES.protocol.MAX_WIRE_INTEGER).toBe(Number.MAX_SAFE_INTEGER);
    expect(SOURCES.protocol.MAX_JSON_DEPTH).toBe(64);
    expect(SOURCES.protocol.MAX_RECORD_JWS_BYTES).toBe(88844);
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

  it("Swift leaves ServiceSlug to ServiceSlug.generated.swift; the others emit it", () => {
    expect(renderSwift(MODEL)).not.toMatch(/public enum ServiceSlug/);
    expect(renderTs(MODEL)).toContain("export const ServiceSlug = {");
    expect(renderPython(MODEL)).toContain("class ServiceSlug:");
    expect(renderGdscript(MODEL)).toContain("class ServiceSlug:");
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
    const model = buildModel(withSources({ errors }));
    expect(renderTs(model)).toContain(
      'chunksHashMismatch: "chunks.hash-mismatch"',
    );
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

describe("gen:constants --check", () => {
  it("the committed files are up to date", async () => {
    expect(await run({ check: true })).toEqual([]);
  });

  it("reports a hand edit to any generated file, and does not write under --check", async () => {
    const root = mkdtempSync(join(tmpdir(), "gen-constants-"));
    mkdirSync(join(root, "sdks/godot/addons/polaris_key"), { recursive: true });
    const rendered = await renderAll(MODEL, root);
    expect([...rendered.keys()]).toEqual(TARGETS.map((t) => t.path));
    for (const [path, content] of rendered) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    expect(await run({ check: true, root, model: MODEL })).toEqual([]);

    for (const target of TARGETS) {
      const abs = join(root, target.path);
      const original = readFileSync(abs, "utf8");
      writeFileSync(
        abs,
        original.replace("service-unavailable", "service-gone"),
      );
      expect(await run({ check: true, root, model: MODEL })).toEqual([
        target.path,
      ]);
      expect(readFileSync(abs, "utf8")).not.toBe(original);
      expect(await run({ check: false, root, model: MODEL })).toEqual([
        target.path,
      ]);
      expect(readFileSync(abs, "utf8")).toBe(original);
    }
  }, 30_000);

  it("skips the GDScript module while sdks/godot/addons/polaris_key does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "gen-constants-nogodot-"));
    const rendered = await renderAll(MODEL, root);
    expect([...rendered.keys()]).not.toContain(
      "sdks/godot/addons/polaris_key/core/constants_generated.gd",
    );
    expect(rendered.size).toBe(TARGETS.length - 1);
  });
});
