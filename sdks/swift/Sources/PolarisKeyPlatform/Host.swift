// The request router behind the C surface. One JSON object in, one JSON object out:
//
//   {"op": "<name>", …}  →  a synchronous result, or {"ok":true,"req":N} now and, later, one
//                           event {"ev":"<name>","req":N, …result} through the event sink.
//
// Synchronous: ping, capabilities, kc_get, kc_set, kc_delete, app_attest_supported (none of them
// waits on anything). Asynchronous (each in its own detached task; the caller's thread never
// blocks): distributor, app_transaction, products, purchase, entitlements, listen, finish,
// packs_status, packs_ensure, packs_check_updates, packs_remove, packs_url, packs_watch,
// packs_unwatch, app_attest_attest, app_attest_assert (P6-02, AppAttest.swift). Unsolicited events:
// transaction_updated, pack_progress, pack_ready, pack_failed, pack_status.
//
// Every failure is `{"ok":false,"error":"<code>", …}`; an API this OS or build lacks is
// `{"ok":false,"unsupported":true,"reason":"runtime|outlet|version|dependency","detail":…}`
// (PARITY §2.2). The full shapes are in sdks/swift/README.md ("PolarisKeyPlatform").

import Foundation

/// Every seam the router drives. `PlatformServices.system()` is this process's.
public struct PlatformServices: Sendable {
    public var availability: PlatformAvailability
    public var distributor: any DistributorSource
    public var bundleEvidence: @Sendable () -> BundleEvidence
    public var appTransaction: (any AppTransactionSource)?
    public var store: (any StoreClient)?
    public var keychain: (any KeychainBackendBox)?
    public var assetPacks: any AssetPackClient
    public var appAttest: any AppAttestClient

    public init(
        availability: PlatformAvailability, distributor: any DistributorSource,
        bundleEvidence: @escaping @Sendable () -> BundleEvidence, appTransaction: (any AppTransactionSource)?,
        store: (any StoreClient)?, keychain: (any KeychainBackendBox)?, assetPacks: any AssetPackClient,
        appAttest: any AppAttestClient = UnavailableAppAttestClient()
    ) {
        self.availability = availability
        self.distributor = distributor
        self.bundleEvidence = bundleEvidence
        self.appTransaction = appTransaction
        self.store = store
        self.keychain = keychain
        self.assetPacks = assetPacks
        self.appAttest = appAttest
    }

    /// The real system: MarketplaceKit, StoreKit, Security and Background Assets where they exist.
    public static func system() -> PlatformServices {
        let availability = PlatformAvailability.current
        var services = PlatformServices(
            availability: availability, distributor: SystemDistributor(), bundleEvidence: { .mainBundle() },
            appTransaction: nil, store: nil, keychain: nil, assetPacks: UnavailableAssetPackClient())
        #if canImport(StoreKit)
        services.appTransaction = SystemAppTransaction()
        services.store = SystemStoreClient(availability: availability)
        #endif
        #if canImport(Security)
        services.keychain = SystemKeychainBackend()
        #endif
        #if os(iOS) && canImport(DeviceCheck)
        services.appAttest = SystemAppAttestClient()
        #endif
        #if compiler(>=6.3) && canImport(BackgroundAssets) && (os(iOS) || os(macOS))
        if availability.managedAssetPacks, #available(iOS 26.4, macOS 26.4, *) {
            services.assetPacks = SystemAssetPackClient()
        }
        #endif
        return services
    }
}

/// A keychain backend, or nothing where Security does not exist (it lets `PlatformServices`
/// compile where `KeychainBackend` is absent).
#if canImport(Security)
public typealias KeychainBackendBox = KeychainBackend
#else
public protocol KeychainBackendBox: Sendable {}
#endif

/// The router. `PlatformHost.shared` serves the C surface; tests and Swift hosts build their own
/// over fakes.
public final class PlatformHost: Sendable {
    /// The process-wide host the C functions use (created on first use, thread-safe).
    public static let shared = PlatformHost(services: .system())

    /// The C surface's protocol version, bumped on an incompatible shape change.
    public static let protocolVersion = 1

    public let sink: PlatformEventSink
    public let services: PlatformServices
    let store: StoreService?
    let packs: AssetPackService
    let appAttest: AppAttestService
    private let reqCounter = PlatformLock(0)

