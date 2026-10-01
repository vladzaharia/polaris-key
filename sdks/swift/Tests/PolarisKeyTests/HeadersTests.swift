// @pkey-feature core.headers
// Client metadata header values (WIRE-CONTRACT-V3 §5.2), driven off `conformance/corpus/v2`'s
// `headers.json`, mirrored into this bundle's `Resources/v2/` by `pnpm gen:corpus`.
//
// Every row goes through `canonicalPlatform` / `canonicalArch`; the generated
// `PLATFORM_SPELLINGS` / `ARCH_SPELLINGS` must equal the map derived from the non-null rows, with
// values in `PLATFORM_VALUES` / `ARCH_VALUES`. The Node, Python and Godot runners and the Worker
// run the same rows.

import Foundation
import XCTest

@testable import PolarisKeyCore

final class HeadersTests: XCTestCase {
    private struct HeaderCase: Decodable {
        let id: String
        let raw: String
        let expect: String?
    }
    private struct HeadersCorpus: Decodable {
        let headersVersion: Int
        let platformCases: [HeaderCase]
        let archCases: [HeaderCase]
    }

    private func load() throws -> HeadersCorpus {
        try CorpusBundleLoader.load(HeadersCorpus.self, "headers")
    }

    /// ASCII-only folding, restated so the runner does not lean on the code it checks.
    private func fold(_ s: String) -> String {
        String(
            String.UnicodeScalarView(
                s.unicodeScalars.map { $0.value >= 0x41 && $0.value <= 0x5A ? Unicode.Scalar($0.value + 0x20)! : $0 }))
    }

    private func derived(_ rows: [HeaderCase]) -> [String: String] {
        var out: [String: String] = [:]
        for row in rows { if let e = row.expect { out[fold(row.raw)] = e } }
        return out
    }

    private func passes(_ map: (String) -> String?, _ row: HeaderCase) -> Bool {
        map(row.raw) == row.expect
    }

    func testVersionAndFloors() throws {
        let corpus = try load()
        XCTAssertEqual(corpus.headersVersion, 1)
        XCTAssertGreaterThanOrEqual(corpus.platformCases.count, 31)
        XCTAssertGreaterThanOrEqual(corpus.archCases.count, 31)
    }

    func testPlatformCases() throws {
        for row in try load().platformCases {
            XCTAssertEqual(canonicalPlatform(row.raw), row.expect, row.id)
        }
    }

    func testArchCases() throws {
        for row in try load().archCases {
            XCTAssertEqual(canonicalArch(row.raw), row.expect, row.id)
        }
    }

    func testTablesEqualTheRows() throws {
        let corpus = try load()
        XCTAssertEqual(PLATFORM_SPELLINGS, derived(corpus.platformCases))
        XCTAssertEqual(ARCH_SPELLINGS, derived(corpus.archCases))
        for value in PLATFORM_SPELLINGS.values { XCTAssertTrue(PLATFORM_VALUES.contains(value)) }
        for value in ARCH_SPELLINGS.values { XCTAssertTrue(ARCH_VALUES.contains(value)) }
    }

    func testADoctoredRowFails() throws {
        let corpus = try load()
        let row = corpus.platformCases.first { $0.expect != nil }!
        let doctored = HeaderCase(
            id: row.id, raw: row.raw, expect: row.expect == "linux" ? "macos" : "linux")
        XCTAssertTrue(passes(canonicalPlatform, row))
        XCTAssertFalse(passes(canonicalPlatform, doctored))
    }

    /// The compile-time tokens map: a Catalyst build sends `macos` (its token is checked before
    /// `os(iOS)`), and this binary's own header values are its tokens' canonical values.
    func testCompileTimeTokens() {
        XCTAssertEqual(canonicalPlatform("macCatalyst"), "macos")
        XCTAssertEqual(canonicalPlatform("iOS"), "ios")
        XCTAssertEqual(canonicalArch("arm"), "armv7")
        XCTAssertNotNil(PlatformFamily.headerValue)
        XCTAssertNotNil(ArchFamily.headerValue)
        XCTAssertEqual(PlatformFamily.headerValue, PlatformFamily.compileTimeToken.flatMap(canonicalPlatform))
        XCTAssertEqual(ArchFamily.headerValue, ArchFamily.compileTimeToken.flatMap(canonicalArch))
        XCTAssertEqual(POLARIS_SDK_NAME, "swift")
    }
}
