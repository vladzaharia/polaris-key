// Platform identity for the `X-Polaris-Platform` / `X-Polaris-Arch` headers (§5).
//
// This lives in Core, not with the device facts, because the headers ride on EVERY
// product-scoped request — including a config-only product's document fetch, which never
// collects facts at all.

import Foundation

/// The short OS family sent in `X-Polaris-Platform`.
///
/// It exists because Swift previously sent `ProcessInfo.operatingSystemVersionString` — a full
/// "Version 15.1 (Build 24B83)" string — into the same header where Node and Python send
/// `darwin`/`linux`, which made any server-side branch on platform unreliable. The detailed
/// version lives in `DeviceFacts.os` instead.
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
}

/// The CPU architecture sent in `X-Polaris-Arch`, and the value `PolarisUpdate` feeds the
/// appcast's `?arch=` parameter. The vocabulary matches the Worker's `UpdateArch`
/// (`arm64` | `x86_64`), so a feed request and a telemetry row agree on what this machine is.
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
}
