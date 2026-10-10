// The core copy catalog (core.copy, notes/SDK-PARITY-PASS.md §3.2): what a surface SAYS for a
// code, in one place.
//
//   ErrorCopy.message(code, detail:, params:)         the sentence a screen shows
//   ErrorCopy.title(code)                             the short heading above it
//   ErrorCopy.activationMessage(kind, code:, params:) the sentence for a typed activation result
//   ErrorCopy.activationTitle(kind)                   its heading
//
// ENGLISH IS GENERATED. `Copy.generated.swift` is written by `pnpm gen constants` from
// `conformance/parity/copy.en.json` (checked against errors.json and enums.json), with three
// tables: COPY_CODES (per error code), COPY_GATE (per licenseStatus) and COPY_ACTIVATION (per
// activationResult). They are separate on purpose: the error code `unauthorized` reads "Not
// signed in", the activation result `unauthorized` reads "Key not accepted". `message(code)`
// looks a code up as an error code, then as a gate status, then as an activation result (the
// reference rule, packages/sdk-react/src/core/copy.ts); `activationMessage(kind)` reads the
// activation table only.
//
// A code with no entry falls back to COPY_FALLBACK, which NAMES the code and never shows the raw
// server body: a body is not copy, and it is not localised.
//
// The host's English override layer (`setOverrides`) wins per key over the generated tables and
// starts empty. Localisation beyond English is the String Catalog's job (UK-07), not this table's.

import Foundation

public enum ErrorCopy {
    /// Placeholder values for a sentence (`COPY_PLACEHOLDERS`: `code`, `detail`, `limit`,
    /// `deviceCount`, `retryAfterSeconds`, `product`).
    public typealias Params = [String: String]

    /// "this Mac" on macOS, "this device" on every other platform. The generated copy says
    /// "this device" everywhere; this is for a host's own sentences.
    public static var deviceNoun: String {
        #if os(macOS)
            return "this Mac"
        #else
            return "this device"
        #endif
    }

    /// `deviceNoun` at the start of a sentence: "This Mac" or "This device".
    public static var deviceNounCapitalized: String {
        #if os(macOS)
            return "This Mac"
        #else
            return "This device"
        #endif
    }

    // ── The host override layer ──────────────────────────────────────────────────────────

    private struct Overrides {
        var messages: [String: String] = [:]
        var titles: [String: String] = [:]
    }

    private static let overrides = LockedValue(Overrides())

    /// Replace the host's English overrides: `messages` and `titles` keyed by error code, gate
    /// status or activation result (`device-limit`, or its camelCase kind `deviceLimit`). An
    /// override wins over the generated tables for its key; every other key keeps the generated
    /// text. Pass empty maps to clear.
    public static func setOverrides(
        messages: [String: String] = [:], titles: [String: String] = [:]
    ) {
        overrides.set(Overrides(messages: messages, titles: titles))
    }

    // ── Lookup ───────────────────────────────────────────────────────────────────────────

    /// The generated entry for `code`: error code, then gate status, then activation result.
    public static func entry(_ code: String) -> CopyEntry? {
        COPY_CODES[code] ?? COPY_GATE[code] ?? COPY_ACTIVATION[activationResult(code)]
    }

    /// Whether `code` has its own sentence (a host override or the generated tables).
    public static func has(_ code: String) -> Bool {
        overrides.current.messages[code] != nil || entry(code) != nil
    }

    /// The sentence for `code`. `{code}` is replaced by the code, the other placeholders by
    /// `params` (an unfilled one is dropped with the space before it); `detail` is appended in
    /// parentheses when given. A code with no entry answers COPY_FALLBACK naming the code.
    public static func message(_ code: String, detail: String? = nil, params: Params = [:])
        -> String
    {
        let text =
            overrides.current.messages[code] ?? entry(code)?.message ?? COPY_FALLBACK.message
        let out = fill(text, code: code, params: params)
        guard let detail, !detail.isEmpty else { return out }
        return "\(out) (\(detail))"
    }

    /// The short heading for `code`, or COPY_FALLBACK's title.
    public static func title(_ code: String) -> String {
        overrides.current.titles[code] ?? entry(code)?.title ?? COPY_FALLBACK.title
    }

    /// The sentence for a typed activation result (`ActivationResult.kind`, `device-limit`, or
    /// its camelCase kind): the host override, else the activation table — never the error-code
    /// table. `{code}` (in `refused`) names `code`. A kind the table lacks reads as `message`.
    public static func activationMessage(
        _ kind: String, code: String? = nil, params: Params = [:]
    ) -> String {
        guard let text = activationText(kind, messages: true) else {
            return message(kind, params: params)
        }
        return fill(text, code: code ?? kind, params: params)
    }

    /// The heading for a typed activation result.
    public static func activationTitle(_ kind: String) -> String {
        activationText(kind, messages: false) ?? title(kind)
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────

    private static func activationText(_ kind: String, messages: Bool) -> String? {
        let result = activationResult(kind)
        let layer = overrides.current
        let own = messages ? layer.messages : layer.titles
        if let text = own[result] ?? own[camelCase(result)] { return text }
        guard let entry = COPY_ACTIVATION[result] else { return nil }
        return messages ? entry.message : entry.title
    }

    /// A §3.1 kind (`deviceLimit`) as its activationResult (`device-limit`); an already-kebab
    /// spelling is unchanged.
    static func activationResult(_ kind: String) -> String {
        var out = ""
        for ch in kind {
            if ch.isUppercase {
                out += "-" + ch.lowercased()
            } else {
                out.append(ch)
            }
        }
        return out
    }

    /// An activationResult (`device-limit`) as its camelCase kind (`deviceLimit`).
    static func camelCase(_ result: String) -> String {
        var out = ""
        var upper = false
        for ch in result {
            if ch == "-" {
                upper = true
            } else {
                out += upper ? ch.uppercased() : String(ch)
                upper = false
            }
        }
        return out
    }

    /// Fill `{name}` placeholders; `{code}` defaults to `code`. An unfilled placeholder is dropped
    /// with the space before it, so a raw `{name}` never shows.
    static func fill(_ text: String, code: String, params: Params) -> String {
        var out = ""
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "{") {
            let after = rest.index(after: open)
            guard let close = rest[after...].firstIndex(of: "}") else { break }
            let name = rest[after..<close]
            let isWord =
                !name.isEmpty
                && name.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "_" }
            guard isWord else {
                out += rest[...open]
                rest = rest[after...]
                continue
            }
            var head = rest[..<open]
            let value = params[String(name)] ?? (name == "code" ? code : nil)
            if value == nil, head.last == " " { head = head.dropLast() }
            out += head
            if let value { out += value }
            rest = rest[rest.index(after: close)...]
        }
        return out + rest
    }
}

extension PolarisError: LocalizedError {
    /// The person-facing sentence for `code` (`ErrorCopy.message`); `message` stays the
    /// developer-facing detail.
    public var errorDescription: String? { userMessage ?? ErrorCopy.message(code) }
    public var failureReason: String? { message }
}
