// @pkey-feature config.resolve config.list
// Config resolution conformance (WIRE-CONTRACT-V3 §2.2.1), driven off `conformance/corpus/v2`'s
// `config-matrix.json`, read from the checkout through `CorpusLocator`, over
// `ConfigResolution` (what `ConfigClient` delegates to). Swift has an environment layer, so
// every row is checked against `expect`. The Node, React, Python and Godot runners run the same
// rows.
//
// Swift holds a decoded object as `[String: JSONValue]`, whose keys compare by canonical
// equivalence (WIRE-CONTRACT-V3 §10): on `env-value-canonically-equivalent-names` the parsed
// object has ONE member, which this asserts, so a change that lifts the limit fails here and the
// limit's text is updated with it.

import Foundation
import XCTest

@testable import PolarisKeyConfig
@testable import PolarisKeyCore

final class ConfigMatrixTests: XCTestCase {
    private struct Expect: Decodable {
        let value: JSONValue
        let source: String
    }
    private struct ResolveCase: Decodable {
        let id: String
        let remote: [String: ManagedEntry]?
        let localOverrides: [String: JSONValue]
        let env: [String: String]
        let envPrefix: String
        let key: String
        let fallback: JSONValue
        let expect: Expect
        let expectNoEnv: Expect?
    }
    private struct EnvValueCase: Decodable {
        let id: String
        let raw: String
        /// Present (JSON null included) unless the row pins only the verdict.
        let value: JSONValue?
        let anyNumber: Bool