    public init(services: PlatformServices, sink: PlatformEventSink = PlatformEventSink()) {
        self.services = services
        self.sink = sink
        store = services.store.map { StoreService(client: $0, sink: sink) }
        packs = AssetPackService(client: services.assetPacks, availability: services.availability, sink: sink)
        appAttest = AppAttestService(client: services.appAttest)
    }

    /// The JSON-string form of `handle`.
    public func call(_ json: String) -> String {
        guard let q = decodePlatformJSON(json) else { return encodePlatformJSON(["ok": false, "error": "bad_json"]) }
        return encodePlatformJSON(handle(q))
    }

    private func nextReq() -> Int {
        reqCounter.withLock { n in
            n += 1
            return n
        }
    }

    /// Run `work` in a detached task and deliver its result as the event `op` tagged `req`.
    private func later(_ op: String, _ work: @escaping @Sendable () async -> PlatformObject) -> PlatformObject {
        let req = nextReq()
        let sink = self.sink
        Task.detached {
            var event = await work()
            event["ev"] = .string(op)
            event["req"] = .int(req)
            sink.emit(event)
        }
        return ["ok": true, "req": .int(req)]
    }

    static func unsupported(_ reason: String, _ detail: String) -> PlatformObject {
        ["ok": false, "unsupported": true, "reason": .string(reason), "detail": .string(detail)]
    }

    public func handle(_ q: PlatformObject) -> PlatformObject {
        guard let op = q["op"]?.stringValue else { return ["ok": false, "error": "missing_op"] }
        func str(_ k: String) -> String? { q[k]?.stringValue }

        switch op {
        case "ping":
            return ["ok": true, "mainThread": .bool(Thread.isMainThread), "protocol": .int(Self.protocolVersion)]

        case "capabilities":
            return capabilities()

        case "distributor":
            let deadline = q["deadline"]?.doubleValue ?? defaultDistributorDeadline
            let s = services
            return later(op) {
                await readDistributor(
                    source: s.distributor, evidence: s.bundleEvidence(), availability: s.availability,
                    deadline: deadline)
            }

        case "app_transaction":
            guard let source = services.appTransaction else { return Self.unsupported("runtime", "StoreKit is not available here.") }
            let refresh = q["refresh"]?.boolValue ?? false
            return later(op) { await readAppTransaction(source: source, refresh: refresh) }

        case "products":
            guard let store else { return Self.unsupported("runtime", "StoreKit is not available here.") }
            guard case .array(let raw)? = q["ids"] else { return ["ok": false, "error": "missing_ids"] }
            let ids = raw.compactMap(\.stringValue)
            return later(op) { await store.products(ids) }

        case "purchase":
            guard let store else { return Self.unsupported("runtime", "StoreKit is not available here.") }
            guard let product = str("product") else { return ["ok": false, "error": "missing_product"] }
            var token: UUID?
            if let raw = str("appAccountToken") {
                guard let t = UUID(uuidString: raw) else { return ["ok": false, "error": "bad_app_account_token"] }
                token = t
            }
            let accountToken = token
            // The store reaches StoreKit's main-actor purchase through `await` (one run-loop turn
            // when the host called from the main thread); never MainActor.assumeIsolated.
            return later(op) { await store.purchase(productID: product, appAccountToken: accountToken) }

        case "entitlements":
            guard let store else { return Self.unsupported("runtime", "StoreKit is not available here.") }
            let product = str("product")
            return later(op) { await store.entitlements(productID: product) }

        case "listen":
            guard let store else { return Self.unsupported("runtime", "StoreKit is not available here.") }
            // Asynchronous like every op that touches an actor: the caller (Godot's main thread)
            // never waits. The listener is idempotent, so a second `listen` is harmless.
            return later(op) {
                await store.startListener()
                return ["ok": true]
            }

        case "finish":
            guard let store else { return Self.unsupported("runtime", "StoreKit is not available here.") }
            guard let raw = str("id"), let id = UInt64(raw) else { return ["ok": false, "error": "missing_id"] }
            return later(op) { await store.finish(transactionID: id) }

        case "kc_get", "kc_set", "kc_delete":
            return keychain(op, q)

        case "packs_status":
            guard let id = str("id") else { return ["ok": false, "error": "missing_id"] }
            if let u = packs.unsupported() { return u }
            let packs = self.packs
            return later(op) { await packs.status(id: id) }

        case "packs_ensure":
            var requests: [AssetPackRequest] = []
            if case .array(let list)? = q["packs"] {
                for item in list {
                    guard case .object(let o) = item, let id = o["id"]?.stringValue, let path = o["path"]?.stringValue
                    else { return ["ok": false, "error": "bad_packs"] }
                    requests.append(AssetPackRequest(id: id, path: path))
                }
            } else if let id = str("id"), let path = str("path") {
                requests.append(AssetPackRequest(id: id, path: path))
            }
            guard !requests.isEmpty else { return ["ok": false, "error": "missing_packs"] }
            if let u = packs.unsupported() { return u }
            let latest = q["latest"]?.boolValue ?? false
            let packs = self.packs
            let all = requests
            return later(op) { await packs.ensure(all, requireLatest: latest) }

        case "packs_check_updates":
            if let u = packs.unsupported() { return u }
            let packs = self.packs
            return later(op) { await packs.checkForUpdates() }

        case "packs_remove":
            guard let id = str("id") else { return ["ok": false, "error": "missing_id"] }
            if let u = packs.unsupported() { return u }
            let packs = self.packs
            return later(op) { await packs.remove(id: id) }

        case "packs_url":
            guard let path = str("path") else { return ["ok": false, "error": "missing_path"] }
            if let u = packs.unsupported() { return u }
            let packs = self.packs
            return later(op) { await packs.url(for: path) }

        case "packs_watch", "packs_unwatch":
            guard let id = str("id") else { return ["ok": false, "error": "missing_id"] }
            if let u = packs.unsupported() { return u }
            let packs = self.packs
            let watch = op == "packs_watch"
            return later(op) { watch ? await packs.watch(id: id) : await packs.unwatch(id: id) }

        case "app_attest_supported":
            return appAttest.supported()

        case "app_attest_attest":
            guard let requestHash = str("requestHash"), !requestHash.isEmpty else {
                return ["ok": false, "error": "missing_request_hash"]
            }
            if let keyId = q["keyId"], keyId != .null, keyId.stringValue?.isEmpty ?? true {
                return ["ok": false, "error": "bad_key_id"]
            }
            if let u = appAttest.unsupported() { return u }
            let service = appAttest
            let keyId = str("keyId")
            return later(op) { await service.attest(requestHash: requestHash, keyId: keyId) }

        case "app_attest_assert":
            guard let keyId = str("keyId"), !keyId.isEmpty else { return ["ok": false, "error": "missing_key_id"] }
            guard let clientData = str("clientData") else { return ["ok": false, "error": "missing_client_data"] }
            if let u = appAttest.unsupported() { return u }
            let service = appAttest
            return later(op) { await service.assert(keyId: keyId, clientData: clientData) }

        default:
            return ["ok": false, "error": "unknown_op", "op": .string(op)]
        }
    }

