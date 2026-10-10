// @pkey-feature core.errors
// Every error code this SDK raises is in the shared registry (conformance/parity/errors.json,
// generated into `Constants.generated.swift` by `pnpm gen constants`).
//
// The code constants are checked directly (`PolarisError`'s client-side codes and every
// `BundleRefusalReason`), and `Sources/` is scanned for `PolarisError(code: "<code>", …)`
// literals, including a `?? "<code>"` fallback. A new code goes into errors.json first; then
// this test passes.

import Foundation
import PolarisKeyCore
import XCTest

final class ErrorCodeRegistryTests: XCTestCase {
    private static let raised = try! NSRegularExpression(
        pattern: #"\bPolarisError\(\s*code:\s*(?:[^,]*?\?\?\s*)?"([a-z][a-z0-9_-]*)""#)

    /// Every code literal one source text raises.
    static func raisedCodes(_ text: String) -> [String] {
        let range = NSRange(text.startIndex..., in: text)
        return raised.matches(in: text, range: range).compactMap { match in
            Range(match.range(at: 1), in: text).map { String(text[$0]) }
        }
    }

    /// The raised codes the registry lacks, each with where it was seen.
    static func unregistered(_ files: [(path: String, text: String)], registry: [String])
        -> [String]
    {
        let known = Set(registry)
        return files.flatMap { file in
            raisedCodes(file.text).filter { !known.contains($0) }.map { "\(file.path): \"\($0)\"" }
        }
    }

    private static func sources(filePath: String = #filePath) throws -> [(
        path: String, text: String
    )] {
        let root = URL(fileURLWithPath: filePath)
            .deletingLastPathComponent()  // PolarisKeyTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // the package
            .appendingPathComponent("Sources")
        let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
        var files: [(path: String, text: String)] = []
        while let url = walker?.nextObject() as? URL {
            guard url.pathExtension == "swift", !url.lastPathComponent.contains(".generated.")
            else { continue }
            let path = String(url.path.dropFirst(root.path.count + 1))
            files.append((path, try String(contentsOf: url, encoding: .utf8)))
        }
        return files.sorted { $0.path < $1.path }
    }

    func testEveryCodeSourcesRaiseIsRegistered() throws {
        let files = try Self.sources()
        XCTAssertGreaterThan(files.count, 10)
        let raised = Set(files.flatMap { Self.raisedCodes($0.text) })
        for code in ["bad_request", "not_found", "forbidden", "device_list_failed", "transport"] {
            XCTAssertTrue(raised.contains(code), code)
        }
        XCTAssertEqual(Self.unregistered(files, registry: ERROR_CODE_VALUES), [])
    }

    func testCodeConstantsAreRegistered() {
        let known = Set(ERROR_CODE_VALUES)
        let constants =
            [
                PolarisError.insecureBaseUrl,
                PolarisError.localOnly,
                PolarisError.serviceUnavailable,
                PolarisError.deviceManagementUnsupported,
            ] + BundleRefusalReason.allCases.map(\.rawValue)
        for code in constants {
            XCTAssertTrue(known.contains(code), code)
        }
    }

    func testFailsOnAnUnregisteredLiteral() {
        let fixture = (
            path: "Fixture.swift",
            text: """
                throw PolarisError(code: "local-only", message: "registered")
                throw PolarisError(code: "brand-new-code", message: "not registered")
                throw PolarisError(
                    code: body?.error?.code ?? "another_new_code", message: "fallback")
                """
        )
        XCTAssertEqual(
            Self.unregistered([fixture], registry: ERROR_CODE_VALUES),
            ["Fixture.swift: \"brand-new-code\"", "Fixture.swift: \"another_new_code\""])
    }

    func testTheGeneratedModuleIsTheRegistry() {
        XCTAssertEqual(ErrorCode.serviceUnavailable, "service-unavailable")
        XCTAssertEqual(ErrorCode.deviceLimit, "device_limit")
        XCTAssertEqual(ERROR_CODE_KINDS["local-only"], "client")
        XCTAssertEqual(ERROR_CODE_KINDS["unauthorized"], "wire")
        XCTAssertEqual(Set(ERROR_CODE_KINDS.keys), Set(ERROR_CODE_VALUES))
        XCTAssertEqual(ERROR_CODE_VALUES.count, Set(ERROR_CODE_VALUES).count)
        XCTAssertEqual(PROTOCOL_VERSION, POLARIS_PROTOCOL_VERSION)
        XCTAssertEqual(HeaderName.platform, HEADER_PLATFORM)
        XCTAssertEqual(Arch.x86_64, "x86_64")
    }
}
