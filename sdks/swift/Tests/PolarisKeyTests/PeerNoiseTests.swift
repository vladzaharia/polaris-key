// @pkey-feature connect.noise
// CC-11.2: the Noise engine of `pkey-peer/1` (WIRE-CONTRACT-V5 §15.5, §15.6) against
// `conformance/corpus/v2/noise-vectors.json` and the `prologue` and `psk` rows of
// `peer-matrix.json`, read in place. Mirrors conformance/runners/node/noiseVectors.test.ts:
// the X25519 and AES-256-GCM known answers, the low-order points, the three handshake modes byte
// for byte with rekey, the 15 failure rows and the external anchors; then the engine's own
// refusals, the key port, and the no-leak checks.

import CryptoKit
import Foundation
import XCTest

@testable import PolarisKeyCore

private func unhex(_ s: String) -> Data {
    let c = Array(s.utf8)
    func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
    return Data(stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) })
}

private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

// ── Corpus shapes ────────────────────────────────────────────────────────────────────

private struct Message: Decodable {
    let index: Int
    let from: String
    let kind: String
    let payload: String
    let ciphertext: String
    let rekeyAfter: Bool?
}

private struct Handshake: Decodable {
    let id: String
    let mode: String
    let protocolName: String
    let slug: String
    let prologue: String
    let psk: String?
    let initStatic: String
    let initStaticPublic: String
    let initEphemeral: String
    let respStatic: String
    let respStaticPublic: String
    let respEphemeral: String
    let handshakeHash: String
    let messages: [Message]
    enum CodingKeys: String, CodingKey {
        case id, mode, slug, prologue, psk, initStatic, initStaticPublic, initEphemeral, respStatic
        case respStaticPublic, respEphemeral, handshakeHash, messages
        case protocolName = "protocol"
    }
}

private struct Failure: Decodable {
    let id: String
    let protocolName: String
    let prologue: String
    let responderPrologue: String?
    let psk: String?
    let responderPsk: String?
    let initStatic: String
    let initEphemeral: String
    let initEphemeralPublic: String?
    let respStatic: String
    let respEphemeral: String
    let payloads: [String]
    let failedAt: Int
    let reason: String
    enum CodingKeys: String, CodingKey {
        case id, prologue, responderPrologue, psk, responderPsk, initStatic, initEphemeral
        case initEphemeralPublic, respStatic, respEphemeral, payloads, failedAt, reason
        case protocolName = "protocol"
    }
}

private struct AnchorMessage: Decodable {
    let payload: String
    let ciphertext: String
}

private struct AnchorVector: Decodable {
    let protocolName: String
    let initPrologue: String
    let initStatic: String?
    let initEphemeral: String
    let respPrologue: String
    let respStatic: String?
    let respEphemeral: String
    let handshakeHash: String?
    let messages: [AnchorMessage]
    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol_name"
        case initPrologue = "init_prologue"
        case initStatic = "init_static"
        case initEphemeral = "init_ephemeral"
        case respPrologue = "resp_prologue"
        case respStatic = "resp_static"
        case respEphemeral = "resp_ephemeral"
        case handshakeHash = "handshake_hash"
        case messages
    }
}

private struct Anchor: Decodable {
    let source: String
    let vector: AnchorVector
}

private struct Vectors: Decodable {
    struct ScalarMult: Decodable { let id, scalar, u, expect: String }
    struct Agreement: Decodable {
        let id, alicePrivate, alicePublic, bobPrivate, bobPublic, shared: String
    }
    struct X25519: Decodable {
        let scalarMult: [ScalarMult]
        let agreement: [Agreement]
    }
    struct LowRow: Decodable {
        let id, u: String
        let lowOrder: Bool
        let output: String
        let allZero: Bool
    }
    struct LowOrder: Decodable {
        let scalar: String
        let rows: [LowRow]
    }
    struct Gcm: Decodable { let id, key, nonce, aad, plaintext, ciphertext, tag: String }
    struct Anchors: Decodable { let vectors: [Anchor] }
    let noiseVectorsVersion: Int
    let x25519: X25519
    let lowOrder: LowOrder
    let aesGcm: [Gcm]
    let handshakes: [Handshake]
    let failures: [Failure]
    let anchors: Anchors
}

