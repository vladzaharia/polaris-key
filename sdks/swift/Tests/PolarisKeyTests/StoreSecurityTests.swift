// KeychainStore file-handling regressions: R4-09 (created world-readable, then chmod'd, with
// both calls error-swallowed), R4-10 (no symlink guard on either the read or the write path)
// and R4-12 (a swallowed device-id write mints a fresh random id — and burns a seat — on
// every launch).

import Foundation
import XCTest

@testable import PolarisKey

final class StoreSecurityTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("pkey-store-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var cacheURL: URL {
        root.appendingPathComponent("djdl").appendingPathComponent("managed.json")
    }

    private func mode(of url: URL) throws -> Int {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    /// The cache first contains `payload.secrets` on its FIRST write — which is exactly the
    /// write that `Data.write(.atomic)` performed at the ambient umask (measured 0644) before
    /// chmod'ing. `open(2)` applies the mode at creation instead, so there is no window.
    func testCacheFileIsCreatedAt0600() async throws {
        let store = KeychainStore(productSlug: "djdl", configDir: root)
        try await store.writeCache(CacheRecord(configJws: "a.b.c"))
        XCTAssertEqual(try mode(of: cacheURL), 0o600)
    }

    /// A pre-existing over-permissive file — restored from a backup, or left behind by an
    /// older build — is repaired, since a creation mode only applies to a NEW file (R4-10).
    func testPreExistingLooseModeIsRepaired() async throws {
        let store = KeychainStore(productSlug: "djdl", configDir: root)
        try Data("{}".utf8).write(to: cacheURL)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o666], ofItemAtPath: cacheURL.path)
        try await store.writeCache(CacheRecord(configJws: "a.b.c"))
        XCTAssertEqual(try mode(of: cacheURL), 0o600)
    }

    /// Swift had no `O_NOFOLLOW` equivalent at all: `.atomic` happily replaced a planted
    /// symlink, and both read paths followed one. Now both refuse.
    func testSymlinkIsRefusedOnWriteAndRead() async throws {
        let store = KeychainStore(productSlug: "djdl", configDir: root)
        let target = root.appendingPathComponent("elsewhere.json")
        try Data(#"{"v":2,"configJws":"planted"}"#.utf8).write(to: target)
        try FileManager.default.createSymbolicLink(at: cacheURL, withDestinationURL: target)

        do {
            try await store.writeCache(CacheRecord(configJws: "a.b.c"))
            XCTFail("writing through a symlink must be refused")
        } catch StoreError.symlink {
            // expected
        }
        XCTAssertEqual(
            String(data: try Data(contentsOf: target), encoding: .utf8),
            #"{"v":2,"configJws":"planted"}"#,
            "the symlink target must not have been written through")

        // The read path refuses too — and fails CLOSED, as no cache at all.
        let read = await store.readCache()
        XCTAssertNil(read)
    }

    /// A swallowed device-id write produced a NEW random id on every launch on any host
    /// without a hardware id — a new device row, and a consumed seat, each time.
    func testDeviceIdIsStableAndAFailedWriteIsSurfaced() async throws {
        let store = KeychainStore(productSlug: "djdl", configDir: root)
        let first = try await store.getDeviceId()
        let second = try await store.getDeviceId()
        XCTAssertEqual(first, second)
        XCTAssertFalse(first.isEmpty)

        // Now make the directory unwritable: the failure must surface, NOT be papered over
        // with a fresh id.
        let locked = root.appendingPathComponent("locked", isDirectory: true)
        let productDir = locked.appendingPathComponent("djdl", isDirectory: true)
        try FileManager.default.createDirectory(at: productDir, withIntermediateDirectories: true)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o500], ofItemAtPath: productDir.path)
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700], ofItemAtPath: productDir.path)
        }
        let blocked = KeychainStore(productSlug: "djdl", configDir: locked)
        do {
            _ = try await blocked.getDeviceId()
            XCTFail("an unwritable config dir must surface, not mint a new device id")
        } catch StoreError.io {
            // expected
        }
    }

    /// A round trip through the real file store, including the fail-closed hints.
    func testCacheRoundTrip() async throws {
        let store = KeychainStore(productSlug: "djdl", configDir: root)
        let record = CacheRecord(
            configJws: "a.b.c", trustJws: "d.e.f", etag: "v9",
            lastSyncUnauthorized: true,
            blocked: BlockInfoRecord(reason: .versionTooOld, allowedRange: AllowedRange(min: "1")))
        try await store.writeCache(record)
        let loaded = await store.readCache()
        XCTAssertEqual(loaded, record)

        try await store.clearCache()
        let gone = await store.readCache()
        XCTAssertNil(gone)
        // Clearing an already-absent cache is not an error.
        try await store.clearCache()
    }
}
