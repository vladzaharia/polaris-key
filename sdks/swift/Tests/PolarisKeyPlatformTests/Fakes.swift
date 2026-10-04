// Fakes for every PolarisKeyPlatform seam. `swift test` cannot reach StoreKit Testing (no
// products load without a hosted app carrying get-task-allow), the Keychain (-34018 without a
// host app), AppDistributor (iOS only, and it never resolves on the simulator) or Background
// Assets (it traps in an unconfigured process), so every module is driven through these.

import Foundation
import XCTest

@testable import PolarisKeyPlatform

// ── Availability presets ─────────────────────────────────────────────────────────────────────

extension PlatformAvailability {
    /// iOS 17.0–17.3: no AppDistributor.
    static let iOS17_0 = PlatformAvailability(appDistributor: false, appDistributorWeb: false, managedAssetPacks: false)
    /// iOS 17.4: AppDistributor without the `web` case.
    static let iOS17_4 = PlatformAvailability(appDistributor: true, appDistributorWeb: false, managedAssetPacks: false)
    /// iOS 17.5–26.3: AppDistributor with `web`; managed asset packs still unavailable.
    static let iOS26_3 = PlatformAvailability(appDistributor: true, appDistributorWeb: true, managedAssetPacks: false)
    /// iOS 26.4+: everything this target uses.
    static let iOS26_4 = PlatformAvailability(
        appDistributor: true, appDistributorWeb: true, managedAssetPacks: true, entitlementsForID: true)
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────

/// Collects a sink's events through its Swift observer.
final class EventLog: Sendable {
    private let events = PlatformLock<[PlatformObject]>([])

    init(_ sink: PlatformEventSink) {
        sink.setObserver { [events] e in events.withLock { $0.append(e) } }
    }

    var all: [PlatformObject] { events.withLock { $0 } }

    func named(_ ev: String) -> [PlatformObject] { all.filter { $0["ev"] == .string(ev) } }

    /// Wait (polling) until `predicate` holds over the events, or fail after `timeout` seconds.
    func wait(
        _ timeout: Double = 5, file: StaticString = #filePath, line: UInt = #line,
        until predicate: @escaping ([PlatformObject]) -> Bool
    ) async -> [PlatformObject] {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            let now = all
            if predicate(now) { return now }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for events; got \(all)", file: file, line: line)
        return all
    }

    /// The event answering request `req`.
    func result(_ req: PlatformJSON?, timeout: Double = 5, file: StaticString = #filePath, line: UInt = #line) async
        -> PlatformObject
    {
        let found = await wait(timeout, file: file, line: line) { $0.contains { $0["req"] == req } }
        return found.first { $0["req"] == req } ?? [:]
    }
}

// ── Distributor ──────────────────────────────────────────────────────────────────────────────

struct FakeDistributor: DistributorSource {
    enum Behaviour: Sendable {
        case answer(DistributorCase)
        case fail(String)
        case unavailable
        case hang
    }

    let behaviour: Behaviour
    let calls = PlatformLock(0)

    init(_ behaviour: Behaviour) { self.behaviour = behaviour }

    func current() async throws -> DistributorCase {
        calls.withLock { $0 += 1 }
        switch behaviour {
        case .answer(let d): return d
        case .fail(let message): throw NSError(domain: "FakeDistributor", code: 7, userInfo: [NSLocalizedDescriptionKey: message])
        case .unavailable: throw PlatformUnavailable(reason: "version", detail: "fake")
        case .hang:
            // Never answers in test time, like AppDistributor.current on the simulator.
            try? await Task.sleep(nanoseconds: 3_600_000_000_000)
            return .appStore
        }
    }
}

// ── AppTransaction ───────────────────────────────────────────────────────────────────────────

struct FakeAppTransaction: AppTransactionSource {
    var info: AppTransactionInfo?
    var hang = false

    func read(refresh: Bool) async throws -> AppTransactionInfo {
        if hang { try? await Task.sleep(nanoseconds: 3_600_000_000_000) }
        guard var info else { throw NSError(domain: "StoreKitError", code: 0, userInfo: [NSLocalizedDescriptionKey: "unknown"]) }
        if refresh { info.appVersion += "-refreshed" }
        return info
    }
}

// ── StoreKit ─────────────────────────────────────────────────────────────────────────────────

/// A StoreKit stand-in with a controllable `Transaction.updates`.
final class FakeStoreClient: StoreClient, @unchecked Sendable {
    let catalog: [ProductInfo]
    private let lock = NSLock()
    private var loaded: Set<String> = []
    private var nextOutcome: PurchaseOutcome = .userCancelled
    private var entitlementList: [TransactionInfo] = []
    private var finishedIDs: [UInt64] = []
    private var continuation: AsyncStream<TransactionInfo>.Continuation?
    private(set) var purchaseOnMainThread: Bool?

