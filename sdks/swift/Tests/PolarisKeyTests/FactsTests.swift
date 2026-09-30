// Device facts and the product-declared probes (wire contract v3 §6). Mirrors the Python SDK's
// facts tests in sdks/python/tests/test_coverage_gaps.py and packages/sdk-node/test/facts.test.ts.
//
// Probes are the privacy-sensitive half of the feature (AGENTS rule 7): a probe answers only for a
// companion app the product declared, and a probe with no target for this platform is omitted —
// reporting it as `present: false` would be a lie an admin cannot tell from "not installed".

import Foundation
import PolarisKeyConfig
import XCTest

// @pkey-feature devices.facts
final class FactsTests: XCTestCase {
    private var dir: URL!
    private var installed: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("pkey-facts-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("installed")
        try Data("x".utf8).write(to: file)
        installed = file.path
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
        try super.tearDownWithError()
    }

    private func everywhere(_ id: String, _ path: String) -> ProbeDeclaration {
        ProbeDeclaration(id: id, macos: path, windows: path, linux: path)
    }

    func testCollectWithNoProbesReportsTheSwiftRuntimeAndNoProbesKey() throws {
        let facts = Facts.collect()
        XCTAssertEqual(facts.runtime.name, "swift")
        XCTAssertFalse(facts.os.name.isEmpty)
        XCTAssertNil(facts.probes)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(facts))
            as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertNil(json?["probes"], "no probes declared means no probes reported")
    }

    func testADeclaredPathThatExistsIsPresent() {
        let results = Facts.runProbes([everywhere("here", installed)])
        XCTAssertEqual(Array(results.keys), ["here"])
        XCTAssertEqual(results["here"]?.present, true)
    }

    func testADeclaredPathThatDoesNotExistIsNotPresent() {
        let missing = dir.appendingPathComponent("missing").path
        let results = Facts.runProbes([everywhere("gone", missing)])
        XCTAssertEqual(Array(results.keys), ["gone"])
        XCTAssertEqual(results["gone"]?.present, false)
        XCTAssertNil(results["gone"]?.version)
    }

    func testAProbeWithNoTargetForThisPlatformIsOmitted() {
        let results = Facts.runProbes([
            everywhere("here", installed),
            ProbeDeclaration(id: "elsewhere"),
        ])
        XCTAssertEqual(Array(results.keys), ["here"])
        XCTAssertEqual(results["here"]?.present, true)
        XCTAssertNil(results["elsewhere"])
    }

    func testCollectCarriesTheDeclaredProbeResults() {
        let facts = Facts.collect(probes: [
            everywhere("here", installed),
            ProbeDeclaration(id: "elsewhere"),
        ])
        XCTAssertEqual(facts.probes.map { Array($0.keys) }, ["here"])
        XCTAssertEqual(facts.probes?["here"]?.present, true)
    }
}