private struct PrologueRow: Decodable { let slug, mode, prologue: String }
private struct PskRow: Decodable { let slug, kDisc, psk: String }
private struct PeerMatrix: Decodable {
    let prologue: [PrologueRow]
    let psk: [PskRow]
}

private struct Side {
    var prologue: String
    var psk: String?
    var staticKey: String
    var ephemeral: String
}

private struct Run {
    var wire: [Data] = []
    var failure: (at: Int, reason: String)?
    var i: PeerNoiseHandshake
    var r: PeerNoiseHandshake
}

/// Run the messages through both roles. On a refusal returns where and why; the failing step is
/// the writer's or the reader's, as the reference reports it.
private func runHandshake(
    _ proto: String, _ ini: Side, _ resp: Side, _ payloads: [Data], replaceFirstEphemeral: Data? = nil
) async throws -> Run {
    func make(_ role: PeerNoiseRole, _ s: Side, _ swap: Data?) throws -> PeerNoiseHandshake {
        try PeerNoiseHandshake(
            role: role, protocol: proto, prologue: unhex(s.prologue),
            staticKey: PeerNoiseRawStaticKey(privateKey: unhex(s.staticKey)),
            psk: s.psk.map(unhex), ephemeralKey: unhex(s.ephemeral), ephemeralPublicOverride: swap)
    }
    var run = Run(i: try make(.initiator, ini, replaceFirstEphemeral), r: try make(.responder, resp, nil))
    for (idx, payload) in payloads.enumerated() {
        let (w, d) = idx % 2 == 0 ? (run.i, run.r) : (run.r, run.i)
        do {
            let msg = try await w.writeMessage(payload)
            run.wire.append(msg)
            let got = try await d.readMessage(msg)
            XCTAssertEqual(hex(got), hex(payload))
        } catch let err as PeerNoiseError {
            run.failure = (idx, err.code)
            return run
        }
    }
    return run
}

final class PeerNoiseTests: XCTestCase {
    private let vectors = try! CorpusLocator.load(Vectors.self, "noise-vectors")
    private let matrix = try! CorpusLocator.load(PeerMatrix.self, "peer-matrix")

    // ── Primitives ───────────────────────────────────────────────────────────────────

    func testVersion() { XCTAssertEqual(vectors.noiseVectorsVersion, 1) }