    init(catalog: [ProductInfo]) { self.catalog = catalog }

    func willPurchase(_ outcome: PurchaseOutcome) { lock.withLock { nextOutcome = outcome } }
    func setEntitlements(_ list: [TransactionInfo]) { lock.withLock { entitlementList = list } }
    var finished: [UInt64] { lock.withLock { finishedIDs } }

    /// Deliver `t` through `updates()`, as `Transaction.updates` would.
    func deliver(_ t: TransactionInfo) { lock.withLock { continuation }?.yield(t) }

    func products(_ ids: [String]) async throws -> [ProductInfo] {
        let found = catalog.filter { ids.contains($0.id) }
        lock.withLock { loaded.formUnion(found.map(\.id)) }
        return found
    }

    @MainActor
    func purchase(productID: String, appAccountToken: UUID?) async throws -> PurchaseOutcome {
        lock.withLock { purchaseOnMainThread = Thread.isMainThread }
        guard lock.withLock({ loaded.contains(productID) }) else { throw ProductNotLoaded(productID: productID) }
        return lock.withLock { nextOutcome }
    }

    func currentEntitlements(productID: String?) async -> [TransactionInfo] {
        lock.withLock { entitlementList }.filter { productID == nil || $0.productID == productID }
    }

    func updates() -> AsyncStream<TransactionInfo> {
        AsyncStream { c in lock.withLock { continuation = c } }
    }

    func finish(transactionID: UInt64) async -> Bool {
        lock.withLock {
            guard !finishedIDs.contains(transactionID) else { return false }
            finishedIDs.append(transactionID)
            return true
        }
    }
}

func transaction(_ id: UInt64, product: String = "pack.foes", revoked: Bool = false) -> TransactionInfo {
    TransactionInfo(
        id: id, originalID: id, productID: product, environment: "Xcode",
        appAccountToken: "6f2c3b1a-0000-4000-8000-00000000c0de", revoked: revoked, revocationReason: revoked ? 0 : nil,
        jws: "eyJhbGciOiJFUzI1NiJ9.\(id).\(revoked ? "revoked" : "sig")")
}

#if canImport(Security)
// ── Keychain ─────────────────────────────────────────────────────────────────────────────────

/// An in-memory keychain that records every query it is given.
final class FakeKeychain: KeychainBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    private(set) var queries: [[String: Any]] = []
    private(set) var added: [[String: Any]] = []
    private(set) var updates: [[String: Any]] = []
    var failWith: OSStatus?

    private func key(_ q: [String: Any]) -> String {
        "\(q[kSecAttrService as String] ?? "")|\(q[kSecAttrAccount as String] ?? "")"
    }

    func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?) {
        lock.withLock {
            queries.append(query)
            if let failWith { return (failWith, nil) }
            guard let d = items[key(query)] else { return (errSecItemNotFound, nil) }
            return (errSecSuccess, d)
        }
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        lock.withLock {
            added.append(attributes)
            if let failWith { return failWith }
            items[key(attributes)] = attributes[kSecValueData as String] as? Data
            return errSecSuccess
        }
    }

    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        lock.withLock {
            queries.append(query)
            updates.append(attributes)
            if let failWith { return failWith }
            guard items[key(query)] != nil else { return errSecItemNotFound }
            items[key(query)] = attributes[kSecValueData as String] as? Data
            return errSecSuccess
        }
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        lock.withLock {
            queries.append(query)
            if let failWith { return failWith }
            return items.removeValue(forKey: key(query)) == nil ? errSecItemNotFound : errSecSuccess
        }
    }
}
#else
/// No Keychain off Apple platforms.
final class FakeKeychain: KeychainBackendBox, @unchecked Sendable {}
#endif

// ── Background Assets ────────────────────────────────────────────────────────────────────────

/// An AssetPackManager stand-in: per-pack status, ensure behaviour and files on "disk".
final class FakeAssetPackClient: AssetPackClient, @unchecked Sendable {
    private let lock = NSLock()
    let isConfigured: Bool
    var statuses: [String: AssetPackStatus] = [:]
    /// Ensure throws this message for the pack, after optionally changing its status.
    var ensureErrors: [String: String] = [:]
    /// The status a pack has after ensure (success or failure).
    var afterEnsure: [String: AssetPackStatus] = [:]
    var files: Set<String> = []
    var versions: [String: Int] = [:]
    var progress: [String: [AssetPackProgress]] = [:]
    private(set) var ensured: [(String, Bool)] = []
    private(set) var removed: [String] = []
    var updating: [String] = []

    init(configured: Bool = true) { isConfigured = configured }