        private enum Keys: String, CodingKey { case id, raw, value, anyNumber }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            id = try c.decode(String.self, forKey: .id)
            raw = try c.decode(String.self, forKey: .raw)
            value = c.contains(.value) ? try c.decode(JSONValue.self, forKey: .value) : nil
            anyNumber = try c.decodeIfPresent(Bool.self, forKey: .anyNumber) ?? false
        }
    }
    private struct ListEntry: Decodable {
        let key: String
        let value: JSONValue
        let enforced: Bool
    }
    private struct ListCase: Decodable {
        let id: String
        let remote: [String: ManagedEntry]?
        let localOverrides: [String: JSONValue]
        let env: [String: String]
        let envPrefix: String
        let expect: [ListEntry]
        let expectNoEnv: [ListEntry]?
    }
    private struct ConfigMatrix: Decodable {
        let configMatrixVersion: Int
        let resolveCases: [ResolveCase]
        let envValueCases: [EnvValueCase]
        let listCases: [ListCase]
    }

    private func load() throws -> ConfigMatrix {
        try CorpusLocator.load(ConfigMatrix.self, "config-matrix")
    }

    /// Canonical JSON equality: keys unordered, arrays ordered, numbers by value (an integral
    /// double equals its integer, -0 equals 0).
    private func canonicalEqual(_ a: JSONValue, _ b: JSONValue) -> Bool {
        switch (a, b) {
        case (.int(let x), .int(let y)): return x == y
        case (.int(let x), .double(let y)): return Double(x) == y
        case (.double(let x), .int(let y)): return x == Double(y)
        case (.double(let x), .double(let y)): return x == y
        case (.string(let x), .string(let y)): return x == y
        case (.bool(let x), .bool(let y)): return x == y
        case (.null, .null): return true
        case (.array(let x), .array(let y)):
            return x.count == y.count && zip(x, y).allSatisfy { canonicalEqual($0, $1) }
        case (.object(let x), .object(let y)):
            return x.count == y.count
                && x.allSatisfy { k, v in y[k].map { canonicalEqual(v, $0) } ?? false }
        default: return false
        }
    }

    private func ctx(
        _ remote: [String: ManagedEntry]?, _ local: [String: JSONValue], _ env: [String: String],
        _ prefix: String
    ) -> ResolveContext {
        ResolveContext(remote: remote, localOverrides: local, env: env, envPrefix: prefix)
    }

    private func resolve(_ c: ResolveCase) -> (JSONValue, String) {
        let context = ctx(c.remote, c.localOverrides, c.env, c.envPrefix)
        return (
            ConfigResolution.resolveValue(context, c.key) ?? c.fallback,
            ConfigResolution.resolveSource(context, c.key).rawValue
        )
    }

    private func passes(_ got: (JSONValue, String), _ want: Expect) -> Bool {
        got.1 == want.source && canonicalEqual(got.0, want.value)
    }

    private func expand(_ c: EnvValueCase) -> ResolveCase {
        ResolveCase(
            id: c.id, remote: nil, localOverrides: [:], env: ["PKEY_CONFIG_value": c.raw],
            envPrefix: "PKEY_CONFIG_", key: "value", fallback: .string("(fallback)"),
            expect: Expect(value: c.value ?? .null, source: "env"), expectNoEnv: nil)
    }

    private func list(_ c: ListCase) -> [UserConfigEntry] {
        ConfigResolution.listUserEntries(ctx(c.remote, c.localOverrides, c.env, c.envPrefix))
            .sorted { $0.key.unicodeScalars.lexicographicallyPrecedes($1.key.unicodeScalars) }
    }

    private func listPasses(_ got: [UserConfigEntry], _ want: [ListEntry]) -> Bool {
        got.count == want.count
            && zip(got, want).allSatisfy {
                $0.key == $1.key && $0.enforced == $1.enforced && canonicalEqual($0.value, $1.value)
            }
    }

    func testVersionAndFloors() throws {
        let m = try load()
        XCTAssertEqual(m.configMatrixVersion, 1)
        XCTAssertGreaterThanOrEqual(m.resolveCases.count, 24)
        XCTAssertGreaterThanOrEqual(m.envValueCases.count, 82)
        XCTAssertGreaterThanOrEqual(m.listCases.count, 8)
    }

    func testResolveCases() throws {
        for c in try load().resolveCases {
            let got = resolve(c)
            XCTAssertEqual(got.1, c.expect.source, c.id)
            XCTAssertTrue(canonicalEqual(got.0, c.expect.value), "\(c.id): \(got.0)")
        }
    }

    func testEnvValueCases() throws {
        for c in try load().envValueCases {
            let got = resolve(expand(c))
            XCTAssertEqual(got.1, "env", c.id)
            if c.anyNumber {
                switch got.0 {
                case .int: break
                case .double(let d): XCTAssertTrue(d.isFinite, c.id)
                default: XCTFail("\(c.id): expected a number, got \(got.0)")
                }
            } else {
                XCTAssertTrue(canonicalEqual(got.0, c.value!), "\(c.id): \(got.0)")
            }
        }
    }

    func testListCases() throws {
        for c in try load().listCases {
            XCTAssertTrue(listPasses(list(c), c.expect), c.id)
        }
    }

    func testADoctoredRowFails() throws {
        let m = try load()
        let row = m.resolveCases[0]
        XCTAssertTrue(passes(resolve(row), row.expect))
        XCTAssertFalse(passes(resolve(row), Expect(value: .string("doctored"), source: row.expect.source)))
        let l = m.listCases[0]
        XCTAssertTrue(listPasses(list(l), l.expect))
        XCTAssertFalse(listPasses(list(l), Array(l.expect.dropFirst())))
    }

    /// WIRE-CONTRACT-V3 §10's declared limit: the scan keeps the verdict (the text parses, as
    /// everywhere else), but `JSONValue.object` keeps only the first of two canonically
    /// equivalent names.
    func testCanonicallyEquivalentNamesParseToOneMember() throws {
        let c = try load().envValueCases.first { $0.id == "env-value-canonically-equivalent-names" }!
        guard case .object(let object) = ConfigResolution.readEnvValue(c.raw) else {
            return XCTFail("expected the text to parse")
        }
        XCTAssertEqual(object.count, 1)
    }

    /// Step 1's raw-U+0000 guard. No corpus row holds a raw U+0000 (no environment can carry one,
    /// and Godot could not load it), and `JSONDecoder` alone guesses UTF-16 from NUL bytes:
    /// `[`, NUL, `]`, NUL decodes to `[]`.
    func testARawNulKeepsTheRawString() {
        let raw = "[\u{0}]\u{0}"
        XCTAssertEqual(ConfigResolution.readEnvValue(raw), .string(raw))
        let bom = "\u{FEFF}[1]"
        XCTAssertEqual(ConfigResolution.readEnvValue(bom), .string(bom))
    }

    /// A malformed number run never traps (`UInt8` underflow, `Int` overflow).
    func testNumberTokenJudgeNeverTraps() {
        for token in ["1e5-5", "-", "--", "1e", "1e+", "e5", "1..2", "1ee5", "9" + String(repeating: "9", count: 400)] {
            _ = StrictJSON.numberTokenInRange(Array(token.utf8))
        }
        XCTAssertTrue(StrictJSON.numberTokenInRange(Array("9.99e307".utf8)))
        XCTAssertFalse(StrictJSON.numberTokenInRange(Array("1e308".utf8)))
        XCTAssertTrue(StrictJSON.numberTokenInRange(Array("0e999999".utf8)))
        XCTAssertFalse(StrictJSON.numberTokenInRange(Array("0e1000000".utf8)))
    }
}