    func testX25519KnownAnswers() throws {
        for c in vectors.x25519.scalarMult {
            let k = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: unhex(c.scalar))
            let out = PeerNoiseX25519.agree(k, unhex(c.u))
            XCTAssertEqual(out.map(hex), c.expect, c.id)
        }
        for c in vectors.x25519.agreement {
            let a = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: unhex(c.alicePrivate))
            let b = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: unhex(c.bobPrivate))
            XCTAssertEqual(hex(a.publicKey.rawRepresentation), c.alicePublic, c.id)
            XCTAssertEqual(hex(b.publicKey.rawRepresentation), c.bobPublic, c.id)
            XCTAssertEqual(PeerNoiseX25519.agree(a, unhex(c.bobPublic)).map(hex), c.shared, c.id)
            XCTAssertEqual(PeerNoiseX25519.agree(b, unhex(c.alicePublic)).map(hex), c.shared, c.id)
        }
    }

    func testLowOrderPoints() throws {
        let k = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: unhex(vectors.lowOrder.scalar))
        for r in vectors.lowOrder.rows {
            let u = unhex(r.u)
            XCTAssertEqual(DeviceProofs.isX25519LowOrder([UInt8](u)), r.lowOrder, r.id)
            let out = PeerNoiseX25519.agree(k, u)
            if r.allZero {
                XCTAssertNil(out, r.id)  // refused: a throw, a low-order point or zeros
            } else {
                XCTAssertEqual(out.map(hex), r.output, r.id)
            }
        }
    }

    func testAesGcmKnownAnswers() throws {
        for c in vectors.aesGcm {
            let key = SymmetricKey(data: unhex(c.key))
            let nonce = unhex(c.nonce)
            XCTAssertEqual(nonce.count, 12)
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: nonce), ciphertext: unhex(c.ciphertext), tag: unhex(c.tag))
            // Our counter nonce is 4 zero bytes then u64be; check the vectors that use it through
            // the shared helper, and every vector through CryptoKit's opener.
            XCTAssertEqual(
                hex(try AES.GCM.open(box, using: key, authenticating: unhex(c.aad))), c.plaintext, c.id)
            var counter: UInt64 = 0
            for b in nonce.suffix(8) { counter = counter << 8 | UInt64(b) }
            if nonce.prefix(4).allSatisfy({ $0 == 0 }) {
                let sealed = try gcmSeal(key, nonce: counter, ad: unhex(c.aad), unhex(c.plaintext))
                XCTAssertEqual(hex(sealed), c.ciphertext + c.tag, c.id)
                var bad = sealed
                bad[bad.count - 1] ^= 1
                XCTAssertNil(gcmOpen(key, nonce: counter, ad: unhex(c.aad), bad), c.id)
            }
        }
    }

    func testPrologueAndPskRows() throws {
        for r in matrix.prologue {
            let mode = try XCTUnwrap(PeerNoiseMode(rawValue: r.mode))
            XCTAssertEqual(hex(peerPrologue(slug: r.slug, mode: mode)), r.prologue, r.slug + r.mode)
        }
        XCTAssertEqual(matrix.prologue.count, 6)
        for r in matrix.psk {
            XCTAssertEqual(hex(try peerPsk(discoveryKey: unhex(r.kDisc), slug: r.slug)), r.psk, r.slug)
        }
        XCTAssertEqual(matrix.psk.count, 4)
        XCTAssertThrowsError(try peerPsk(discoveryKey: Data(count: 31), slug: "x")) {
            XCTAssertEqual($0 as? PeerNoiseError, .badKey)
        }
        XCTAssertEqual(peerNoiseProtocol(.a), "Noise_XXpsk0_25519_AESGCM_SHA256")
        XCTAssertEqual(peerNoiseProtocol(.v), "Noise_XX_25519_AESGCM_SHA256")
    }

    // ── Handshakes ───────────────────────────────────────────────────────────────────

    private func run(_ h: Handshake) async throws -> (Run, [Message]) {
        let msgs = h.messages.filter { $0.kind == "handshake" }
        func side(_ init_: Bool) -> Side {
            Side(
                prologue: h.prologue, psk: h.psk, staticKey: init_ ? h.initStatic : h.respStatic,
                ephemeral: init_ ? h.initEphemeral : h.respEphemeral)
        }
        let r = try await runHandshake(
            h.protocolName, side(true), side(false), msgs.map { unhex($0.payload) })
        return (r, msgs)
    }

    func testHandshakesByteForByteWithRekey() async throws {
        XCTAssertEqual(vectors.handshakes.map(\.mode).sorted(), ["a", "p", "v"])
        for h in vectors.handshakes {
            let mode = try XCTUnwrap(PeerNoiseMode(rawValue: h.mode))
            XCTAssertEqual(peerNoiseProtocol(mode), h.protocolName)
            XCTAssertEqual(hex(peerPrologue(slug: h.slug, mode: mode)), h.prologue)
            let (r, msgs) = try await run(h)
            XCTAssertNil(r.failure, h.id)
            for (k, w) in r.wire.enumerated() { XCTAssertEqual(hex(w), msgs[k].ciphertext, "\(h.id) \(k)") }
            let ih = try await r.i.handshakeHash
            let rh = try await r.r.handshakeHash
            XCTAssertEqual(hex(ih), h.handshakeHash)
            XCTAssertEqual(hex(rh), h.handshakeHash)
            let irs = await r.i.remoteStatic
            let rrs = await r.r.remoteStatic
            XCTAssertEqual(irs.map(hex), h.respStaticPublic)
            XCTAssertEqual(rrs.map(hex), h.initStaticPublic)

            let ti = try await r.i.transport()
            let tr = try await r.r.transport()
            for m in h.messages where m.kind == "transport" {
                let (from, to) = m.from == "i" ? (ti, tr) : (tr, ti)
                let ct = try from.send.encrypt(ad: Data(), unhex(m.payload))
                XCTAssertEqual(hex(ct), m.ciphertext, "\(h.id) record \(m.index)")
                XCTAssertEqual(hex(try to.receive.decrypt(ad: Data(), ct)), m.payload)
                if m.rekeyAfter == true {
                    try from.send.rekey()
                    try to.receive.rekey()
                }
            }
        }
    }

    func testTamperedOrReplayedRecordFailsAndDoesNotAdvance() async throws {
        for h in vectors.handshakes {
            let (r, _) = try await run(h)
            let ti = try await r.i.transport()
            let tr = try await r.r.transport()
            let ct = try ti.send.encrypt(ad: Data(), Data([1, 2]))
            var bad = ct
            bad[0] ^= 1
            XCTAssertThrowsError(try tr.receive.decrypt(ad: Data(), bad)) {
                XCTAssertEqual($0 as? PeerNoiseError, .decrypt)
            }
            XCTAssertEqual(try tr.receive.decrypt(ad: Data(), ct), Data([1, 2]))
            XCTAssertThrowsError(try tr.receive.decrypt(ad: Data(), ct))
        }
    }

    func testFailureRows() async throws {
        XCTAssertEqual(vectors.failures.count, 15)
        for f in vectors.failures {
            let ini = Side(
                prologue: f.prologue, psk: f.psk, staticKey: f.initStatic, ephemeral: f.initEphemeral)
            let resp = Side(
                prologue: f.responderPrologue ?? f.prologue, psk: f.responderPsk ?? f.psk,
                staticKey: f.respStatic, ephemeral: f.respEphemeral)
            let r = try await runHandshake(
                f.protocolName, ini, resp, f.payloads.map(unhex),
                replaceFirstEphemeral: f.initEphemeralPublic.map(unhex))
            XCTAssertEqual(r.failure?.at, f.failedAt, f.id)
            XCTAssertEqual(r.failure?.reason, f.reason, f.id)
            // A dead handshake refuses further use.
            do {
                _ = try await r.i.writeMessage(Data())
                XCTFail("\(f.id): a dead handshake wrote")
            } catch let e as PeerNoiseError {
                XCTAssertEqual(e, .state)
            }
        }
    }

    func testExternalAnchors() async throws {
        var ran = 0
        for a in vectors.anchors.vectors where a.vector.protocolName == "Noise_XX_25519_AESGCM_SHA256" {
            let v = a.vector
            let r = try await runHandshake(
                v.protocolName,
                Side(prologue: v.initPrologue, staticKey: v.initStatic!, ephemeral: v.initEphemeral),
                Side(prologue: v.respPrologue, staticKey: v.respStatic!, ephemeral: v.respEphemeral),
                v.messages.prefix(3).map { unhex($0.payload) })
            XCTAssertNil(r.failure, a.source)
            for (k, w) in r.wire.enumerated() { XCTAssertEqual(hex(w), v.messages[k].ciphertext, "\(a.source) \(k)") }
            if let hh = v.handshakeHash {
                let got = try await r.i.handshakeHash
                XCTAssertEqual(hex(got), hh)
            }
            let ti = try await r.i.transport()
            let tr = try await r.r.transport()
            for k in 3..<v.messages.count {
                let (from, to) = k % 2 == 0 ? (ti, tr) : (tr, ti)
                let ct = try from.send.encrypt(ad: Data(), unhex(v.messages[k].payload))
                XCTAssertEqual(hex(ct), v.messages[k].ciphertext, "\(a.source) \(k)")
                XCTAssertEqual(hex(try to.receive.decrypt(ad: Data(), ct)), v.messages[k].payload)
            }
            ran += 1
        }
        XCTAssertGreaterThan(ran, 0)
    }

    // ── The engine's own refusals ────────────────────────────────────────────────────

    private struct ThrowingKey: PeerNoiseStaticKey {
        let inner: PeerNoiseRawStaticKey
        func publicKey() async throws -> Data { try await inner.publicKey() }
        func dh(_ remote: Data) async throws -> Data? {
            struct Boom: Error {}
            throw Boom()
        }
    }

    private struct ZeroKey: PeerNoiseStaticKey {
        let inner: PeerNoiseRawStaticKey
        func publicKey() async throws -> Data { try await inner.publicKey() }
        func dh(_ remote: Data) async throws -> Data? { Data(count: 32) }
    }

    private func pair(responder: any PeerNoiseStaticKey, initiator: any PeerNoiseStaticKey)
        throws -> (PeerNoiseHandshake, PeerNoiseHandshake)
    {
        let proto = "Noise_XX_25519_AESGCM_SHA256"
        let p = peerPrologue(slug: "demo", mode: .v)
        return (
            try PeerNoiseHandshake(role: .initiator, protocol: proto, prologue: p, staticKey: initiator),
            try PeerNoiseHandshake(role: .responder, protocol: proto, prologue: p, staticKey: responder)
        )
    }

    private func raw(_ byte: UInt8) throws -> PeerNoiseRawStaticKey {
        try PeerNoiseRawStaticKey(privateKey: Data(repeating: byte, count: 32))
    }

    func testAPortThatThrowsOrAnswersZerosRefusesWithDhZero() async throws {
        for bad: any PeerNoiseStaticKey in [ThrowingKey(inner: try raw(2)), ZeroKey(inner: try raw(2))] {
            let (i, r) = try pair(responder: bad, initiator: try raw(1))
            let m1 = try await i.writeMessage(Data())
            _ = try await r.readMessage(m1)
            do {
                _ = try await r.writeMessage(Data())  // `es` is the responder's static DH
                XCTFail("expected dh_zero")
            } catch let e as PeerNoiseError {
                XCTAssertEqual(e, .dhZero)
                XCTAssertEqual(e.code, "dh_zero")
            }
            do {
                _ = try await r.writeMessage(Data())
                XCTFail("dead")
            } catch let e as PeerNoiseError {
                XCTAssertEqual(e, .state)
            }
        }
    }

    func testStateAndKeyChecks() async throws {
        let p = Data()
        let k = try raw(1)
        XCTAssertThrowsError(try PeerNoiseHandshake(role: .initiator, protocol: "Noise_NN", prologue: p, staticKey: k))
        XCTAssertThrowsError(
            try PeerNoiseHandshake(
                role: .initiator, protocol: "Noise_XXpsk0_25519_AESGCM_SHA256", prologue: p, staticKey: k)
        ) { XCTAssertEqual($0 as? PeerNoiseError, .badKey) }
        XCTAssertThrowsError(
            try PeerNoiseHandshake(
                role: .initiator, protocol: "Noise_XX_25519_AESGCM_SHA256", prologue: p, staticKey: k,
                psk: Data(count: 32)))
        XCTAssertThrowsError(try PeerNoiseRawStaticKey(privateKey: Data(count: 31)))
        let (i, r) = try pair(responder: try raw(2), initiator: try raw(1))
        // Out of turn, and transport before the end.
        do {
            _ = try await r.writeMessage(Data())
            XCTFail("responder wrote first")
        } catch { XCTAssertEqual(error as? PeerNoiseError, .state) }
        _ = i
        do {
            _ = try await i.transport()
            XCTFail("early transport")
        } catch { XCTAssertEqual(error as? PeerNoiseError, .state) }
    }

    func testTruncatedAndTamperedMessagesAbort() async throws {
        let (i, r) = try pair(responder: try raw(2), initiator: try raw(1))
        let m1 = try await i.writeMessage(Data("hi".utf8))
        do {
            _ = try await r.readMessage(m1.prefix(20))
            XCTFail("short")
        } catch { XCTAssertEqual(error as? PeerNoiseError, .malformed) }
        // Message 1 carries its payload in clear (no key yet); tamper with message 2.
        let (i2, r2) = try pair(responder: try raw(2), initiator: try raw(1))
        _ = try await r2.readMessage(try await i2.writeMessage(Data()))
        var m = try await r2.writeMessage(Data("hi".utf8))
        m[m.count - 1] ^= 1
        do {
            _ = try await i2.readMessage(m)
            XCTFail("tampered")
        } catch { XCTAssertEqual(error as? PeerNoiseError, .decrypt) }
    }

    func testRekeyNeedsAKeyAndNonceExhausts() throws {
        let c = PeerCipherState(key: nil)
        XCTAssertThrowsError(try c.rekey())
        XCTAssertEqual(try c.encrypt(ad: Data(), Data([9])), Data([9]))  // no key: pass-through
        c.setKey(Data(count: 32))
        XCTAssertThrowsError(try c.decrypt(ad: Data(), Data(count: 5))) {
            XCTAssertEqual($0 as? PeerNoiseError, .malformed)
        }
    }

    // ── The device key port ──────────────────────────────────────────────────────────

    func testADeviceKeyPortTakesPartAndItsKeyStaysInTheStore() async throws {
        let store = try DeviceKeyStore.inMemory()
        let port = PeerNoiseDeviceKey(store)
        let pub = try await port.publicKey()
        let stored = try await store.publicKeys()
        let keys = try XCTUnwrap(stored)
        XCTAssertEqual(Base64URL.encode(pub), keys.agreeKey)
        let proto = "Noise_XX_25519_AESGCM_SHA256"
        let p = peerPrologue(slug: "demo", mode: .p)
        let i = try PeerNoiseHandshake(role: .initiator, protocol: proto, prologue: p, staticKey: port)
        let r = try PeerNoiseHandshake(role: .responder, protocol: proto, prologue: p, staticKey: try raw(7))
        let m1 = try await i.writeMessage(Data())
        _ = try await r.readMessage(m1)
        let m2 = try await r.writeMessage(Data())
        _ = try await i.readMessage(m2)
        let m3 = try await i.writeMessage(Data("x".utf8))
        let got3 = try await r.readMessage(m3)
        XCTAssertEqual(got3, Data("x".utf8))
        let rrs = await r.remoteStatic
        XCTAssertEqual(rrs, pub)
        let hi = try await i.handshakeHash
        let hr = try await r.handshakeHash
        XCTAssertEqual(hi, hr)
    }

    // ── Nothing leaks ────────────────────────────────────────────────────────────────

    func testDescriptionAndMirrorLeakNothing() async throws {
        let secret = Data(repeating: 0xAB, count: 32)
        let psk = Data(repeating: 0xCD, count: 32)
        let key = try PeerNoiseRawStaticKey(privateKey: secret)
        let h = try PeerNoiseHandshake(
            role: .initiator, protocol: "Noise_XXpsk0_25519_AESGCM_SHA256", prologue: Data(),
            staticKey: key, psk: psk, ephemeralKey: Data(repeating: 0xEF, count: 32))
        _ = try await h.writeMessage(Data())
        let c = PeerCipherState(key: secret)
        let t = PeerNoiseTransport(send: c, receive: c)
        let objects: [Any] = [h, c, t, key, PeerNoiseDeviceKey(try DeviceKeyStore.inMemory()), PeerNoiseError.decrypt]
        for o in objects {
            var dumped = ""
            dump(o, to: &dumped)
            let all = "\(o) \(String(reflecting: o)) \(dumped) \(Mirror(reflecting: o).children.count)"
            for needle in ["abab", "cdcd", "efef", "171", "205", "239"] {
                XCTAssertFalse(all.lowercased().contains(needle), "\(type(of: o)) leaks \(needle)")
            }
            XCTAssertEqual(Mirror(reflecting: o).children.count, 0)
        }
        XCTAssertEqual("\(PeerNoiseError.dhZero)", "noise: dh_zero")
    }

    func testAWipedCipherStateThrowsInsteadOfPassingBytesThrough() throws {
        let c = PeerCipherState(key: Data(repeating: 5, count: 32))
        let ct = try c.encrypt(ad: Data(), Data("hello".utf8))
        XCTAssertNotEqual(ct, Data("hello".utf8))
        c.wipe()
        XCTAssertThrowsError(try c.encrypt(ad: Data(), Data("hello".utf8))) {
            XCTAssertEqual($0 as? PeerNoiseError, .state)
        }
        XCTAssertThrowsError(try c.decrypt(ad: Data(), ct)) { XCTAssertEqual($0 as? PeerNoiseError, .state) }
        // A handshake's own cipher state, never keyed, still passes through until it is wiped.
        let h = PeerCipherState(key: nil)
        XCTAssertEqual(try h.encrypt(ad: Data(), Data("x".utf8)), Data("x".utf8))
        h.wipe()
        XCTAssertThrowsError(try h.encrypt(ad: Data(), Data("x".utf8)))
    }
}
