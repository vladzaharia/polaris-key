// @pkey-feature packs.transport.apple
//
// SP-S08: the store transport seam (`PackPlatformTransport`, the `platform` strategy) and the
// Apple-hosted Background Assets adapter over PolarisKeyPlatform's `AssetPackClient`, against a
// fake platform: the platform moves the bytes, the engine verifies the marker and the bytes against
// the signed record and never fetches a carried pack from the CDN (CONTENT §7, §8.1, §12). The
// device run (TestFlight) is the owner's, as for Godot's P5-08 transport.

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import PolarisKeyPlatform
import PolarisKeyUpdate
import XCTest

/// A platform that holds packs in directories under a temp root and copies a release in on
/// `ensure`.
private final class FakePlatform: PackPlatformTransport, @unchecked Sendable {
    let id = Transport.appleBa
    let feature = Feature.packsTransportApple
    let floats: Bool
    let root: String
    let carried: Set<String>
    private let lock = NSLock()
    private var _available = true
    private var _deliver: [String: TreePack] = [:]
    private var _ensured: [String] = []

    init(root: String, carried: Set<String>, floats: Bool = true) {
        self.root = root
        self.carried = carried
        self.floats = floats
    }

    var available: Bool {
        get { lock.withLock { _available } }
        set { lock.withLock { _available = newValue } }
    }
    var ensured: [String] { lock.withLock { _ensured } }
    func deliver(_ p: TreePack) { lock.withLock { _deliver[p.packId] = p } }

    func carries(_ packId: String) -> Bool { carried.contains(packId) }
    func unavailable() -> Unsupported? {
        available ? nil : Unsupported(feature: feature, reason: UnsupportedReason.version, detail: "test")
    }
    func dir(_ packId: String) -> String { root + "/" + packId }
    func locate(_ packId: String, contentApi: Int) async throws -> String? {
        FileManager.default.fileExists(atPath: dir(packId) + "/.pkey/pack.json") ? dir(packId) : nil
    }
    func ensure(_ packId: String, contentApi: Int, progress: @escaping @Sendable (Int, Int) -> Void) async throws {
        lock.withLock { _ensured.append(packId) }
        guard let p = lock.withLock({ _deliver[packId] }) else { throw TestIOError() }
        try writePlatformCopy(p, to: dir(packId))
        progress(p.size, p.size)
    }
}

