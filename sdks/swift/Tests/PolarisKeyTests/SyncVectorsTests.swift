// @pkey-feature sync.e2e
// The Cloud Sync E2E primitives against `conformance/corpus/v2/sync-vectors.json` (U-39.1;
// WIRE-CONTRACT-V5 §13.10): hkdfCases, envelopeCases, blindCases and canonicalJsonCases. The
// other sections belong to later work packages; a runner reads named sections only.

import CryptoKit
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
    struct Anchor: Decodable {
        struct Vector: Decodable {
            struct Enc: Decodable { let aad, ct, nonce, pt: String }
            let info, skRm, pkRm, skEm, enc, shared_secret, key, base_nonce: String
            let encryption: Enc
        }
        let vector: Vector
    }
    struct WrapCase: Decodable {
        struct W: Decodable {
            let kem: Int
            let encHex, ctHex: String
        }
        struct Seal: Decodable { let rootHex, recipientPublicHex, ephemeralPrivateHex, infoHex: String }
        let id, product, deviceId, ringId, kidHex, recipientPrivateHex: String
        let epoch: Int
        let wrap: W
        let expectRootHex: String?
        let seal: Seal?
    }
    struct RecoveryCase: Decodable {
        struct Seal: Decodable { let rootHex, nonceHex: String }
        let kind, id: String
        let codeHex, text, input, expectCodeHex, ringId, kidHex, blobHex, expectRootHex: String?
        let epoch: Int?
        let seal: Seal?
    }
    struct AdoptCase: Decodable {
        struct Seal: Decodable { let oldRootHex, nonceHex: String }
        let id, currentRootHex, fromRingId, kidHex, blobHex: String
        let epoch: Int
        let expectRootHex: String?
        let seal: Seal?
    }
    let hpkeAnchor: Anchor
    let wrapCases: [WrapCase]
    let recoveryCodeCases: [RecoveryCase]
    let adoptCases: [AdoptCase]
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
        let ikm = hex(c.ikmHex)
        let salt = hex(c.saltHex)
        let info = hex(c.infoHex)
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
        let root = hex(c.rootHex)
        let env = hex(c.envelopeHex)
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
            (0.1, "0.1"), (-0.0, "0"), (1e21, "1e+21"), (1e-7, "1e-7"),
            (1.2345678901234568e20, "123456789012345680000"),
            (1.5e-7, "1.5e-7"), (100, "100"), (0.000001, "0.000001"), (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"), (-2.5, "-2.5"),
            (1_152_921_504_606_846_976, "1152921504606847000"), (12345.678, "12345.678"),
        ]
        for (d, s) in cases { #expect(try CanonicalJSON.numberString(d) == s) }
    }

    // ── U-39.2: HPKE, the wrap, the recovery code and adopt ──────────────────────────────────

    @Test func hpkeAnchor() async throws {
        let a = corpus.hpkeAnchor.vector
        let info = hex(a.info)
        let aad = hex(a.encryption.aad)
        let pt = hex(a.encryption.pt)
        let sealed = try SyncHPKE.seal(
            recipientPublicKey: hex(a.pkRm), info: info, aad: aad, plaintext: pt,
            ephemeralPrivate: hex(a.skEm))
        #expect(hexString(sealed.enc) == a.enc)
        #expect(hexString(sealed.ct) == a.encryption.ct)
        let skR = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(a.skRm))
        #expect(hexString(skR.publicKey.rawRepresentation) == a.pkRm)
        let dh: (Data) async throws -> Data? = { peer in
            let p = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peer)
            return try skR.sharedSecretFromKeyAgreement(with: p).withUnsafeBytes { Data($0) }
        }
        let opened = try await SyncHPKE.open(
            recipientPublicKey: hex(a.pkRm), dh: dh, enc: hex(a.enc), info: info, aad: aad,
            ciphertext: hex(a.encryption.ct))
        #expect(opened.map(hexString) == a.encryption.pt)
        // The key schedule's own outputs.
        let skE = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(a.skEm))
        let dhOut = try skE.sharedSecretFromKeyAgreement(
            with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: hex(a.pkRm))
        ).withUnsafeBytes { Data($0) }
        let ss = SyncHPKE.sharedSecret(dh: dhOut, kemContext: hex(a.enc) + hex(a.pkRm))
        #expect(hexString(ss) == a.shared_secret)
        let (key, nonce) = SyncHPKE.keySchedule(secret: ss, info: info)
        #expect(hexString(key) == a.key)
        #expect(hexString(nonce) == a.base_nonce)
    }

    /// One cross-check against CryptoKit's own HPKE, both directions.
    @Test func hpkeAgreesWithCryptoKit() async throws {
        let suite = HPKE.Ciphersuite(kem: .Curve25519_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_256)
        let skR = Curve25519.KeyAgreement.PrivateKey()
        let pkR = skR.publicKey.rawRepresentation
        let info = Data("cross-check".utf8)
        let aad = Data("aad".utf8)
        let pt = Data("hello".utf8)
        var sender = try HPKE.Sender(recipientKey: skR.publicKey, ciphersuite: suite, info: info)
        let ct = try sender.seal(pt, authenticating: aad)
        let dh: (Data) async throws -> Data? = { peer in
            try skR.sharedSecretFromKeyAgreement(
                with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: peer)
            ).withUnsafeBytes { Data($0) }
        }
        let opened = try await SyncHPKE.open(
            recipientPublicKey: pkR, dh: dh, enc: sender.encapsulatedKey, info: info, aad: aad,
            ciphertext: ct)
        #expect(opened == pt)
        let ours = try SyncHPKE.seal(recipientPublicKey: pkR, info: info, aad: aad, plaintext: pt)
        var recipient = try HPKE.Recipient(
            privateKey: skR, ciphersuite: suite, info: info, encapsulatedKey: ours.enc)
        #expect(try recipient.open(ours.ct, authenticating: aad) == pt)
    }

    @Test(arguments: corpus.wrapCases.map(\.id))
    func wrap(id: String) async throws {
        let c = corpus.wrapCases.first { $0.id == id }!
        let ctx = SyncHPKE.WrapContext(
            product: c.product, deviceId: c.deviceId, ringId: c.ringId, epoch: c.epoch)
        let kid = hex(c.kidHex)
        let skR = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(c.recipientPrivateHex))
        let dh: (Data) async throws -> Data? = { peer in
            guard peer.count == 32,
                let p = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: peer),
                let s = try? skR.sharedSecretFromKeyAgreement(with: p)
            else { return nil }
            let out = s.withUnsafeBytes { Data($0) }
            return out.contains { $0 != 0 } ? out : nil
        }
        let w = SyncHPKE.Wrap(kem: c.wrap.kem, enc: hex(c.wrap.encHex), ct: hex(c.wrap.ctHex))
        let got = try await SyncHPKE.unwrapRoot(
            recipientPublicKey: skR.publicKey.rawRepresentation, dh: dh, context: ctx, kid: kid,
            wrap: w)
        #expect(got.map(hexString) == c.expectRootHex)
        if let s = c.seal {
            #expect(hexString(SyncHPKE.wrapInfo(ctx)) == s.infoHex)
            #expect(hexString(skR.publicKey.rawRepresentation) == s.recipientPublicHex)
            let again = try SyncHPKE.wrapRoot(
                recipientPublicKey: hex(s.recipientPublicHex), context: ctx, kid: kid,
                root: hex(s.rootHex), ephemeralPrivate: hex(s.ephemeralPrivateHex))
            #expect(again == w)
        }
    }

    @Test func wrapToAZeroKeyIsRefused() {
        let ctx = SyncHPKE.WrapContext(product: "demo", deviceId: "d", ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA", epoch: 1)
        #expect(throws: (any Error).self) {
            try SyncHPKE.wrapRoot(
                recipientPublicKey: Data(count: 32), context: ctx, kid: Data(count: 16),
                root: Data(count: 32))
        }
    }

    @Test(arguments: corpus.recoveryCodeCases.map(\.id))
    func recovery(id: String) throws {
        let c = corpus.recoveryCodeCases.first { $0.id == id }!
        switch c.kind {
        case "code":
            #expect(try SyncRecovery.encode(code: hex(c.codeHex!)) == c.text)
            #expect(SyncRecovery.parse(c.text!) == hex(c.codeHex!))
        case "parse":
            #expect(SyncRecovery.parse(c.input!).map(hexString) == c.expectCodeHex)
        default:
            let code = hex(c.codeHex!)
            let kid = hex(c.kidHex!)
            let blob = hex(c.blobHex!)
            let got = SyncRecovery.unwrap(
                code: code, ringId: c.ringId!, epoch: c.epoch!, kid: kid, blob: blob)
            #expect(got.map(hexString) == c.expectRootHex)
            if let s = c.seal {
                let again = try SyncRecovery.wrap(
                    code: code, ringId: c.ringId!, epoch: c.epoch!, kid: kid, root: hex(s.rootHex),
                    nonce: hex(s.nonceHex))
                #expect(again == blob)
            }
        }
    }

    @Test(arguments: corpus.adoptCases.map(\.id))
    func adopt(id: String) throws {
        let c = corpus.adoptCases.first { $0.id == id }!
        let cur = hex(c.currentRootHex)
        let from = SyncRecovery.AdoptFrom(fromRingId: c.fromRingId, epoch: c.epoch, kid: hex(c.kidHex))
        let blob = hex(c.blobHex)
        #expect(SyncRecovery.openAdopt(currentRoot: cur, from: from, blob: blob).map(hexString) == c.expectRootHex)
        if let s = c.seal {
            let again = try SyncRecovery.sealAdopt(
                currentRoot: cur, from: from, oldRoot: hex(s.oldRootHex), nonce: hex(s.nonceHex))
            #expect(again == blob)
        }
    }
}
