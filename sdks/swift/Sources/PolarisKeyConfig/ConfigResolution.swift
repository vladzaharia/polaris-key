// Layered config resolution (WIRE-CONTRACT-V3 §2.2.1), pinned by `config-matrix.json`. Pure: the
// same rules as `@polaris-key/client-core`'s `config.ts` and Python's `config/resolve.py`, named
// the same up to casing, and the implementation `ConfigClient` delegates to.
//
//   enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
//
// Rule 2, the environment value, is strict JSON decided from the text alone (see
// `readEnvValue`). Swift's `[String: …]` maps compare keys by canonical equivalence, which
// WIRE-CONTRACT-V3 §10 declares: of two canonically equivalent member names in an environment
// value `JSONValue` keeps the first, and a variable name canonically equivalent to the built one
// (only U+212A KELVIN SIGN against `K`) reads as that name. The verdict never changes, because
// the duplicate scan compares scalar values.

import Foundation
import PolarisKeyCore

/// The inputs one resolution needs.
public struct ResolveContext: Sendable {
    /// The verified config document's `config` map, or nil before the first document.
    public var remote: [String: ManagedEntry]?
    /// User/local overrides (beat a remote `default`, never an `enforced`/`hidden` entry).
    public var localOverrides: [String: JSONValue]
    /// The environment lookup table (empty on a host without an environment layer, rule 3).
    public var env: [String: String]
    /// `${envPrefix}${key with "." → "__"}` is the variable name (rule 1).
    public var envPrefix: String

    public init(
        remote: [String: ManagedEntry]?, localOverrides: [String: JSONValue],
        env: [String: String], envPrefix: String
    ) {
        self.remote = remote
        self.localOverrides = localOverrides
        self.env = env
        self.envPrefix = envPrefix
    }
}

public enum ConfigResolution {
    /// The effective value for `key`, or nil when no layer answered (the caller substitutes its
    /// fallback). A layer holding JSON null answers `.null`.
    public static func resolveValue(_ ctx: ResolveContext, _ key: String) -> JSONValue? {
        let entry = ctx.remote?[key]
        // enforced | hidden → the remote value is locked; local/env are ignored.
        if let entry, entry.state == .enforced || entry.state == .hidden { return entry.value }
        if let local = ctx.localOverrides[key] { return local }
        if let env = envValue(ctx, key) { return env }
        if let entry { return entry.value }
        return nil
    }

    /// Where `resolveValue` sources its answer from.
    public static func resolveSource(_ ctx: ResolveContext, _ key: String) -> ConfigSource {
        let entry = ctx.remote?[key]
        if entry?.state == .enforced { return .enforced }
        if entry?.state == .hidden { return .hidden }
        if ctx.localOverrides[key] != nil { return .local }
        if envValue(ctx, key) != nil { return .env }
        if entry != nil { return .remoteDefault }
        return .fallback
    }

    /// The user-visible list (rule 4): every document entry except `hidden` ones, each with its
    /// resolved value. A key only a local override or the environment supplies is not listed.
    /// The order is not specified.
    public static func listUserEntries(_ ctx: ResolveContext) -> [UserConfigEntry] {
        guard let remote = ctx.remote else { return [] }
        var out: [UserConfigEntry] = []
        for (key, entry) in remote where entry.state != .hidden {
            out.append(
                UserConfigEntry(
                    key: key, value: resolveValue(ctx, key) ?? entry.value,
                    enforced: entry.state == .enforced))
        }
        return out
    }

    private static func envValue(_ ctx: ResolveContext, _ key: String) -> JSONValue? {
        let name = ctx.envPrefix + key.replacingOccurrences(of: ".", with: "__")
        guard let raw = ctx.env[name] else { return nil }
        return readEnvValue(raw)
    }

    /// Rule 2: the parsed value when `raw` is one strict JSON text, else `.string(raw)`. Never
    /// throws, and decided from the text alone:
    ///
    /// 1. A leading U+FEFF or any U+0000 keeps the raw string. `JSONDecoder` skips one leading
    ///    UTF-8 BOM and guesses UTF-16 or UTF-32 from NUL bytes; no rule-2 text begins with
    ///    U+FEFF or holds a raw U+0000, so both guards are exact.
    /// 2. The depth scan (at most 64 levels; `JSONDecoder` stops only at 512) and the number scan
    ///    (zero, or a magnitude of at least 10^-307 and below 10^308, from the digits).
    /// 3. The member-name scan (duplicates by scalar value, no U+0000) and the trailing-comma
    ///    scan, which `JSONDecoder` accepts.
    /// 4. `JSONDecoder`, which refuses lone surrogates and every other non-JSON text.
    ///    `JSONValue` tries `Int` before `Double`, and that order must stay: `JSONDecoder` refuses
    ///    `0e5` as a `Double` but decodes it as the `Int` 0.
    static func readEnvValue(_ raw: String) -> JSONValue {
        if raw.unicodeScalars.first == "\u{FEFF}" || raw.unicodeScalars.contains("\u{0}") {
            return .string(raw)
        }
        let data = Data(raw.utf8)
        if StrictJSON.nestingExceeds(data, StrictJSON.maxDepth) { return .string(raw) }
        if !StrictJSON.numbersInRange(data) { return .string(raw) }
        if StrictJSON.hasRefusedMemberName(data) || StrictJSON.hasTrailingComma(data) {
            return .string(raw)
        }
        guard let parsed = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            return .string(raw)
        }
        return parsed
    }
}