private func writePlatformCopy(_ p: TreePack, to dir: String) throws {
    let fm = FileManager.default
    try? fm.removeItem(atPath: dir)
    for (path, bytes) in p.files {
        let full = dir + "/" + path
        try fm.createDirectory(atPath: (full as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try Data(bytes).write(to: URL(fileURLWithPath: full))
    }
    try fm.createDirectory(atPath: dir + "/.pkey", withIntermediateDirectories: true)
    try Data(markerFor(p).utf8).write(to: URL(fileURLWithPath: dir + "/.pkey/pack.json"))
}

private func tempRoot() -> String {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("pk-platform-\(UUID().uuidString)").path
    try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
}

private func engine(
    _ server: ByteServer, _ storage: MemoryPackStorage, stamp: AppContent, platform: (any PackPlatformTransport)?
) -> PackEngine {
    PackEngine(
        PackEngineOptions(
            product: PackFixtures.product, releaseKeys: PackFixtures.releaseKeys,
            productTrust: { PackFixtures.productTrust }, stamp: stamp, zstd: LibZstd(),
            patchMethods: ["zstd-patch-from"], memBudget: 1 << 30, strategies: ["delta", "file", "full"],
            storage: storage, state: memoryPackStateStore(), fetchRecord: server.fetchRecord,
            fetchObject: server.fetchObject, now: { 1_759_400_000 }, platform: platform))
}

private func code(_ body: () async throws -> Void) async -> String? {
    do {
        try await body()
        return nil
    } catch let e as PackError {
        return e.code
    } catch {
        return "other: \(error)"
    }
}

final class PlatformTransportTests: XCTestCase {
    func testAHeldPlatformCopyIsInstalledStateAndTheCdnIsNeverAsked() async throws {
        let (v1, _, _) = packReleases()
        let platform = FakePlatform(root: tempRoot(), carried: [v1.packId])
        try writePlatformCopy(v1, to: platform.dir(v1.packId))
        let storage = memoryPackStorage()
        storage.store[platform.dir(v1.packId)] = MemoryPayload(layout: "tree", payload: nil, tree: v1.files, index: nil)
        let server = ByteServer(v1)
        let e = engine(server, storage, stamp: stampFor(v1), platform: platform)
        let refused = try await e.load()
        XCTAssertTrue(refused.isEmpty)
        let i = try await e.ensure([v1.packId])[0]
        XCTAssertEqual(i.embedded, true)
        XCTAssertEqual(i.location, platform.dir(v1.packId))
        XCTAssertEqual(i.recordSha256, v1.recordSha256)
        XCTAssertTrue(platform.ensured.isEmpty)
        XCTAssertEqual(server.calls.count, 0)
    }

    func testAMissingCopyIsDeliveredByThePlatformAndVerifiedAgainstTheRecord() async throws {
        let (v1, _, _) = packReleases()
        let platform = FakePlatform(root: tempRoot(), carried: [v1.packId])
        platform.deliver(v1)
        let storage = memoryPackStorage()
        storage.store[platform.dir(v1.packId)] = MemoryPayload(layout: "tree", payload: nil, tree: v1.files, index: nil)
        let server = ByteServer(v1)
        let e = engine(server, storage, stamp: stampFor(v1), platform: platform)
        _ = try await e.load()
        let i = try await e.ensure([v1.packId])[0]
        XCTAssertEqual(platform.ensured, [v1.packId])
        XCTAssertEqual(i.location, platform.dir(v1.packId))
        XCTAssertEqual(i.embedded, true)
        // The signed record came from the CDN by hash; no payload object did.
        XCTAssertEqual(server.calls.count, 0)
        // A second ensure is current: the copy stands as the install, nothing is delivered again.
        _ = try await e.ensure([v1.packId])
        XCTAssertEqual(platform.ensured, [v1.packId])
    }

    func testDeliveredBytesThatDoNotMatchTheRecordAreRefused() async throws {
        let (v1, v2, _) = packReleases()
        let platform = FakePlatform(root: tempRoot(), carried: [v1.packId], floats: false)
        // The platform delivers another release than the pinned one, and may not float.
        platform.deliver(v2)
        let e = engine(ByteServer(v1, v2), memoryPackStorage(), stamp: stampFor(v1), platform: platform)
        _ = try await e.load()
        let c = await code { _ = try await e.ensure([v1.packId]) }
        XCTAssertEqual(c, ErrorCode.recordMismatch)
    }

    func testAFloatingPlatformMayHoldALaterRelease() async throws {
        let (v1, v2, _) = packReleases()
        let platform = FakePlatform(root: tempRoot(), carried: [v1.packId])
        try writePlatformCopy(v2, to: platform.dir(v1.packId))
        let storage = memoryPackStorage()
        storage.store[platform.dir(v1.packId)] = MemoryPayload(layout: "tree", payload: nil, tree: v2.files, index: nil)
        let e = engine(ByteServer(v1, v2), storage, stamp: stampFor(v1), platform: platform)
        let loaded = try await e.load()
        XCTAssertTrue(loaded.isEmpty)
        let i = try await e.ensure([v1.packId])[0]
        XCTAssertEqual(i.recordSha256, v2.recordSha256)

        // Without floating the later copy is refused at load (pin).
        let pinned = FakePlatform(root: platform.root, carried: [v1.packId], floats: false)
        let refused = try await engine(ByteServer(v1, v2), storage, stamp: stampFor(v1), platform: pinned).load()
        XCTAssertEqual(refused.map(\.step), ["pin"])
    }

    func testAnUnavailablePlatformRefusesTheCarriedPackWithoutACdnFallback() async throws {
        let (v1, _, _) = packReleases()
        let platform = FakePlatform(root: tempRoot(), carried: [v1.packId])
        platform.available = false
        let server = ByteServer(v1)
        let e = engine(server, memoryPackStorage(), stamp: stampFor(v1), platform: platform)
        _ = try await e.load()
        let c = await code { _ = try await e.ensure([v1.packId]) }
        XCTAssertEqual(c, ErrorCode.planTransportUnsupported)
        XCTAssertEqual(server.calls.count, 0)
        XCTAssertTrue(platform.ensured.isEmpty)
    }

    func testAppleAssetPackIdsFollowTheManifestMapping() {
        XCTAssertEqual(appleAssetPackId("diceroll.foes", contentApi: 3), "diceroll-foes-c3")
        XCTAssertEqual(appleAssetPackId("djdl.l10n", contentApi: 0), "djdl-l10n-c0")
        XCTAssertNil(appleAssetPackId("Bad.Upper", contentApi: 1))
        XCTAssertNil(appleAssetPackId("a..b", contentApi: 1))
        XCTAssertNil(appleAssetPackId("a.b", contentApi: -1))
        XCTAssertNil(appleAssetPackId(String(repeating: "a", count: 62), contentApi: 10))
        let t = AppleAssetPackTransport(packs: ["diceroll.foes"], client: FakeAssetPacks(root: "/x"), availability: .none)
        XCTAssertEqual(t.assetPack("diceroll.foes", contentApi: 3)?.path, "pkey/diceroll-foes-c3")
        XCTAssertEqual(t.id, Transport.appleBa)
        XCTAssertTrue(t.floats)
    }

    func testTheAppleTransportAnswersTypedUnsupported() {
        let below = AppleAssetPackTransport(packs: ["a"], client: FakeAssetPacks(root: "/x"), availability: .none)
        XCTAssertEqual(below.unavailable()?.reason, UnsupportedReason.version)
        XCTAssertEqual(below.unavailable()?.feature, Feature.packsTransportApple)
        var avail = PlatformAvailability.none
        avail.managedAssetPacks = true
        let unconfigured = FakeAssetPacks(root: "/x")
        unconfigured.isConfigured = false
        XCTAssertEqual(
            AppleAssetPackTransport(packs: ["a"], client: unconfigured, availability: avail).unavailable()?.reason,
            UnsupportedReason.outlet)
        XCTAssertNil(AppleAssetPackTransport(packs: ["a"], client: FakeAssetPacks(root: "/x"), availability: avail).unavailable())
    }

    func testTheAppleTransportInstallsThroughTheEngine() async throws {
        let (v1, _, _) = packReleases()
        let root = tempRoot()
        let packs = FakeAssetPacks(root: root)
        packs.onEnsure = { asset in
            XCTAssertEqual(asset, "djdl-l10n-c1")
            try writePlatformCopy(v1, to: root + "/pkey/" + asset)
        }
        var avail = PlatformAvailability.none
        avail.managedAssetPacks = true
        let t = AppleAssetPackTransport(packs: [v1.packId], client: packs, availability: avail)
        let dir = root + "/pkey/djdl-l10n-c1"
        let storage = memoryPackStorage()
        storage.store[dir] = MemoryPayload(layout: "tree", payload: nil, tree: v1.files, index: nil)
        let server = ByteServer(v1)
        let e = engine(server, storage, stamp: stampFor(v1), platform: t)
        _ = try await e.load()
        let i = try await e.ensure([v1.packId])[0]
        XCTAssertEqual(i.location, dir)
        XCTAssertEqual(server.calls.count, 0)
        XCTAssertEqual(packs.ensured, ["djdl-l10n-c1"])
    }
}

/// `AssetPackClient` over a directory: `url(for:)` resolves under `root`, `ensure` runs `onEnsure`.
private final class FakeAssetPacks: AssetPackClient, @unchecked Sendable {
    let root: String
    private let lock = NSLock()
    private var _configured = true
    private var _ensured: [String] = []
    private var _onEnsure: (@Sendable (String) throws -> Void)?

    init(root: String) { self.root = root }
    var isConfigured: Bool {
        get { lock.withLock { _configured } }
        set { lock.withLock { _configured = newValue } }
    }
    var ensured: [String] { lock.withLock { _ensured } }
    var onEnsure: (@Sendable (String) throws -> Void)? {
        get { lock.withLock { _onEnsure } }
        set { lock.withLock { _onEnsure = newValue } }
    }

    func configured() -> Bool { isConfigured }
    func info(id: String) async throws -> AssetPackInfo { AssetPackInfo(id: id, version: 1, downloadSize: 0) }
    func localStatus(id: String) async -> AssetPackStatus {
        AssetPackStatus(ensured.contains(id) ? ["downloaded", "upToDate"] : ["downloadAvailable"])
    }
    func ensure(id: String, requireLatest: Bool) async throws {
        try onEnsure?(id)
        lock.withLock { _ensured.append(id) }
    }
    func checkForUpdates() async throws -> (updating: [String], removed: [String]) { ([], []) }
    func remove(id: String) async throws {}
    func url(for path: String) throws -> String { root + "/" + path }
    func fileExists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }
    func statusUpdates(id: String) -> AsyncStream<AssetPackProgress> { AsyncStream { $0.finish() } }
}
