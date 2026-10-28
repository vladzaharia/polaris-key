// @pkey-feature sync.e2e
// The Cloud Sync E2E primitives against `conformance/corpus/v2/sync-vectors.json` (U-39.1;
// WIRE-CONTRACT-V5 §13.10): hkdfCases, envelopeCases, blindCases and canonicalJsonCases. The
// other sections belong to later work packages; a runner reads named sections only.

import Foundation
import Testing

@testable import PolarisKeyCore

private struct Vectors: Decodable {
    struct Hkdf: Decodable {
        let id, label, ikmHex, saltHex, infoHex, okmHex: String
        let length: Int
    }
    struct Envelope: Decodable {
        struct Seal: Decodable {
            let saltHex: String
            let value: JSONValue
        }
        struct Expect: Decodable {
            let result: String
            let name: String?
            let value: JSONValue?
            let reason: String?
        }
        let id, rootHex, collection, name, envelopeHex: String
        let aliases: [String]
        let seal: Seal?
        let expect: Expect
    }
    struct Blind: Decodable {
        let id, rootHex, kind, ctx, n, blinded: String
    }
    struct Canon: Decodable {
        struct Expect: Decodable {
            let result: String
            let canonical: String?
        }
        let id: String
        let inputJson: String?
        let special: String?
        let expect: Expect
    }
    struct Constants: Decodable {
        let envelopeOverheadBytes, envelopeFixedBytes, paddingBlockBytes: Int
    }
    let syncVectorsVersion: Int
    let constants: Constants
    let hkdfCases: [Hkdf]
    let envelopeCases: [Envelope]
    let blindCases: [Blind]
    let canonicalJsonCases: [Canon]
}

private func hex(_ s: String) -> Data {
    var d = Data()
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        d.append(UInt8(s[i..<j], radix: 16)!)
        i = j
    }
    return d
}

