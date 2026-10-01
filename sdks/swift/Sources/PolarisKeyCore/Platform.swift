// Platform identity for the `X-PKey-Platform` / `X-PKey-Arch` headers (§5, values §5.2).
//
// This lives in Core, not with the device facts, because the headers ride on EVERY
// product-scoped request — including a config-only product's document fetch, which never
// collects facts at all.

import Foundation

/// ASCII case folding: A–Z become a–z; every other scalar is unchanged (WIRE-CONTRACT-V3 §5.2
/// rule 1 — never a locale-dependent lowercase).
private func foldASCII(_ raw: String) -> String {
    var scalars = String.UnicodeScalarView()
    for scalar in raw.unicodeScalars {
        if scalar.value >= 0x41 && scalar.value <= 0x5A {
            scalars.append(Unicode.Scalar(scalar.value + 0x20)!)
        } else {
            scalars.append(scalar)
        }
    }
    return String(scalars)
}

/// A runtime's platform spelling to its canonical `X-PKey-Platform` value (WIRE-CONTRACT-V3
/// §5.2), or nil when the spelling has none and the header is omitted: `macOS` → `macos`,
/// `Windows` → `windows`, `visionOS` → nil.
///
/// The lookup is a `Dictionary` subscript, which compares keys by canonical equivalence. That is
/// exact here: every key of the generated table is in `[a-z0-9_-]` (the corpus generator checks
/// it), and no other scalar sequence is canonically equivalent to such a key.
public func canonicalPlatform(_ raw: String) -> String? {
    PLATFORM_SPELLINGS[foldASCII(raw)]
}

/// A runtime's CPU-architecture spelling to its canonical `X-PKey-Arch` value (§5.2), or nil:
/// `x86_64` → `x86_64`, `arm` → `armv7`, `i686` → nil.
public func canonicalArch(_ raw: String) -> String? {
    ARCH_SPELLINGS[foldASCII(raw)]
}

/// The short OS family: `current` is the Node-style family the device facts report
/// (`DeviceFacts.os.name`, unchanged by §5.2), and `headerValue` is the canonical
/// `X-PKey-Platform` value.
///
/// It exists because Swift previously sent `ProcessInfo.operatingSystemVersionString` — a full
/// "Version 15.1 (Build 24B83)" string — into the header. The detailed version lives in
/// `DeviceFacts.os` instead.
public enum PlatformFamily {
    public static var current: String {
        #if os(macOS)
        return "darwin"
        #elseif os(iOS)
        return "ios"
        #elseif os(Linux)
        return "linux"
        #elseif os(Windows)
        return "win32"
        #else
        return "unknown"
        #endif
    }

    /// The compilation condition this binary was built for, as a §5.2 spelling. Mac Catalyst is
    /// checked before iOS, because a Catalyst build also satisfies `os(iOS)`.
    static var compileTimeToken: String? {
        #if targetEnvironment(macCatalyst)
        return "macCatalyst"
        #elseif os(macOS)
        return "macOS"
        #elseif os(iOS)
        return "iOS"
        #elseif os(Linux)
        return "Linux"
        #elseif os(Windows)
        return "Windows"
        #elseif os(Android)
        return "Android"
        #else
        return nil
        #endif
    }

    /// The canonical `X-PKey-Platform` value for this binary, or nil (the header is omitted).
    public static var headerValue: String? {
        compileTimeToken.flatMap(canonicalPlatform)
    }
}

/// The CPU architecture. `current` is the value `PolarisKeyUpdate` feeds the appcast's `?arch=`
/// parameter and the device facts report; `headerValue` is the canonical `X-PKey-Arch` value
/// (§5.2).
public enum ArchFamily {
    public static var current: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }

    /// The `arch(…)` compilation condition this binary was built for, as a §5.2 spelling.
    static var compileTimeToken: String? {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #elseif arch(arm)
        return "arm"
        #elseif arch(wasm32)
        return "wasm32"
        #else
        return nil
        #endif
    }

    /// The canonical `X-PKey-Arch` value for this binary, or nil (the header is omitted).
    public static var headerValue: String? {
        compileTimeToken.flatMap(canonicalArch)
    }
}