    private func capabilities() -> PlatformObject {
        let a = services.availability
        #if os(iOS)
        let platform = "ios"
        #elseif os(macOS)
        let platform = "macos"
        #else
        let platform = "other"
        #endif
        return [
            "ok": true, "protocol": .int(Self.protocolVersion), "platform": .string(platform),
            "appDistributor": .bool(a.appDistributor), "appDistributorWeb": .bool(a.appDistributorWeb),
            "managedAssetPacks": .bool(a.managedAssetPacks),
            "backgroundAssetsConfigured": .bool(services.assetPacks.configured()),
            "storeKit": .bool(services.store != nil), "keychain": .bool(services.keychain != nil),
            "entitlementsForID": .bool(a.entitlementsForID),
            "appAttest": .bool(appAttest.unsupported() == nil),
        ]
    }

    private func keychain(_ op: String, _ q: PlatformObject) -> PlatformObject {
        #if canImport(Security)
        guard let backend = services.keychain else { return Self.unsupported("runtime", "The Keychain is not available here.") }
        guard let product = q["product"]?.stringValue, let account = q["account"]?.stringValue else {
            return ["ok": false, "error": "missing_product_or_account"]
        }
        let store = SecureStore(product: product, backend: backend)
        switch op {
        case "kc_get": return store.get(account: account)
        case "kc_set":
            guard let value = q["value"]?.stringValue else { return ["ok": false, "error": "missing_value"] }
            return store.set(account: account, value: value)
        default: return store.delete(account: account)
        }
        #else
        return Self.unsupported("runtime", "The Keychain is not available here.")
        #endif
    }
}