    func configured() -> Bool { isConfigured }

    func info(id: String) async throws -> AssetPackInfo {
        guard let v = lock.withLock({ versions[id] }) else {
            throw NSError(domain: "BAManagedErrorDomain", code: 0, userInfo: [NSLocalizedDescriptionKey: "No asset pack with the ID \(id) was found"])
        }
        return AssetPackInfo(id: id, version: v, downloadSize: 1024)
    }

    func localStatus(id: String) async -> AssetPackStatus { lock.withLock { statuses[id] ?? AssetPackStatus(["downloadAvailable"]) } }

    func ensure(id: String, requireLatest: Bool) async throws {
        // Let the progress forwarder subscribe and drain before the call returns.
        try? await Task.sleep(nanoseconds: 50_000_000)
        let error: String? = lock.withLock {
            ensured.append((id, requireLatest))
            if let s = afterEnsure[id] { statuses[id] = s }
            return ensureErrors[id]
        }
        if let error {
            throw NSError(domain: "ManagedBackgroundAssetsXPC.XPCInvocationError", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
        }
    }

    func checkForUpdates() async throws -> (updating: [String], removed: [String]) { (lock.withLock { updating }, []) }

    func remove(id: String) async throws { lock.withLock { removed.append(id) } }

    func url(for path: String) throws -> String { "/staging/\(path)" }

    func fileExists(_ path: String) -> Bool { lock.withLock { files.contains(path) } }

    func statusUpdates(id: String) -> AsyncStream<AssetPackProgress> {
        let updates = lock.withLock { progress[id] ?? [] }
        return AsyncStream { c in
            for u in updates { c.yield(u) }
            c.finish()
        }
    }

    var ensureCalls: [(String, Bool)] { lock.withLock { ensured } }
    var removeCalls: [String] { lock.withLock { removed } }
}

// ── Services ─────────────────────────────────────────────────────────────────────────────────

func fakeServices(
    availability: PlatformAvailability = .iOS26_4,
    distributor: FakeDistributor = FakeDistributor(.answer(.appStore)),
    evidence: BundleEvidence = BundleEvidence(provisioned: false, bundleIdentifier: "gg.vlad.diceroll"),
    appTransaction: FakeAppTransaction? = nil,
    store: FakeStoreClient? = nil,
    keychain: FakeKeychain? = nil,
    packs: FakeAssetPackClient = FakeAssetPackClient(),
    appAttest: any AppAttestClient = UnavailableAppAttestClient()
) -> PlatformServices {
    PlatformServices(
        availability: availability, distributor: distributor, bundleEvidence: { evidence },
        appTransaction: appTransaction, store: store, keychain: keychain, assetPacks: packs, appAttest: appAttest)
}

// ── App Attest ───────────────────────────────────────────────────────────────────────────────

/// DCAppAttestService in memory: keys it generated are known until `forget` (a reinstall);
/// `failNext` makes the next attest or assert throw that failure code.
final class FakeAppAttest: AppAttestClient, @unchecked Sendable {
    private let lock = NSLock()
    private var known: Set<String> = []
    private var serial = 0
    private var nextFailure: String?
    private(set) var attested: [(keyId: String, hash: Data)] = []
    private(set) var asserted: [(keyId: String, hash: Data)] = []
    let supported: Bool
    var hang = false

    init(supported: Bool = true) { self.supported = supported }

    func failNext(_ code: String) { lock.withLock { nextFailure = code } }

    /// The system forgets every key (reinstall, device migration, restore).
    func forget() { lock.withLock { known.removeAll() } }

    func unavailable() -> PlatformUnavailable? {
        supported ? nil : PlatformUnavailable(reason: "runtime", detail: "fake: App Attest is not supported")
    }

    func generateKey() async throws -> String {
        lock.withLock {
            serial += 1
            let id = Data("fake-key-\(serial)".utf8).base64EncodedString()
            known.insert(id)
            return id
        }
    }

    private func check(_ keyId: String) throws {
        try lock.withLock {
            if let code = nextFailure {
                nextFailure = nil
                throw AppAttestFailure(code: code, message: "fake \(code)")
            }
            guard known.contains(keyId) else {
                throw AppAttestFailure(code: AppAttestFailure.invalidKey, message: "fake: unknown key")
            }
        }
    }

    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data {
        if hang { try? await Task.sleep(nanoseconds: 3_600_000_000_000) }
        try check(keyId)
        lock.withLock { attested.append((keyId, clientDataHash)) }
        return Data("attestation:\(keyId)".utf8)
    }

    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data {
        try check(keyId)
        lock.withLock { asserted.append((keyId, clientDataHash)) }
        return Data("assertion:\(keyId)".utf8)
    }
}
