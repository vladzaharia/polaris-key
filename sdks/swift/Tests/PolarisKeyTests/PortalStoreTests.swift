// @pkey-feature ui.kit.holders
//
// The client's holder of `core.portal` (a port of Python's PortalStore): the member discovery gave,
// persisted as `portal.json` for a cold start, and a file that does not read back is deleted.

import Foundation
import PolarisKeyCore
import XCTest

final class PortalStoreTests: XCTestCase {
    private var dir = FileManager.default.temporaryDirectory.appendingPathComponent("ps-\(UUID().uuidString)")

    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private func store(product: String = "djdl", base: String = "https://key.plrs.im") -> PortalStore {
        PortalStore(product: product, baseUrl: base, directory: dir)
    }

    private var on: PortalMember {
        PortalMember(enabled: true, activate: "https://polaris.locker/activate?product=djdl")
    }

    func testAMemberIsPersistedAndLoadedOnACold() {
        store().accept(on)
        let cold = store()
        XCTAssertNil(cold.current())
        cold.loadCached()
        XCTAssertEqual(cold.current(), on)
    }

    func testAnOffMemberRoundTrips() {
        store().accept(PortalMember(enabled: false))
        let cold = store()
        cold.loadCached()
        XCTAssertEqual(cold.current(), PortalMember(enabled: false))
    }

    func testNoMemberClearsTheFile() {
        let s = store()
        s.accept(on)
        s.accept(nil)
        XCTAssertNil(s.current())
        let cold = store()
        cold.loadCached()
        XCTAssertNil(cold.current())
    }

    func testAFileForAnotherProductOrBaseIsDeleted() {
        store().accept(on)
        let other = store(product: "other")
        other.loadCached()
        XCTAssertNil(other.current())
        let again = store()
        again.loadCached()
        XCTAssertNil(again.current(), "the stale file went")
    }

    func testAFileThatDoesNotParseIsDeleted() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(PortalStore.memberFile)
        try Data("not json".utf8).write(to: file)
        let s = store()
        s.loadCached()
        XCTAssertNil(s.current())
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testThisSessionsDiscoveryBeatsTheFile() {
        store().accept(on)
        let s = store()
        s.accept(PortalMember(enabled: false))
        s.loadCached()
        XCTAssertEqual(s.current(), PortalMember(enabled: false))
    }

    func testDiscoveryParsesThePortalMember() {
        let obj: JSONValue = .object([
            "product": .string("djdl"),
            "core": .object([
                "portal": .object([
                    "enabled": .bool(true), "activate": .string("https://polaris.locker/activate?product=djdl"),
                ])
            ]),
            "services": .object([:]),
        ])
        XCTAssertEqual(PortalLink.parse(core: obj.objectValue?["core"]), on)
    }
}
