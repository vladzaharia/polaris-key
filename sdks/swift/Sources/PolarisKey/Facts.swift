// Software facts: the OS/runtime/hardware summary and product-declared probe results the
// client reports through POST /<product>/config/report. Mirrors packages/sdk-node/src/facts.ts
// and sdks/python/src/polaris_key/facts.py.
//
// Deliberately narrow — there is no installed-application enumeration. A product declares the
// companion apps it cares about and the client answers only those, so the payload stays small
// and the privacy story stays defensible (see docs/PRIVACY.md).

import Foundation

/// The short OS family sent in `X-PKey-Platform`.
///
/// This exists because Swift previously sent `ProcessInfo.operatingSystemVersionString` — a
/// full "Version 15.1 (Build 24B83)" string — into the same header where Node and Python send
/// `darwin`/`linux`, which made any server-side branch on platform unreliable. The detailed
/// version now lives in `DeviceFacts.os` where it belongs.
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

/// A product-declared companion-application check.
public struct ProbeDeclaration: Sendable, Equatable {
    public let id: String
    public let label: String?
    public let macos: String?
    public let windows: String?
    public let linux: String?

    public init(
        id: String,
        label: String? = nil,
        macos: String? = nil,
        windows: String? = nil,
        linux: String? = nil
    ) {
        self.id = id
        self.label = label
        self.macos = macos
        self.windows = windows
        self.linux = linux
    }

    var targetForCurrentPlatform: String? {
        switch PlatformFamily.current {
        case "darwin", "ios": return macos
        case "win32": return windows
        default: return linux
        }
    }
}

/// One probe's answer.
public struct ProbeResult: Sendable, Equatable, Encodable {
    public let present: Bool
    public let version: String?
}

/// The device's current software snapshot.
public struct DeviceFacts: Sendable, Encodable {
    public struct OS: Sendable, Encodable {
        public let name: String
        public let version: String?
        public let build: String?
        public let kernel: String?
    }

    public struct Hardware: Sendable, Encodable {
        public let cpuModel: String?
        public let cpuCores: Int?
        public let ramMb: Int?
        public let machineModel: String?
    }

    public struct Runtime: Sendable, Encodable {
        public let name: String
        public let version: String
    }

    public let os: OS
    public let hardware: Hardware
    public let runtime: Runtime
    public let locale: String?
    public let timezone: String?
    public let probes: [String: ProbeResult]?
}

public enum Facts {
    /// Answer the declared probes for this platform.
    public static func runProbes(_ declarations: [ProbeDeclaration]) -> [String: ProbeResult] {
        var out: [String: ProbeResult] = [:]
        for probe in declarations {
            // A probe with no target for this platform is not applicable — reporting it as
            // `present: false` would be a lie an admin can't distinguish from "not installed".
            guard let target = probe.targetForCurrentPlatform else { continue }
            let present = FileManager.default.fileExists(atPath: target)
            out[probe.id] = ProbeResult(
                present: present,
                version: present ? bundleShortVersion(atPath: target) : nil
            )
        }
        return out
    }

    /// macOS apps carry their version in Info.plist; read it best-effort.
    private static func bundleShortVersion(atPath path: String) -> String? {
        guard let bundle = Bundle(path: path) else { return nil }
        return bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }

    /// Collect this device's software facts.
    public static func collect(probes: [ProbeDeclaration] = []) -> DeviceFacts {
        let info = ProcessInfo.processInfo
        let version = info.operatingSystemVersion
        let results = probes.isEmpty ? nil : runProbes(probes)
        return DeviceFacts(
            os: DeviceFacts.OS(
                name: PlatformFamily.current,
                version: "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
                build: buildNumber(),
                kernel: kernelVersion()
            ),
            hardware: DeviceFacts.Hardware(
                cpuModel: sysctlString("machdep.cpu.brand_string"),
                cpuCores: info.processorCount,
                ramMb: Int(info.physicalMemory / 1_048_576),
                machineModel: sysctlString("hw.model") ?? sysctlString("hw.machine")
            ),
            runtime: DeviceFacts.Runtime(name: "swift", version: swiftVersion()),
            locale: Locale.current.identifier,
            timezone: TimeZone.current.identifier,
            probes: results
        )
    }

    private static func buildNumber() -> String? {
        #if os(macOS)
        return sysctlString("kern.osversion")
        #else
        return nil
        #endif
    }

    private static func kernelVersion() -> String? {
        sysctlString("kern.ostype")
    }

    private static func swiftVersion() -> String {
        #if swift(>=6.0)
        return "6"
        #else
        return "5"
        #endif
    }

    private static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        let value = String(decoding: buffer.prefix(while: { $0 != 0 }), as: UTF8.self)
        return value.isEmpty ? nil : value
    }
}
