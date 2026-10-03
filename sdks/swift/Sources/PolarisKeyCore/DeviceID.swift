// Stable, hashed device id. The raw OS identifier never leaves the device: we hash
// `pkey-device:<product>:<raw>` with SHA-256 and base64url-truncate to 32 chars, mirroring
// sdk-node's `deriveDeviceId` (so the same physical device derives the same id everywhere
// the formula is shared). The raw source is the IOPlatformUUID on macOS and
// identifierForVendor on iOS; a random UUID is the last-resort fallback.

import CryptoKit
import Foundation

#if os(macOS)
import IOKit
#elseif os(iOS)
import UIKit
#endif

public enum DeviceID {
    /// Derive a stable, hashed device id for a product. `fallback` overrides the platform
    /// OS-id lookup (used by tests); otherwise the raw id comes from the platform.
    public static func derive(productSlug: String, fallback: String? = nil) -> String {
        fromRaw(productSlug: productSlug, raw: fallback ?? rawDeviceId() ?? UUID().uuidString)
    }

    /// The device-id formula itself, split out from the hardware read so it can be pinned by
    /// `conformance/corpus/v2/fingerprint.json`. Node, Python, and Swift must agree exactly.
    public static func fromRaw(productSlug: String, raw: String) -> String {
        let digest = SHA256.hash(data: Data("pkey-device:\(productSlug):\(raw)".utf8))
        return String(Base64URL.encode(Data(digest)).prefix(32))
    }

    /// The raw, per-device identifier — never returned to callers directly.
    static func rawDeviceId() -> String? {
        #if os(macOS)
        return macPlatformUUID()
        #elseif os(iOS)
        // UIDevice is main-actor isolated (an error under Swift 6 on Xcode 16). Read it on the
        // main thread: directly when already there, otherwise hop with a synchronous dispatch.
        let read: @Sendable () -> String? = {
            MainActor.assumeIsolated { UIDevice.current.identifierForVendor?.uuidString }
        }
        return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
        #else
        return nil
        #endif
    }

    #if os(macOS)
    private static func macPlatformUUID() -> String? {
        let matching = IOServiceMatching("IOPlatformExpertDevice")
        let service = IOServiceGetMatchingService(kIOMainPortDefault, matching)
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        guard
            let cf = IORegistryEntryCreateCFProperty(
                service, kIOPlatformUUIDKey as CFString, kCFAllocatorDefault, 0
            )?.takeRetainedValue() as? String
        else { return nil }
        return cf
    }
    #endif
}
