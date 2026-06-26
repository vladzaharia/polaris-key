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
        let base = fallback ?? rawDeviceId() ?? UUID().uuidString
        let digest = SHA256.hash(data: Data("pkey-device:\(productSlug):\(base)".utf8))
        let b64url = Base64URL.encode(Data(digest))
        return String(b64url.prefix(32))
    }

    /// The raw, per-device identifier — never returned to callers directly.
    static func rawDeviceId() -> String? {
        #if os(macOS)
        return macPlatformUUID()
        #elseif os(iOS)
        return UIDevice.current.identifierForVendor?.uuidString
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
