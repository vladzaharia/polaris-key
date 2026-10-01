// S-06 outlet-signal probe for Apple platforms: the signals that need an app context and Swift
// (MarketplaceKit AppDistributor, StoreKit 2 AppTransaction, Security code-signing info), plus the
// bundle files a pure-language SDK can check. Prints one JSON line prefixed OUTLET_SWIFT_JSON and exits.
// Build: ./build.sh ios-sim | macos   (no Xcode project; swiftc plus a hand-written Info.plist)
import Foundation
import StoreKit
#if os(iOS)
    import MarketplaceKit
    import UIKit
#endif
#if os(macOS)
    import Security
#endif

// Races `body` against a timer and returns whichever finishes first. Unlike a task group it does not
// wait for a body that ignores cancellation (AppDistributor and AppTransaction can hang offline).
final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}

func withTimeout(_ seconds: Double, _ body: @escaping @Sendable () async -> String) async -> String {
    let started = Date()
    let value: String = await withCheckedContinuation { (k: CheckedContinuation<String, Never>) in
        let once = Once()
        Task.detached { let v = await body(); if once.claim() { k.resume(returning: v) } }
        Task.detached {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
            if once.claim() { k.resume(returning: "timeout after \(seconds)s") }
        }
    }
    return value + String(format: " [%.0f ms]", Date().timeIntervalSince(started) * 1000)
}

func probe() async -> [String: String] {
    var r: [String: String] = [:]
    let b = Bundle.main
    r["bundleIdentifier"] = b.bundleIdentifier ?? "nil"
    r["os"] = ProcessInfo.processInfo.operatingSystemVersionString
    #if targetEnvironment(simulator)
        r["simulator"] = "true"
    #endif
    let fm = FileManager.default
    #if os(iOS)
        r["embedded.mobileprovision"] =
            fm.fileExists(atPath: b.bundlePath + "/embedded.mobileprovision") ? "present" : "absent"
    #else
        r["embedded.provisionprofile"] =
            fm.fileExists(atPath: b.bundlePath + "/Contents/embedded.provisionprofile") ? "present" : "absent"
        r["_MASReceipt/receipt"] =
            fm.fileExists(atPath: b.bundlePath + "/Contents/_MASReceipt/receipt") ? "present" : "absent"
    #endif
    if let url = b.appStoreReceiptURL {
        r["appStoreReceiptURL.lastPathComponent"] = url.lastPathComponent
        r["appStoreReceiptURL.exists"] = fm.fileExists(atPath: url.path) ? "true" : "false"
    } else {
        r["appStoreReceiptURL"] = "nil"
    }

    #if os(iOS)
        if #available(iOS 17.4, *) {
            r["AppDistributor.current"] = await withTimeout(Double(ProcessInfo.processInfo.environment["PK_TIMEOUT"] ?? "15") ?? 15) {
                do {
                    let d = try await AppDistributor.current
                    return String(describing: d)
                } catch {
                    return "throws: \(type(of: error)) \(error)"
                }
            }
        } else {
            r["AppDistributor.current"] = "unavailable (< iOS 17.4)"
        }
    #endif

    r["AppTransaction.shared"] = await withTimeout(20) {
        do {
            let v = try await AppTransaction.shared
            switch v {
            case .verified(let t):
                return "verified environment=\(t.environment.rawValue) originalAppVersion=\(t.originalAppVersion)"
            case .unverified(let t, let e):
                return "unverified environment=\(t.environment.rawValue) error=\(e)"
            }
        } catch {
            return "throws: \(type(of: error)) \(error)"
        }
    }

    #if os(macOS)
        var code: SecCode?
        if SecCodeCopySelf([], &code) == errSecSuccess, let code {
            var st: SecStaticCode?
            SecCodeCopyStaticCode(code, [], &st)
            var info: CFDictionary?
            if let st, SecCodeCopySigningInformation(st, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
                let d = info as? [String: Any]
            {
                let certs = (d[kSecCodeInfoCertificates as String] as? [SecCertificate]) ?? []
                r["signing.leafCommonName"] =
                    certs.first.flatMap { c -> String? in
                        var cn: CFString?
                        SecCertificateCopyCommonName(c, &cn)
                        // keep only the kind ("Developer ID Application"), never the name or team
                        return (cn as String?)?.components(separatedBy: ":").first
                    } ?? "none (ad hoc or unsigned)"
                r["signing.chainLength"] = String(certs.count)
                r["signing.teamIdentifierSet"] = d[kSecCodeInfoTeamIdentifier as String] != nil ? "true" : "false"
                let flags = (d[kSecCodeInfoFlags as String] as? UInt32) ?? 0
                r["signing.adhoc"] = (flags & 0x2) != 0 ? "true" : "false"
                let ents = (d[kSecCodeInfoEntitlementsDict as String] as? [String: Any]) ?? [:]
                r["entitlement.app-sandbox"] = String(describing: ents["com.apple.security.app-sandbox"] ?? "absent")
                r["entitlement.beta-reports-active"] = String(describing: ents["beta-reports-active"] ?? "absent")
            }
        }
    #endif
    return r
}

func emit(_ r: [String: String]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: r, options: [.sortedKeys])
    print("OUTLET_SWIFT_JSON " + String(data: data, encoding: .utf8)!)
    fflush(stdout)
    exit(0)
}

#if os(iOS)
    final class AppDelegate: NSObject, UIApplicationDelegate {
        func application(
            _ application: UIApplication, didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]? = nil
        ) -> Bool {
            Task { emit(await probe()) }
            return true
        }
    }

    @main
    struct Main {
        static func main() {
            UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
        }
    }
#else
    @main
    struct Main {
        static func main() async {
            emit(await probe())
        }
    }
#endif
