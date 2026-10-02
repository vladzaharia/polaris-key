// The Apple runtimes' outlet signals (plans/P3-01.md §2.9, §4.7; notes/S-06 §§1–2).
//
//   signal                    read from
//   ────────────────────────  ──────────────────────────────────────────────────────────────────
//   ios.appDistributor        MarketplaceKit `AppDistributor.current`, behind #available(iOS 17.4)
//                             (the package floor is iOS 17), raced against a deadline: it never
//                             returned on the simulator (S-06 §1), so a timeout records `timeout`,
//                             which is no evidence. Its `web` case exists from iOS 17.5 only.
//   ios.bundleIdRewrite       Info.plist's `ALTBundleIdentifier` (AltStore's rewrite)
//   ios.provisioningProfile   an `embedded.mobileprovision` in the bundle
//   macos.masReceipt          <bundle>/Contents/_MASReceipt/receipt exists
//   macos.receiptSandbox      that receipt contains the ASCII `ProductionSandbox` (TestFlight)
//   macos.signingLeaf         the leaf certificate's common name (SecCodeCopySigningInformation),
//                             `none` for an ad hoc or unsigned bundle. AppTransaction is for
//                             commerce only and is not read
//   macos.homebrewCask        <prefix>/Caskroom/<caskToken>/<version>/<App>.app links to this bundle
//
// The MAPPING is PolarisKeyCore's `detectOutlet`, shared with every SDK and pinned by
// `outlet-matrix.json`. This file only reads markers: it never enumerates installed applications
// (AGENTS rule 7), and it reads a Caskroom only under the product's own cask token. A Developer
// ID leaf is reported without its team name (`Developer ID Application`); every non-store leaf
// vetoes the same way, so nothing is lost. The macOS provisioning profile is not read: S-06
// refuted it as a development-build signal.

import Foundation
import PolarisKeyCore

#if canImport(MarketplaceKit) && os(iOS)
import MarketplaceKit
#endif
#if os(macOS)
import Security
#endif

/// What the readers look at. `OutletReaderEnvironment.process()` is this process's; a test builds
/// one over a faked install. Compared by identity (it holds closures).
public final class OutletReaderEnvironment: Sendable, Equatable {
    /// `macos`, `ios`, or anything else (which reads nothing platform-specific).
    public let platform: String
    /// The app bundle (`/Applications/X.app`), or the executable for a bare tool.
    public let bundlePath: String
    /// The bundle's `CFBundleIdentifier` (iOS: after any AltStore rewrite).
    public let bundleIdentifier: String?
    /// Info.plist's `ALTBundleIdentifier`: the original id, where AltStore rewrote it.
    public let altBundleIdentifier: String?
    /// An `embedded.mobileprovision` is in the bundle (iOS).
    public let hasProvisioningProfile: Bool
    public let fileExists: @Sendable (String) -> Bool
    public let readFile: @Sendable (String) -> Data?
    public let listDirectory: @Sendable (String) -> [String]
    /// A symlink's destination, or nil when the path is not a symlink.
    public let symlinkDestination: @Sendable (String) -> String?
    /// The leaf certificate's common name for a signed path, `none` when unsigned or ad hoc, nil
    /// when the signature could not be read.
    public let signingLeaf: @Sendable (String) -> String?
    /// `AppDistributor.current` as a signal value (`appStore`, `testFlight`,
    /// `marketplace:<id>`, `web`, `other`); nil where MarketplaceKit is unavailable.
    public let appDistributor: (@Sendable () async -> String?)?
    /// The deadline for `appDistributor` (`OUTLET_PLATFORM_DATA.deadlineMs`, 2 s).
    public let deadline: Duration

    public init(
        platform: String,
        bundlePath: String,
        bundleIdentifier: String? = nil,
        altBundleIdentifier: String? = nil,
        hasProvisioningProfile: Bool = false,
        fileExists: @escaping @Sendable (String) -> Bool = { _ in false },
        readFile: @escaping @Sendable (String) -> Data? = { _ in nil },
        listDirectory: @escaping @Sendable (String) -> [String] = { _ in [] },
        symlinkDestination: @escaping @Sendable (String) -> String? = { _ in nil },
        signingLeaf: @escaping @Sendable (String) -> String? = { _ in nil },
        appDistributor: (@Sendable () async -> String?)? = nil,
        deadline: Duration = .milliseconds(OUTLET_PLATFORM_DATA.deadlineMs)
    ) {
        self.platform = platform
        self.bundlePath = bundlePath
        self.bundleIdentifier = bundleIdentifier
        self.altBundleIdentifier = altBundleIdentifier
        self.hasProvisioningProfile = hasProvisioningProfile
        self.fileExists = fileExists
        self.readFile = readFile
        self.listDirectory = listDirectory
        self.symlinkDestination = symlinkDestination
        self.signingLeaf = signingLeaf
        self.appDistributor = appDistributor
        self.deadline = deadline
    }

    public static func == (a: OutletReaderEnvironment, b: OutletReaderEnvironment) -> Bool { a === b }