private func hexString(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

private let corpus: Vectors = {
    // swiftlint:disable:next force_try
    try! CorpusLocator.load(Vectors.self, "sync-vectors")
}()

@Suite("Cloud Sync E2E primitives (sync-vectors.json)")
struct SyncVectorsTests {
    @Test func versionAndConstants() {
        #expect(corpus.syncVectorsVersion == 1)
        #expect(corpus.constants.envelopeOverheadBytes == SyncEnvelope.overheadBytes)
        #expect(corpus.constants.envelopeFixedBytes == SyncEnvelope.fixedBytes)
        #expect(corpus.constants.paddingBlockBytes == SyncEnvelope.padBlock)
    }

    @Test(arguments: corpus.hkdfCases.map(\.id))
    func hkdf(id: String) {
        let c = corpus.hkdfCases.first { $0.id == id }!
        let ikm = hex(c.ikmHex), salt = hex(c.saltHex), info = hex(c.infoHex)
        #expect(
            hexString(SyncCrypto.hkdf(ikm: ikm, salt: salt, info: info, length: c.length))
                == c.okmHex)
        // The named derivation, where the table's ikm is the input the function takes.
        func after(_ label: String) -> String {
            String(decoding: info.dropFirst(label.utf8.count + 1), as: UTF8.self)
        }
        let named: Data?
        switch c.label {
        case "kid": named = SyncCrypto.deriveKid(root: ikm)
        case "coll": named = SyncCrypto.deriveCollKey(root: ikm, collection: after(SyncCrypto.Label.coll))
        case "names": named = SyncCrypto.deriveNamesKey(root: ikm)
        case "chunk-id":
            named = SyncCrypto.deriveChunkIdKey(root: ikm, collection: after(SyncCrypto.Label.chunkId))
        case "value": named = SyncCrypto.deriveValueKey(collKey: ikm, salt: salt)
        case "file": named = SyncCrypto.deriveFileKey(collKey: ikm, salt: salt)
        case "chunk": named = SyncCrypto.deriveChunkKey(collKey: ikm, chunkId: salt)
        case "recovery":
            named = SyncCrypto.deriveRecoveryKey(code: ikm, ringId: String(decoding: salt, as: UTF8.self))
        case "adopt": named = SyncCrypto.deriveAdoptKey(root: ikm)
        default: named = nil
        }
        if let named { #expect(hexString(named) == c.okmHex) }
    }

    @Test(arguments: corpus.envelopeCases.map(\.id))
    func envelope(id: String) throws {
        let c = corpus.envelopeCases.first { $0.id == id }!
        let root = hex(c.rootHex), env = hex(c.envelopeHex)
        if let seal = c.seal {
            // An alias case was sealed under the source name the reader accepts (expect.name).
            let again = try SyncEnvelope.seal(
                root: root, collection: c.collection, name: c.expect.name!, value: seal.value,
                salt: hex(seal.saltHex))
            #expect(again == env)
        }
        let got = SyncEnvelope.open(
            root: root, collection: c.collection, name: c.name, envelope: env, aliases: c.aliases)
        if c.expect.result == "ok" {
            guard case .ok(let name, let value) = got else {
                Issue.record("expected ok, got \(got)")
                return
            }
            #expect(name == c.expect.name)
            // Compared as canonical text: the corpus reader and ours may split int and double.
            #expect(try CanonicalJSON.encode(value) == CanonicalJSON.encode((c.expect.value ?? .null)))
            // The same envelope opens when the name is not known in advance.
            if case .ok(let n2, _) = SyncEnvelope.openAnyName(
                root: root, collection: c.collection, envelope: env)
            {
                #expect(n2 == name)
            } else {
                Issue.record("openAnyName refused \(c.id)")
            }
        } else {
            #expect(got.reason?.rawValue == c.expect.reason)
        }
    }

    @Test func openedValueIsNeverPrinted() {
        let o = SyncEnvelope.Opened.ok(name: "theme", value: .string("secret-value"))
        #expect(!"\(o)".contains("secret-value"))
        #expect(!String(reflecting: o).contains("secret-value"))
    }

    @Test(arguments: corpus.blindCases.map(\.id))
    func blind(id: String) {
        let c = corpus.blindCases.first { $0.id == id }!
        let kind = SyncBlind.Kind(rawValue: c.kind)!
        #expect(SyncBlind.blind(root: hex(c.rootHex), kind: kind, ctx: c.ctx, n: c.n) == c.blinded)
        #expect(SyncBlind.isBlindedName(c.blinded))
    }

    @Test func blindedNameShape() {
        #expect(!SyncBlind.isBlindedName("x:short"))
        #expect(!SyncBlind.isBlindedName("y:" + String(repeating: "A", count: 43)))
        #expect(!SyncBlind.isBlindedName("x:" + String(repeating: "A", count: 42) + "="))
    }

    @Test(arguments: corpus.canonicalJsonCases.map(\.id))
    func canonicalJson(id: String) throws {
        let c = corpus.canonicalJsonCases.first { $0.id == id }!
        if let special = c.special {
            let d: Double = special == "NaN" ? .nan : (special.hasPrefix("-") ? -.infinity : .infinity)
            #expect(throws: SyncCryptoError.self) { try CanonicalJSON.encode(.double(d)) }
            return
        }
        let text = c.inputJson!
        if c.expect.result == "ok" {
            #expect(try CanonicalJSON.canonicalize(jsonText: text) == c.expect.canonical)
        } else {
            #expect(throws: SyncCryptoError.self) { try CanonicalJSON.canonicalize(jsonText: text) }
        }
    }

    @Test func canonicalJsonRefusesIntegersBeyond2Pow53() throws {
        #expect(try CanonicalJSON.encode(.int(1 << 53)) == "9007199254740992")
        #expect(try CanonicalJSON.encode(.int(-(1 << 53))) == "-9007199254740992")
        for v in [(1 << 53) + 1, 1 << 62, -(1 << 53) - 1, Int.min] {
            #expect(throws: SyncCryptoError.self) { try CanonicalJSON.encode(.int(v)) }
        }
    }

    @Test func numberPrinterMatchesEcmaScript() throws {
        let cases: [(Double, String)] = [
            (0.1, "0.1"), (-0.0, "0"), (1e21, "1e+21"), (1e-7, "1e-7"), (1.2345678901234568e20, "123456789012345680000"),
            (1.5e-7, "1.5e-7"), (100, "100"), (0.000001, "0.000001"), (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"), (-2.5, "-2.5"),
            (1152921504606846976, "1152921504606847000"), (12345.678, "12345.678"),
        ]
        for (d, s) in cases { #expect(try CanonicalJSON.numberString(d) == s) }
    }
}
