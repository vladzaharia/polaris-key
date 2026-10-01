// @pkey-feature core.store
// Platform directories (P1b-09 plan §5.4): the Apple table, the legacy config base equal to
// today's, overrides as bases, and the never-throwing backup-exclusion helper.

import Foundation
import PolarisKeyCore
import XCTest

final class DirectoriesTests: XCTestCase {
    private let roots = ProductDirs.Roots(
        config: URL(fileURLWithPath: "/Users/ada/.config", isDirectory: true),
        applicationSupport: URL(
            fileURLWithPath: "/Users/ada/Library/Application Support", isDirectory: true),
        caches: URL(fileURLWithPath: "/Users/ada/Library/Caches", isDirectory: true))

    func testTheAppleTable() {
        let dirs = ProductDirs.resolve(productSlug: "djdl", roots: roots)
        XCTAssertEqual(dirs.config.path, "/Users/ada/.config/djdl")
        XCTAssertEqual(
            dirs.data.path, "/Users/ada/Library/Application Support/polaris-key/data/djdl")
        XCTAssertEqual(dirs.cache.path, "/Users/ada/Library/Caches/polaris-key/djdl")
        XCTAssertEqual(
            dirs.state.path, "/Users/ada/Library/Application Support/polaris-key/state/djdl")
    }

    func testOverridesAreBases() {
        let dirs = ProductDirs.resolve(
            productSlug: "djdl",
            configDir: URL(fileURLWithPath: "/o/config"),
            dataDir: URL(fileURLWithPath: "/o/data"),
            cacheDir: URL(fileURLWithPath: "/o/cache"),
            stateDir: URL(fileURLWithPath: "/o/state"),
            roots: roots)
        XCTAssertEqual(dirs.config.path, "/o/config/djdl")
        XCTAssertEqual(dirs.data.path, "/o/data/djdl")
        XCTAssertEqual(dirs.cache.path, "/o/cache/djdl")
        XCTAssertEqual(dirs.state.path, "/o/state/djdl")
    }

    func testTheLegacyConfigBaseEqualsTodays() {
        #if os(macOS)
        XCTAssertEqual(
            ProductDirs.defaultConfigBase().path,
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".config").path)
        #else
        XCTAssertEqual(
            ProductDirs.defaultConfigBase().path,
            FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
                .first?.path)
        #endif
        // The system roots use FileManager's Application Support and Caches.
        let system = ProductDirs.Roots.system()
        XCTAssertEqual(
            system.applicationSupport.path,
            FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
                .first?.path)
        XCTAssertEqual(
            system.caches.path,
            FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.path)
    }

    func testCoreContextExposesDirsAndCreatesNothing() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("pkey-dirs-\(UUID().uuidString)", isDirectory: true)
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", version: "1.0.0", pinnedKeys: [:],
                store: InMemoryStore(productSlug: "djdl"),
                configDir: base.appendingPathComponent("config"),
                dataDir: base.appendingPathComponent("data"),
                cacheDir: base.appendingPathComponent("cache"),
                stateDir: base.appendingPathComponent("state")))
        XCTAssertEqual(core.dirs.data.path, base.appendingPathComponent("data/djdl").path)
        XCTAssertEqual(core.dirs.cache.path, base.appendingPathComponent("cache/djdl").path)
        XCTAssertEqual(core.dirs.state.path, base.appendingPathComponent("state/djdl").path)
        XCTAssertEqual(core.dirs.config.path, base.appendingPathComponent("config/djdl").path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: base.path))
    }

    func testExcludeFromBackupMarksTheDirectory() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("pkey-exclude-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertEqual(ProductDirs.excludeFromBackup(dir), .excluded)
        let values = try dir.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
        #if os(macOS)
        let tag = try String(
            contentsOf: dir.appendingPathComponent("CACHEDIR.TAG"), encoding: .utf8)
        XCTAssertTrue(tag.hasPrefix(ProductDirs.cachedirTagSignature))
        // A second call is fine.
        XCTAssertEqual(ProductDirs.excludeFromBackup(dir), .excluded)
        #endif
    }

    func testExcludeFromBackupNeverThrows() {
        let missing = URL(fileURLWithPath: "/does/not/exist/\(UUID().uuidString)")
        XCTAssertEqual(ProductDirs.excludeFromBackup(missing), .failed)
        XCTAssertEqual(ProductDirs.BackupExclusion.notApplicable.rawValue, "not-applicable")
    }
}