    /// This process: the main bundle, the real file system, Security and MarketplaceKit.
    public static func process() -> OutletReaderEnvironment {
        let main = Foundation.Bundle.main
        #if os(iOS)
        let platform = "ios"
        #elseif os(macOS)
        let platform = "macos"
        #else
        let platform = "other"
        #endif
        let bundlePath =
            main.bundlePath.hasSuffix(".app") ? main.bundlePath : (main.executablePath ?? main.bundlePath)
        return OutletReaderEnvironment(
            platform: platform,
            bundlePath: bundlePath,
            bundleIdentifier: main.bundleIdentifier,
            altBundleIdentifier: main.object(forInfoDictionaryKey: "ALTBundleIdentifier") as? String,
            hasProvisioningProfile: main.path(forResource: "embedded", ofType: "mobileprovision") != nil,
            fileExists: { FileManager.default.fileExists(atPath: $0) },
            readFile: { FileManager.default.contents(atPath: $0) },
            listDirectory: { (try? FileManager.default.contentsOfDirectory(atPath: $0)) ?? [] },
            symlinkDestination: { try? FileManager.default.destinationOfSymbolicLink(atPath: $0) },
            signingLeaf: { codeSigningLeaf(path: $0) },
            appDistributor: platformAppDistributor())
    }
}

/// `AppDistributor.current` mapped to its signal value, where MarketplaceKit exists (iOS 17.4+).
private func platformAppDistributor() -> (@Sendable () async -> String?)? {
    #if canImport(MarketplaceKit) && os(iOS)
    if #available(iOS 17.4, *) {
        return {
            guard let d = try? await AppDistributor.current else { return "other" }
            switch d {
            case .appStore: return "appStore"
            case .testFlight: return "testFlight"
            case .marketplace(let id): return "marketplace:\(id)"
            case .other: return "other"
            default:
                if #available(iOS 17.5, *), case .web = d { return "web" }
                return "other"
            }
        }
    }
    #endif
    return nil
}

/// The leaf certificate's common name, without a team suffix (`Developer ID Application: X (T)`
/// reads as `Developer ID Application`), or `none` for an ad hoc or unsigned path.
private func codeSigningLeaf(path: String) -> String? {
    #if os(macOS)
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &staticCode) == errSecSuccess,
        let code = staticCode
    else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
        let dict = info as? [String: Any]
    else { return nil }
    guard let certs = dict[kSecCodeInfoCertificates as String] as? [SecCertificate], let leaf = certs.first
    else { return "none" }
    var name: CFString?
    guard SecCertificateCopyCommonName(leaf, &name) == errSecSuccess, let cn = name as String? else { return nil }
    return normalisedLeaf(cn)
    #else
    return nil
    #endif
}

/// `Developer ID Application: Team (ID)` → `Developer ID Application`.
func normalisedLeaf(_ cn: String) -> String {
    guard let colon = cn.firstIndex(of: ":") else { return cn }
    return String(cn[..<colon])
}

/// Claims a one-shot slot: the first caller wins.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

/// Run `op` against `deadline`: its value, or `timeout` when the deadline passes first. The
/// operation is not awaited past the deadline (AppDistributor can hang without honouring
/// cancellation), so a hung call never blocks detection.
func withOutletDeadline(
    _ deadline: Duration, _ op: @escaping @Sendable () async -> String?
) async -> String? {
    await withCheckedContinuation { (cont: CheckedContinuation<String?, Never>) in
        let once = Once()
        let timer = Task {
            try? await Task.sleep(for: deadline)
            if once.claim() { cont.resume(returning: "timeout") }
        }
        Task {
            let value = await op()
            if once.claim() {
                timer.cancel()
                cont.resume(returning: value)
            }
        }
    }
}

/// Read this runtime's outlet signals. Every reader is independent and silent: one that cannot
/// read its marker records nothing. `outletIds` (the stamp's) says which Caskroom to look in.
/// Pass the result, with the stamp, to `detectOutlet`.
public func readOutletSignals(
    _ env: OutletReaderEnvironment = .process(), outletIds: [String: String] = [:]
) async -> [String: JSONValue] {
    var signals: [String: JSONValue] = [:]
    switch env.platform {
    case "ios":
        if let source = env.appDistributor, let value = await withOutletDeadline(env.deadline, source) {
            signals["ios.appDistributor"] = .string(value)
        }
        if let alt = env.altBundleIdentifier {
            signals["ios.bundleIdRewrite"] = .object([
                "runtimeBundleId": env.bundleIdentifier.map(JSONValue.string) ?? .null,
                "altBundleIdentifier": .string(alt),
            ])
        }
        signals["ios.provisioningProfile"] = .bool(env.hasProvisioningProfile)
    case "macos":
        let bundle = env.bundlePath
        if bundle.hasSuffix(".app") {
            let receipt = bundle + "/Contents/_MASReceipt/receipt"
            let exists = env.fileExists(receipt)
            signals["macos.masReceipt"] = .bool(exists)
            if exists {
                let marker = Data("ProductionSandbox".utf8)
                signals["macos.receiptSandbox"] = .bool(env.readFile(receipt)?.range(of: marker) != nil)
            }
            if let token = outletIds["caskToken"], token.range(of: #"^[a-z0-9][a-z0-9@._+-]*$"#, options: .regularExpression) != nil {
                prefixes: for prefix in ["/opt/homebrew", "/usr/local"] {
                    let root = "\(prefix)/Caskroom/\(token)"
                    for version in env.listDirectory(root) {
                        for entry in env.listDirectory("\(root)/\(version)") where entry.hasSuffix(".app") {
                            if env.symlinkDestination("\(root)/\(version)/\(entry)") == bundle {
                                signals["macos.homebrewCask"] = .string(token)
                                break prefixes
                            }
                        }
                    }
                }
            }
        }
        if let leaf = env.signingLeaf(bundle) { signals["macos.signingLeaf"] = .string(normalisedLeaf(leaf)) }
    default:
        break
    }
    return signals
}
