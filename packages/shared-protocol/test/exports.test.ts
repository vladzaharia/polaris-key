// Pins the v3 subpath layout and the barrel's ONE identifier set: the barrel re-exports
// core's values verbatim, so there is no second spelling of `ISSUER` or the `HEADER_*`
// constants anywhere in the package. If this test fails after an edit, a consumer somewhere
// is about to verify or sign with the wrong ISSUER or send the wrong header names.
import { describe, expect, it } from "vitest";

import * as barrel from "../src/index.js";
import * as core from "../src/core.js";
import * as distribution from "../src/distribution.js";
import * as packs from "../src/packs.js";
import * as identity from "../src/identity.js";
import * as release from "../src/release.js";
import * as update from "../src/update.js";
import { DEFAULT_RELEASE_ACCESS } from "../src/release.js";

describe("@polaris-key/protocol layout", () => {
  it("core carries wire contract v4", () => {
    expect(core.PROTOCOL_VERSION).toBe(4);
    expect(core.MAX_WIRE_INTEGER).toBe(Number.MAX_SAFE_INTEGER);
    expect(core.MAX_JSON_DEPTH).toBe(64);
    // verifyJws's encoded caps: header 1 370 + "." + payload 87 386 + "." + signature 86.
    expect(core.MAX_RECORD_JWS_BYTES).toBe(1370 + 1 + 87386 + 1 + 86);
    expect(core.ISSUER).toBe("key.plrs.im");
    expect(core.HEADER_DEVICE).toBe("X-PKey-Device");
    expect(core.HEADER_SDK_NAME).toBe("X-PKey-SDK");
    expect(core.MAX_BUNDLE_BYTES).toBe(262_144);
  });

  it("the barrel and core are the SAME identifier set, not two that happen to agree", () => {
    // Re-exports, so this is identity rather than equality of two hand-maintained literals.
    expect(barrel.ISSUER).toBe(core.ISSUER);
    expect(barrel.HEADER_DEVICE).toBe(core.HEADER_DEVICE);
    expect(barrel.HEADER_SDK_NAME).toBe(core.HEADER_SDK_NAME);
    expect(barrel.PROTOCOL_VERSION).toBe(core.PROTOCOL_VERSION);
    // Hash domains are frozen at fingerprintVersion 1 and were never rebranded.
    expect(core.FINGERPRINT_HASH_PREFIX).toBe("pkey-hw");
  });

  it("pins the channel vocabulary (WIRE-CONTRACT-V3 §5.1), one identifier set", () => {
    expect(core.CHANNEL_STABLE).toBe("stable");
    expect(core.CHANNEL_BETA).toBe("beta");
    expect(core.CHANNEL_PR).toBe("pr");
    expect(core.CHANNEL_DEV).toBe("dev");
    expect(core.CHANNEL_ALIASES).toEqual({ staging: "beta", latest: "stable" });
    expect(core.CHANNEL_NAME_PATTERN).toBe("^[a-z0-9][a-z0-9-]{0,63}$");
    expect(core.PR_CHANNEL_PATTERN).toBe("^pr-?([0-9]+)$");
    expect(core.PR_NUMBER_MAX_DIGITS).toBe(7);
    expect(barrel.CHANNEL_STABLE).toBe(core.CHANNEL_STABLE);
    expect(barrel.CHANNEL_BETA).toBe(core.CHANNEL_BETA);
    expect(barrel.CHANNEL_PR).toBe(core.CHANNEL_PR);
    expect(barrel.CHANNEL_DEV).toBe(core.CHANNEL_DEV);
    expect(barrel.CHANNEL_ALIASES).toBe(core.CHANNEL_ALIASES);
    expect(barrel.CHANNEL_NAME_PATTERN).toBe(core.CHANNEL_NAME_PATTERN);
    expect(barrel.PR_CHANNEL_PATTERN).toBe(core.PR_CHANNEL_PATTERN);
    expect(barrel.PR_NUMBER_MAX_DIGITS).toBe(core.PR_NUMBER_MAX_DIGITS);
    const families: barrel.BuildChannel[] = ["stable", "beta", "pr", "dev"];
    expect(families).toHaveLength(4);
  });

  it("pins the client-metadata spelling tables (WIRE-CONTRACT-V3 §5.2), one identifier set", () => {
    expect(core.PLATFORM_SPELLINGS).toEqual({
      macos: "macos",
      darwin: "macos",
      maccatalyst: "macos",
      ios: "ios",
      ipados: "ios",
      android: "android",
      windows: "windows",
      win32: "windows",
      linux: "linux",
      web: "web",
      browser: "web",
    });
    expect(core.ARCH_SPELLINGS).toEqual({
      arm64: "arm64",
      aarch64: "arm64",
      "arm64-v8a": "arm64",
      x86_64: "x86_64",
      x64: "x86_64",
      amd64: "x86_64",
      armv7: "armv7",
      armv7l: "armv7",
      armv8l: "armv7",
      arm: "armv7",
      arm32: "armv7",
      "armeabi-v7a": "armv7",
      wasm32: "wasm32",
    });
    expect(barrel.PLATFORM_SPELLINGS).toBe(core.PLATFORM_SPELLINGS);
    expect(barrel.ARCH_SPELLINGS).toBe(core.ARCH_SPELLINGS);
    const platform: barrel.ClientPlatform = "web";
    const arch: barrel.ClientArch = "wasm32";
    expect([platform, arch]).toHaveLength(2);
  });

  it("release access gains the entitled mode with public defaults intact", () => {
    const modes: barrel.ReleaseAccess[] = [
      "public",
      "authenticated",
      "licensed",
      "entitled",
    ];
    expect(modes).toHaveLength(4);
    expect(DEFAULT_RELEASE_ACCESS).toEqual({
      metadata: "public",
      artifacts: "public",
    });
  });

  it("the gate vocabulary includes not-applicable", () => {
    const status: barrel.LicenseStatus = "not-applicable";
    expect(status).toBe("not-applicable");
  });

  it("the v4 feed, record and decision constants (WIRE-CONTRACT-V4 §2.3, §2.4)", () => {
    expect(update.FEED_VERSION_SCHEMES).toEqual([
      "semver",
      "semver+build",
      "4part",
    ]);
    expect(update.FEED_TTL_SECONDS).toBe(900);
    expect(update.MAX_FEED_TTL_SECONDS).toBe(3600);
    expect(update.ROLLOUT_BUCKETS).toBe(10000);
    expect(update.FEED_PLATFORM_PATTERN.source).toBe("^[a-z][a-z0-9-]{0,63}$");
    expect(update.UPDATE_ACTIONS).toEqual([
      "none",
      "code-ready",
      "binary",
      "store",
      "platform",
      "blocked",
      "packs",
    ]);
    // P4-13 filled P3-01's reserved values (plans/P4-13.md §2.6).
    expect(update.BLOCKED_REASONS).toEqual([
      "app-floor",
      "content-floor",
      "revoked-content",
    ]);
    expect(update.MAX_FEED_REVOCATIONS).toBe(64);
    expect(core.REVOCATION_REASON_MAX_BYTES).toBe(512);
    expect(update.BINARY_METHODS).toEqual([
      "native",
      "download",
      "sidecar-pck",
    ]);
    expect(update.NONE_REASONS).toHaveLength(10);
    expect(release.BUILD_ID_PATTERN.source).toBe("^[a-z0-9][a-z0-9._-]{0,63}$");
    expect(release.RECORD_KINDS).toEqual([
      "app",
      "pack",
      "revocation",
      "delegation",
    ]);
    expect(release.RESERVED_RECORD_KINDS).toEqual([]);
    // plans/P4-19.md §2.2: 69 bytes, longer than any declared release-key kid.
    expect(release.DELEGATED_KID_PATTERN.test(`pkd1-${"a".repeat(64)}`)).toBe(
      true,
    );
    expect(release.DELEGATED_KID_PATTERN.test(`pkd1-${"A".repeat(64)}`)).toBe(
      false,
    );
    expect(barrel.FEED_VERSION_SCHEMES).toBe(update.FEED_VERSION_SCHEMES);
    expect(barrel.BUILD_ID_PATTERN).toBe(release.BUILD_ID_PATTERN);
    expect(barrel.MAX_WIRE_INTEGER).toBe(core.MAX_WIRE_INTEGER);
  });

  it("the /distribution subpath: kinds, capabilities and narrowing (plans/P3-01.md §2.9)", () => {
    expect(distribution.OUTLET_KINDS).toHaveLength(17);
    expect(distribution.OUTLET_ID_PATTERN.source).toBe(
      "^[a-z][a-z0-9-]{0,63}$",
    );
    expect(distribution.OUTLET_UNKNOWN).toBe("unknown");
    expect(Object.keys(distribution.OUTLET_CAPABILITY_DEFAULTS).sort()).toEqual(
      [...distribution.OUTLET_KINDS, "unknown"].sort(),
    );
    for (const kind of [...distribution.OUTLET_KINDS, "unknown"] as const) {
      expect(distribution.OUTLET_CAPABILITY_DEFAULTS[kind]).toBeDefined();
      expect(distribution.OUTLET_PLATFORMS[kind]).toBeDefined();
    }
    expect(distribution.OUTLET_CAPABILITY_DEFAULTS.web.binaryUpdates).toBe(
      "none",
    );
    expect(distribution.OUTLET_CAPABILITY_DEFAULTS.steam.commerce).toBe(
      "steam",
    );
    expect(distribution.PLATFORM_NARROWING.ios!.direct).toEqual({
      binaryUpdates: "store",
      codeUpdates: false,
      downloadedScripts: false,
    });
    expect(distribution.BINARY_UPDATES_ORDER).toEqual([
      "none",
      "store",
      "self",
    ]);
    expect(distribution.OUTLET_SUBKINDS).toHaveLength(8);
    expect(distribution.SUBKIND_NARROWING.appimage).toEqual({});
    expect(distribution.OUTLET_CONFIDENCES).toEqual([
      "attested",
      "declared",
      "heuristic",
      "stamp",
    ]);
    expect(barrel.OUTLET_KINDS).toBe(distribution.OUTLET_KINDS);
  });

  it("the /packs subpath and the pack limits (plans/P4-01.md §2.3, §2.13)", () => {
    expect(core.MAX_PACK_VARIANTS).toBe(32);
    expect(core.MAX_VARIANT_DELTAS).toBe(16);
    expect(core.MAX_CONTENT_PINS).toBe(256);
    expect(core.MAX_BUILD_EMBEDS).toBe(64);
    expect(core.MAX_INDEX_FILES).toBe(100000);
    expect(core.MAX_FILES_INDEX_BYTES).toBe(32 * 1024 * 1024);
    expect(core.MAX_PACK_PATH_BYTES).toBe(1024);
    expect(core.FILES_FORMAT).toBe("pkey-files/1");
    expect(core.PATCH_FORMAT).toBe("pkey-patch/1");
    expect(core.MARKER_FORMAT).toBe("pkey-marker/1");
    expect(core.CONTENT_STAMP_FORMAT).toBe("pkey-content/1");
    // plans/P4-10.md §2.3: the chunk index format and its two client limits.
    expect(core.CHUNKS_FORMAT).toBe("pkey-chunks/1");
    expect(core.MAX_CHUNK_INDEX_BYTES).toBe(16 * 1024 * 1024);
    expect(core.MAX_CHUNK_BYTES).toBe(4 * 1024 * 1024);
    expect(barrel.MAX_CHUNK_BYTES).toBe(core.MAX_CHUNK_BYTES);
    expect(packs.PACK_TYPE_PATTERN.source).toBe(
      "^[a-z][a-z0-9-]{0,31}\\.[a-z][a-z0-9-]{0,31}$",
    );
    expect(packs.VOCAB_TOKEN_PATTERN.source).toBe("^[a-z][a-z0-9-]{0,31}$");
    expect(packs.OBJECT_FORMAT_PATTERN.test("pkey-files/1")).toBe(true);
    expect(packs.OBJECT_FORMAT_PATTERN.test("pkey-files/01")).toBe(false);
    expect(packs.HANDLER_PREFIX_PATTERN.test("res://assets/kaykit/")).toBe(
      true,
    );
    expect(packs.HANDLER_PREFIX_PATTERN.test("res://assets")).toBe(false);
    expect(packs.ENTITLEMENT_PATTERN.source).toBe(
      "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$",
    );
    expect(packs.VARIANT_AXIS_PATTERN.source).toBe("^[a-z][a-z0-9-]{0,15}$");
    expect(packs.VARIANT_VALUE_PATTERN.source).toBe(
      "^[A-Za-z0-9][A-Za-z0-9-]{0,34}$",
    );
    expect(packs.ENGINE_PATTERN.test("godot-4.7")).toBe(true);
    expect(packs.PACK_TYPES).toEqual(["godot.pck", "files.tree"]);
    expect(packs.FILES_LAYOUTS).toEqual(["container", "tree"]);
    expect(packs.CONTENT_CODECS).toEqual(["zstd", "none"]);
    expect(packs.PATCH_METHODS).toEqual(["zstd-patch-from"]);
    expect(packs.RESERVED_PATCH_METHODS).toEqual([
      "godot-delta-pck",
      "hdiffpatch",
      "bsdiff",
    ]);
    expect(packs.PATCH_SCOPES).toEqual(["payload", "files"]);
    expect(packs.PACK_DELIVERIES).toEqual([
      "essential",
      "prefetch",
      "on-demand",
    ]);
    expect(packs.PACK_ACTIVATIONS).toEqual(["restart", "hot"]);
    expect(packs.VARIANT_AXES).toEqual(["texture", "locale", "quality"]);
    expect(packs.ZSTD_DICTIONARY_MAGIC).toBe("37a430ec");
    expect(packs.MARKER_SUFFIX).toBe(".pkey.json");
    expect(packs.TREE_MARKER_PATH).toBe(".pkey/pack.json");
    expect(packs.CONTENT_STAMP_FILE).toBe("pkey-content.json");
    expect(barrel.PACK_TYPES).toBe(packs.PACK_TYPES);
    expect(barrel.MAX_FILES_INDEX_BYTES).toBe(core.MAX_FILES_INDEX_BYTES);
    expect(barrel.RECORD_KINDS).toBe(release.RECORD_KINDS);
  });

  it("the delegation constants (plans/P4-19.md §2.2, §2.5)", () => {
    expect(packs.DELEGABLE_PACK_TYPES).toEqual([
      "files.tree",
      "data.json",
      "l10n.table",
    ]);
    expect(packs.DATA_ONLY_EXTENSIONS).toHaveLength(14);
    expect(core.MAX_DELEGATION_TTL_SECONDS).toBe(366 * 86400);
    expect(core.MAX_DELEGATION_TYPES).toBe(8);
    expect(core.DATA_ONLY_HEAD_BYTES).toBe(64);
    expect(core.DATA_ONLY_TAIL_BYTES).toBe(22 + 65535);
    expect(core.MAX_DELEGATIONS_PER_CHECK).toBe(16);
    expect(barrel.DELEGABLE_PACK_TYPES).toBe(packs.DELEGABLE_PACK_TYPES);
    expect(barrel.DELEGATED_KID_PATTERN).toBe(release.DELEGATED_KID_PATTERN);
    expect(barrel.MAX_DELEGATIONS_PER_CHECK).toBe(
      core.MAX_DELEGATIONS_PER_CHECK,
    );
  });

  it("the /identity subpath (plans/PX-W17.md §2)", () => {
    expect(identity.IDENTITY_DISABLED_ERROR_PARAM).toBe("identity_disabled");
    expect(barrel.IDENTITY_DISABLED_ERROR_PARAM).toBe(
      identity.IDENTITY_DISABLED_ERROR_PARAM,
    );
    const code: core.PolarisErrorCode = "identity_disabled";
    expect(code).toBe(identity.IDENTITY_DISABLED_ERROR_PARAM);
  });
});
