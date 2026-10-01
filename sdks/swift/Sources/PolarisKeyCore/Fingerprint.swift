// Hardware fingerprint collection. Mirrors packages/sdk-node/src/devices/fingerprint.ts and
// sdks/python/src/polaris_key/fingerprint.py: each component is hashed HERE, on the device, as
// `pkey-hw:<product>:<component>:<raw>` → SHA-256 → base64url, first 22 chars, so the raw
// serial/UUID/MAC never crosses the wire. The composite `hwid` is a second digest over the
// present components in CANONICAL order, truncated to 32 chars.
//
// Both formulas are pinned by conformance/corpus/v2/fingerprint.json — this file and its
// Node/Python/Worker counterparts must produce byte-identical output for identical input.
//
// Every read is best-effort. A component that cannot be read is OMITTED, never substituted: a
// partial fingerprint loses match precision, whereas a placeholder would make every partial
// reader collide with every other one.

import CryptoKit
import Foundation

#if os(macOS)
import IOKit
#endif

/// One hashed hardware signal. `machineUuid` is the anchor component.
public enum FingerprintComponent: String, CaseIterable, Sendable {
    case machineUuid
    case boardSerial
    case cpuModel
    case primaryMac
    case bootVolumeUuid
    case ramBucket
    case machineModel
}

/// A device's hardware identity: per-component digests plus their composite.
public struct HardwareFingerprint: Sendable, Equatable {
    public let components: [String: String]
    public let hwid: String

    public init(components: [String: String], hwid: String) {
        self.components = components
        self.hwid = hwid
    }
}

public enum Fingerprint {
    /// Canonical component order. The hwid digest walks THIS list, never a dictionary's
    /// ordering — Swift dictionaries are unordered, so relying on one would be non-deterministic.
    public static let componentOrder: [FingerprintComponent] = FingerprintComponent.allCases

    private static let hashPrefix = "pkey-hw"
    private static let componentLength = 22
    private static let hwidLength = 32

    private static func sha256B64url(_ value: String, _ length: Int) -> String {
        let digest = SHA256.hash(data: Data(value.utf8))
        return String(Base64URL.encode(Data(digest)).prefix(length))
    }

    /// Hash raw component values into the wire form. Pure — the conformance-tested unit.
    public static func hashComponents(
        productSlug: String,
        raw: [String: String]
    ) -> HardwareFingerprint {
        var components: [String: String] = [:]
        var parts: [String] = []
        for component in componentOrder {
            guard let value = raw[component.rawValue] else { continue }
            let digest = sha256B64url(
                "\(hashPrefix):\(productSlug):\(component.rawValue):\(value)",
                componentLength
            )
            components[component.rawValue] = digest
            parts.append("\(component.rawValue)=\(digest)")
        }
        return HardwareFingerprint(
            components: components,
            hwid: sha256B64url(parts.joined(separator: "\n"), hwidLength)
        )
    }

    /// Collect and hash this machine's fingerprint, or nil if nothing could be read.
    public static func collect(productSlug: String) -> HardwareFingerprint? {
        let raw = rawComponents()
        guard !raw.isEmpty else { return nil }
        return hashComponents(productSlug: productSlug, raw: raw)
    }

    /// Read the platform-specific raw component values.
    public static func rawComponents() -> [String: String] {
        var raw: [String: String] = [:]
        #if os(macOS)
        put(&raw, .machineUuid, ioRegistryString(kIOPlatformUUIDKey))
        put(&raw, .boardSerial, ioRegistryString(kIOPlatformSerialNumberKey))
        put(&raw, .machineModel, sysctlString("hw.model"))
        put(&raw, .cpuModel, cpuModel())
        put(&raw, .bootVolumeUuid, bootVolumeUUID())
        #elseif os(iOS)
        // iOS gives no hardware serials to third-party apps; identifierForVendor is the only
        // stable handle, and it is already the device id. Report just the model + RAM so the
        // fingerprint stays honest rather than padded with values we cannot actually read.
        put(&raw, .machineUuid, DeviceID.rawDeviceId())
        put(&raw, .machineModel, sysctlString("hw.machine"))
        #endif
        put(&raw, .ramBucket, ramBucket(bytes: ProcessInfo.processInfo.physicalMemory))
        return raw
    }

    private static func put(
        _ raw: inout [String: String],
        _ component: FingerprintComponent,
        _ value: String?
    ) {
        // The omission rule, in one place: only components that actually read are included.
        guard let value, !value.isEmpty else { return }
        raw[component.rawValue] = value
    }

    /// Rule 3 of WIRE-CONTRACT-V3 §6.1 (`ramBuckets` in `fingerprint.json`):
    /// `g = floor(bytes / 2^30)`; `nil` when `g == 0`, otherwise the largest power of two not
    /// above `g`, in decimal. Integer arithmetic, dividing BEFORE any logarithm — a float `log2`
    /// rounds a total just below a power of two up to the next bucket from 1 PiB.
    ///
    /// What the bucket buys is stability while the reported total stays between two powers of
    /// two (a 16 GB machine reporting 15.4 GiB buckets to 8, and keeps doing so).
    public static func ramBucket(bytes: UInt64) -> String? {
        let g = bytes >> 30
        guard g > 0 else { return nil }
        return String(UInt64(1) << (63 - g.leadingZeroBitCount))
    }

    private static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        // `sysctl` returns a NUL-terminated C string; decode only up to the terminator so the
        // trailing NUL never becomes part of the hashed component value.
        let value = String(decoding: buffer.prefix(while: { $0 != 0 }), as: UTF8.self)
        return value.isEmpty ? nil : value
    }

    #if os(macOS)
    private static func cpuModel() -> String? {
        guard let brand = sysctlString("machdep.cpu.brand_string") else { return nil }
        return "\(brand):\(ProcessInfo.processInfo.processorCount)"
    }

    private static func ioRegistryString(_ key: String) -> String? {
        let matching = IOServiceMatching("IOPlatformExpertDevice")
        let service = IOServiceGetMatchingService(kIOMainPortDefault, matching)
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        return IORegistryEntryCreateCFProperty(
            service, key as CFString, kCFAllocatorDefault, 0
        )?.takeRetainedValue() as? String
    }

    private static func bootVolumeUUID() -> String? {
        let url = URL(fileURLWithPath: "/")
        guard
            let values = try? url.resourceValues(forKeys: [.volumeUUIDStringKey]),
            let uuid = values.volumeUUIDString
        else { return nil }
        return uuid
    }
    #endif
}
