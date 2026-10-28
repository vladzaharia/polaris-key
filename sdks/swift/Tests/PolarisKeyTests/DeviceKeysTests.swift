// @pkey-feature core.devicekeys
// CC-26.4: the Swift device key store and `pkey-proof/1` signer. Mirrors client-core's
// deviceKeys.test.ts, and runs conformance/corpus/v2/device-proof.json through the verifier.

import CryptoKit
import Foundation
import Security
import XCTest

@testable import PolarisKeyCore

// ── Fakes ────────────────────────────────────────────────────────────────────────────

/// A software wrapper standing in for the Secure Enclave (CI has none): AES-GCM under a key it
/// holds, with the same shape and the same authenticated data.
private struct SoftWrapper: DeviceKeyWrapping {
    let key = SymmetricKey(size: .bits256)
    var failWrap = false
    var failWith: DeviceKeyError = .wrap
    func wrap(_ plain: Data, aad: Data) throws -> WrappedKey {
        if failWrap { throw failWith }
        let box = try AES.GCM.seal(plain, using: key, authenticating: aad)
        return WrappedKey(handle: Data([1]), ephemeral: Data([2]), sealed: box.combined!)
    }
    func unwrap(_ w: WrappedKey, aad: Data) throws -> Data {
        // Like the real wrapper: a failed open is `.wrap`, never a format error.
        do { return try AES.GCM.open(AES.GCM.SealedBox(combined: w.sealed), using: key, authenticating: aad) } catch {
            throw DeviceKeyError.wrap
        }
    }
}

private final class FlakyVault: DeviceKeyVault, @unchecked Sendable {
    let inner = MemoryDeviceKeyVault()
    var readError: DeviceKeyError?
    var deleteIsNoOp = false
    var deleteError: DeviceKeyError?
    func read() throws -> Data? {
        if let readError { throw readError }
        return try inner.read()
    }
    func insert(_ blob: Data) throws -> Bool { try inner.insert(blob) }
    func upsert(_ blob: Data) throws { try inner.upsert(blob) }
    func delete() throws {
        if let deleteError { throw deleteError }
        if !deleteIsNoOp { try inner.delete() }
    }
}

/// Two item slots (data-protection, legacy), the way `KeychainStoreTests` fakes them.
private final class FakeKeychain: KeychainAPI, @unchecked Sendable {
    private let lock = NSLock()
    var dp: Data?
    var legacy: Data?
    var noEntitlement = false
    private(set) var adds: [[String: Any]] = []
    private func isDP(_ q: [String: Any]) -> Bool { (q[kSecUseDataProtectionKeychain as String] as? Bool) == true }
    func copyMatching(_ q: [String: Any]) -> (OSStatus, Data?) {
        lock.withLock {
            if isDP(q) {
                if noEntitlement { return (errSecItemNotFound, nil) }
                return dp.map { (errSecSuccess, $0) } ?? (errSecItemNotFound, nil)
            }
            return legacy.map { (errSecSuccess, $0) } ?? (errSecItemNotFound, nil)
        }
    }
    func add(_ a: [String: Any]) -> OSStatus {
        lock.withLock {
            adds.append(a)
            let d = a[kSecValueData as String] as? Data
            if isDP(a) {
                if noEntitlement { return errSecMissingEntitlement }
                if dp != nil { return errSecDuplicateItem }
                dp = d
            } else {
                if legacy != nil { return errSecDuplicateItem }
                legacy = d
            }
            return errSecSuccess
        }
    }
    func update(_ q: [String: Any], _ a: [String: Any]) -> OSStatus {
        lock.withLock {
            let d = a[kSecValueData as String] as? Data
            if isDP(q) {
                if noEntitlement { return errSecMissingEntitlement }
                if dp == nil { return errSecItemNotFound }
                dp = d
            } else {
                if legacy == nil { return errSecItemNotFound }
                legacy = d
            }
            return errSecSuccess
        }
    }
    func delete(_ q: [String: Any]) -> OSStatus {
        lock.withLock {
            if isDP(q) {
                if noEntitlement { return errSecMissingEntitlement }
                if dp == nil { return errSecItemNotFound }
                dp = nil
            } else {
                if legacy == nil { return errSecItemNotFound }
                legacy = nil
            }
            return errSecSuccess
        }
    }
}

/// A port that forwards to a store and lets a test intercept signing.
private struct HookedPort: DeviceKeyPort {
    let store: DeviceKeyStore
    var onSign: (@Sendable (Data) async throws -> Data)?
    var persistenceOverride: DeviceKeyPersistence?
    func ensure() async throws -> DevicePublicKeys { try await store.ensure() }
    func publicKeys() async throws -> DevicePublicKeys? { try await store.publicKeys() }
    func sign(_ m: Data) async throws -> Data {
        if let onSign { return try await onSign(m) }
        return try await store.sign(m)
    }
    func dh(_ p: Data) async throws -> Data? { try await store.dh(p) }
    func rotate() async throws -> DevicePublicKeys { try await store.rotate() }
    func persistence() async throws -> DeviceKeyPersistence {
        if let persistenceOverride { return persistenceOverride }
        return await store.persistence()
    }
    func wipe() async throws { try await store.wipe() }
}

private let device = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
private let now = 1_700_000_000

private func mem() -> DeviceKeyStore { try! DeviceKeyStore.inMemory() }

private func store(
    _ vault: any DeviceKeyVault, wrapper: (any DeviceKeyWrapping)? = nil, require: Bool = false
) -> DeviceKeyStore {
    try! DeviceKeyStore(productSlug: "djdl", vault: vault, wrapper: wrapper, kind: .durable, requireWrapper: require)
}

// ── The store ────────────────────────────────────────────────────────────────────────

final class DeviceKeyStoreTests: XCTestCase {
    func testMakesOnePairOnFirstNeedAndKeepsIt() async throws {
        let s = mem()
        let none = try await s.publicKeys()
        XCTAssertNil(none)
        let a = try await s.ensure()
        let b = try await s.ensure()
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.generation, 1)
        XCTAssertEqual(Base64URL.decode(a.signKey)?.count, 32)
        XCTAssertEqual(Base64URL.decode(a.agreeKey)?.count, 32)
        let pk = try await s.publicKeys()
        XCTAssertEqual(pk, a)
    }

    func testTwoStoresOverOneVaultAgree() async throws {
        let v = MemoryDeviceKeyVault()
        let a = store(v)
        let b = store(v)
        async let x = a.ensure()
        async let y = b.ensure()
        let (kx, ky) = try await (x, y)
        XCTAssertEqual(kx, ky)
    }

    func testSignsWhatCryptoKitVerifiesAndOnlyForThePublicKey() async throws {
        let s = mem()
        let k = try await s.ensure()
        let msg = Data("hello".utf8)
        let sig = try await s.sign(msg)
        XCTAssertEqual(sig.count, 64)
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: Base64URL.decode(k.signKey)!)
        XCTAssertTrue(pub.isValidSignature(sig, for: msg))
        XCTAssertFalse(pub.isValidSignature(sig, for: Data("hellp".utf8)))
    }

    func testRefusesToSignBeforeEnsure() async {
        do {
            _ = try await mem().sign(Data([1]))
            XCTFail("signed without keys")
        } catch { XCTAssertEqual(error as? DeviceKeyError, .noKeys) }
    }

    func testDHAgreesWithThePeerAndRefusesLowOrderPeers() async throws {
        let s = mem()
        let k = try await s.ensure()
        let peer = Curve25519.KeyAgreement.PrivateKey()
        let mine = try await s.dh(peer.publicKey.rawRepresentation)
        let theirs = try peer.sharedSecretFromKeyAgreement(
            with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: Base64URL.decode(k.agreeKey)!)
        ).withUnsafeBytes { Data($0) }
        XCTAssertNotNil(mine)
        XCTAssertEqual(mine, theirs)
        var lowOrder: [Data] = [Data(count: 32), Data(count: 31), Data(count: 33)]
        var one = Data(count: 32)
        one[0] = 1
        lowOrder.append(one)
        // p (a second spelling of 0), p + 1 (of 1), p - 1, and the two order-8 points.
        for hex in [
            "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
            "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
        ] { lowOrder.append(Data(hexString: hex)) }
        // The same with the unused high bit set.
        for d in Array(lowOrder.suffix(5)) {
            var h = d
            h[31] |= 0x80
            lowOrder.append(h)
        }
        for d in lowOrder {
            let r = try await s.dh(d)
            XCTAssertNil(r, "accepted \(d.map { String(format: "%02x", $0) }.joined())")
        }
        let none = try await mem().dh(peer.publicKey.rawRepresentation)
        XCTAssertNil(none)
    }

    func testRotatesToANewPairAndWipes() async throws {
        let v = MemoryDeviceKeyVault()
        let s = store(v)
        let a = try await s.ensure()
        let b = try await s.rotate()
        XCTAssertEqual(b.generation, 2)
        XCTAssertNotEqual(a.signKey, b.signKey)
        XCTAssertNotEqual(a.agreeKey, b.agreeKey)
        let again = try await s.ensure()
        XCTAssertEqual(again, b)
        try await s.wipe()
        XCTAssertNil(try v.read(), "wipe left the item")
        let gone = try await s.publicKeys()
        XCTAssertNil(gone)
        let c = try await s.ensure()
        XCTAssertEqual(c.generation, 1)
        XCTAssertNotEqual(c.signKey, b.signKey)
    }

    func testWipeThatLeavesTheItemIsAnError() async throws {
        let v = FlakyVault()
        let s = store(v)
        _ = try await s.ensure()
        v.deleteIsNoOp = true
        do {
            try await s.wipe()
            XCTFail("wipe claimed success")
        } catch { XCTAssertEqual(error as? DeviceKeyError, .wipeIncomplete) }
        v.deleteIsNoOp = false
        v.deleteError = .keychain(errSecAuthFailed)
        do {
            try await s.wipe()
            XCTFail("wipe swallowed the error")
        } catch { XCTAssertEqual(error as? DeviceKeyError, .keychain(errSecAuthFailed)) }
    }

    func testAnUnreadableRecordThrowsAndSurvivesUntilWipe() async throws {
        let v = MemoryDeviceKeyVault()
        let junk = Data("{\"v\":1,\"generation\":1}".utf8)
        _ = try v.insert(junk)
        let s = store(v)
        for op in [
            { _ = try await s.publicKeys() }, { _ = try await s.ensure() }, { _ = try await s.rotate() },
            { _ = try await s.sign(Data([1])) },
        ] {
            do {
                try await op()
                XCTFail("used or replaced an unreadable record")
            } catch { XCTAssertEqual(error as? DeviceKeyError, .unreadable) }
        }
        XCTAssertEqual(try v.read(), junk, "the record must survive")
        try v.upsert(Data([0xff, 0x00]))  // not even JSON
        do {
            _ = try await s.ensure()
            XCTFail("replaced undecodable bytes")
        } catch { XCTAssertEqual(error as? DeviceKeyError, .unreadable) }
        try await s.wipe()
        let k = try await s.ensure()
        XCTAssertEqual(k.generation, 1)
    }

    func testRejectsABadProductSlug() throws {
        for slug in ["", "a|b", "Djdl", "a\nb"] {
            XCTAssertThrowsError(try DeviceKeyStore.inMemory(productSlug: slug), slug)
            XCTAssertThrowsError(try DeviceKeyStore(productSlug: slug), slug)
        }
    }

    func testAKeychainErrorIsNotTakenForNoKeys() async throws {
        let v = FlakyVault()
        let s = store(v)
        let k = try await s.ensure()
        v.readError = .keychain(errSecInteractionNotAllowed)
        for op in [{ _ = try await s.ensure() }, { _ = try await s.publicKeys() }, { _ = try await s.rotate() }] {
            do {
                try await op()
                XCTFail("treated a locked keychain as empty")
            } catch { XCTAssertEqual(error as? DeviceKeyError, .keychain(errSecInteractionNotAllowed)) }
        }
        v.readError = nil
        let kept = try await s.publicKeys()
        XCTAssertEqual(kept, k)  // still the same identity
    }

    func testMemoryStoreReportsMemory() async throws {
        let p = await mem().persistence()
        XCTAssertEqual(p, .memory)
        let q = await store(MemoryDeviceKeyVault()).persistence()
        XCTAssertEqual(q, .durable)
        let prot = try await mem().protection()
        XCTAssertEqual(prot, .memory)
    }

    // The wrapped path

    func testWrappedRecordHoldsNoRawKeysAndStillSigns() async throws {
        let v = MemoryDeviceKeyVault()
        let s = store(v, wrapper: SoftWrapper())
        let k = try await s.ensure()
        let blob = try XCTUnwrap(try v.read())
        let text = String(decoding: blob, as: UTF8.self)
        XCTAssertTrue(text.contains("\"wrapped\""))
        XCTAssertFalse(text.contains("\"keys\""))
        let prot = try await s.protection()
        XCTAssertEqual(prot, .secureEnclaveWrapped)
        let sig = try await s.sign(Data("x".utf8))
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: Base64URL.decode(k.signKey)!)
        XCTAssertTrue(pub.isValidSignature(sig, for: Data("x".utf8)))
        let r = try await s.rotate()
        XCTAssertEqual(r.generation, 2)
    }

    func testAFailedUnwrapKeepsTheIdentity() async throws {
        let v = MemoryDeviceKeyVault()
        let s = store(v, wrapper: SoftWrapper())
        let k = try await s.ensure()
        let blob = try XCTUnwrap(try v.read())
        // A record copied to another generation (or product) fails GCM: an error, not a reset.
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: blob) as? [String: Any])
        json["generation"] = 7
        try v.upsert(JSONSerialization.data(withJSONObject: json))
        do {
            _ = try await s.ensure()
            XCTFail("opened a record bound elsewhere")
        } catch { XCTAssertEqual(error as? DeviceKeyError, .wrap) }
        try v.upsert(blob)
        let still = try await s.publicKeys()
        XCTAssertEqual(still, k)
    }

    func testATransientWrapFailureKeepsTheIdentity() async throws {
        let v = MemoryDeviceKeyVault()
        let good = SoftWrapper()
        let k = try await store(v, wrapper: good).ensure()
        // A wrapper that cannot open now (locked): ensure and rotate throw, the record stays.
        let locked = store(v, wrapper: SoftWrapper())  // a different key: every open fails
        for op in [{ _ = try await locked.ensure() }, { _ = try await locked.rotate() }] {
            do {
                try await op()
                XCTFail("replaced behind a failed unwrap")
            } catch { XCTAssertEqual(error as? DeviceKeyError, .wrap) }
        }
        let back = try await store(v, wrapper: good).publicKeys()
        XCTAssertEqual(back, k)
    }

    func testAWrappedRecordIsNotReplacedWhenTheEnclaveIsOff() async throws {
        let v = MemoryDeviceKeyVault()
        _ = try await store(v, wrapper: SoftWrapper()).ensure()
        let off = store(v, wrapper: nil)
        do {
            _ = try await off.ensure()
            XCTFail("replaced a wrapped identity")
        } catch { XCTAssertEqual(error as? DeviceKeyError, .unsupported("secure-enclave-record")) }
        try await off.wipe()  // the explicit way out
        let k = try await off.ensure()
        XCTAssertEqual(k.generation, 1)
    }

    func testRequiredEnclaveNeverFallsBack() async throws {
        do {
            _ = try await store(MemoryDeviceKeyVault(), wrapper: nil, require: true).ensure()
            XCTFail("fell back")
        } catch { XCTAssertEqual(error as? DeviceKeyError, .unsupported("secure-enclave")) }
        var absent = SoftWrapper()
        absent.failWrap = true
        absent.failWith = .unsupported("secure-enclave")
        do {
            _ = try await store(MemoryDeviceKeyVault(), wrapper: absent, require: true).ensure()
            XCTFail("fell back")
        } catch { XCTAssertEqual(error as? DeviceKeyError, .unsupported("secure-enclave")) }
        // Preferred: a permanently absent SE falls back to the Keychain alone, and says so.
        let s = store(MemoryDeviceKeyVault(), wrapper: absent)
        _ = try await s.ensure()
        let prot = try await s.protection()
        XCTAssertEqual(prot, .keychain)
        // A transient failure is an error, never a quiet downgrade.
        var flaky = SoftWrapper()
        flaky.failWrap = true
        let v = MemoryDeviceKeyVault()
        do {
            _ = try await store(v, wrapper: flaky).ensure()
            XCTFail("downgraded on a transient failure")
        } catch { XCTAssertEqual(error as? DeviceKeyError, .wrap) }
        XCTAssertNil(try v.read())
    }

    func testRealSecureEnclaveWrapperRoundTrips() throws {
        try XCTSkipUnless(SecureEnclaveWrapper.isAvailable, "no Secure Enclave here")
        let w = SecureEnclaveWrapper()
        let wrapped: WrappedKey
        do { wrapped = try w.wrap(Data("secret".utf8), aad: Data("a".utf8)) } catch {
            throw XCTSkip("the Secure Enclave refuses this process (\(error))")
        }
        XCTAssertEqual(try w.unwrap(wrapped, aad: Data("a".utf8)), Data("secret".utf8))
        XCTAssertThrowsError(try w.unwrap(wrapped, aad: Data("b".utf8)))
    }
}

// ── The Keychain vault ───────────────────────────────────────────────────────────────

final class DeviceKeyVaultTests: XCTestCase {
    private func vault(_ k: FakeKeychain) -> KeychainDeviceKeyVault {
        KeychainDeviceKeyVault(keychain: k, service: "pkey:djdl", accessGroup: nil)
    }

    func testItemAttributes() throws {
        let k = FakeKeychain()
        XCTAssertTrue(try vault(k).insert(Data([1])))
        let a = try XCTUnwrap(k.adds.first)
        XCTAssertEqual(a[kSecAttrService as String] as? String, "pkey:djdl")
        XCTAssertEqual(a[kSecAttrAccount as String] as? String, "device-keys")
        XCTAssertEqual(
            a[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(a[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertEqual(a[kSecUseDataProtectionKeychain as String] as? Bool, true)
        XCTAssertFalse(try vault(k).insert(Data([2])), "a second insert must not replace")
        XCTAssertEqual(try vault(k).read(), Data([1]))
    }

    func testUnentitledMacUsesTheLegacyKeychainAndDeleteReachesBoth() throws {
        let k = FakeKeychain()
        k.noEntitlement = true
        let v = vault(k)
        XCTAssertTrue(try v.insert(Data([1])))
        XCTAssertEqual(try v.read(), Data([1]))
        try v.upsert(Data([3]))
        XCTAssertEqual(k.legacy, Data([3]))
        k.dp = Data([9])  // both slots filled: the wipe must take both
        k.noEntitlement = false
        try v.delete()
        XCTAssertNil(k.dp)
        XCTAssertNil(k.legacy)
        XCTAssertNil(try v.read())
    }

    func testALegacyItemMigratesOnReadWhenEntitled() throws {
        let k = FakeKeychain()
        k.legacy = Data([5])
        XCTAssertEqual(try vault(k).read(), Data([5]))
        XCTAssertEqual(k.dp, Data([5]))
        XCTAssertNil(k.legacy)
    }

    func testAWriteToTheDataProtectionKeychainDropsTheLegacyCopy() throws {
        let k = FakeKeychain()
        k.dp = Data([0])
        k.legacy = Data([1])  // a stale copy
        try vault(k).upsert(Data([2]))
        XCTAssertEqual(k.dp, Data([2]))
        XCTAssertNil(k.legacy)
    }

    func testUpsertReplacesInPlace() throws {
        let k = FakeKeychain()
        let v = vault(k)
        try v.upsert(Data([1]))
        try v.upsert(Data([2]))
        XCTAssertEqual(try v.read(), Data([2]))
    }
}

// ── The proof ────────────────────────────────────────────────────────────────────────

final class DeviceProofSignerTests: XCTestCase {
    func testSignsEveryPurposeAndTheVerifierAcceptsIt() async throws {
        let s = mem()
        for purpose in DeviceProofPurpose.allCases where purpose != .keys {
            let proof = try await DeviceProofs.sign(
                s, purpose: purpose, product: "djdl", deviceId: device, value: "v-" + purpose.rawValue,
                tokenHash: "Zm9v")
            XCTAssertTrue(DeviceProofs.verify(proof))
            var other = proof
            other.fields.purpose = "keys"
            XCTAssertFalse(DeviceProofs.verify(other, now: now))
            other = proof
            other.fields.product = "other"
            XCTAssertFalse(DeviceProofs.verify(other))
            other = proof
            other.fields.deviceId = device.replacingOccurrences(of: "A", with: "B")
            XCTAssertFalse(DeviceProofs.verify(other))
            other = proof
            other.fields.tokenHash = "-"
            XCTAssertFalse(DeviceProofs.verify(other))
        }
    }

    func testSignsTheExactMessageBytes() async throws {
        let seen = LockedValue<[Data]>([])
        let store = mem()
        let port = HookedPort(
            store: store,
            onSign: { m in
                seen.with { $0.append(m) }
                return try await store.sign(m)
            })
        _ = try await DeviceProofs.sign(port, purpose: .link, product: "djdl", deviceId: device, value: "abc")
        let got = seen.current
        XCTAssertEqual(got.count, 1)
        XCTAssertEqual(String(decoding: got[0], as: UTF8.self), "pkey-proof/1\nlink\ndjdl\n\(device)\nabc\n-")
    }

    func testRefusesAFieldThatBreaksTheLineFormat() async throws {
        let s = mem()
        for bad in ["a\nb", "", "a b", "é"] {
            do {
                _ = try await DeviceProofs.sign(s, purpose: .nonce, product: "djdl", deviceId: device, value: bad)
                XCTFail("signed \(bad.debugDescription)")
            } catch { XCTAssertEqual(error as? DeviceProofError, .badField) }
        }
    }

    func testRefusesWhenTheKeysChangeWhileSigning() async throws {
        let store = mem()
        let port = HookedPort(
            store: store,
            onSign: { m in
                let sig = try await store.sign(m)
                _ = try await store.rotate()
                return sig
            })
        do {
            _ = try await DeviceProofs.sign(port, purpose: .nonce, product: "djdl", deviceId: device, value: "x")
            XCTFail("signed across a rotate")
        } catch { XCTAssertEqual(error as? DeviceProofError, .keysChanged) }
    }

    func testRefusesAPortWhoseSignatureDoesNotVerify() async throws {
        let port = HookedPort(store: mem(), onSign: { _ in Data(count: 64) })
        do {
            _ = try await DeviceProofs.sign(port, purpose: .nonce, product: "djdl", deviceId: device, value: "x")
            XCTFail("returned a bad proof")
        } catch { XCTAssertEqual(error as? DeviceProofError, .didNotVerify) }
    }

    func testBuildsTheKeysProofAndThePutBody() async throws {
        let s = mem()
        let k = try await s.ensure()
        let (path, body) = try await DeviceProofs.keysRequest(
            s, product: "djdl", deviceId: device, issuedAt: now, allowEphemeral: true)
        XCTAssertEqual(path, "/djdl/devices/keys")
        XCTAssertEqual(body.signKey, k.signKey)
        XCTAssertEqual(body.agreeKey, k.agreeKey)
        XCTAssertEqual(body.issuedAt, now)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["signKey", "agreeKey", "issuedAt", "sig"])
        let proof = DeviceProof(
            fields: DeviceProofFields(
                purpose: "keys", product: "djdl", deviceId: device,
                value: DeviceProofs.keysValue(signKey: body.signKey, agreeKey: body.agreeKey, issuedAt: body.issuedAt)),
            signKey: body.signKey, sig: body.sig)
        XCTAssertTrue(DeviceProofs.verify(proof, now: now))
        XCTAssertFalse(DeviceProofs.verify(proof, now: now + 301))
        XCTAssertEqual(Base64URL.decode(body.sig)?.count, 64)
    }

    func testKeysProofForARotatedPairNamesTheNewKeys() async throws {
        let s = mem()
        _ = try await s.ensure()
        let b = try await s.rotate()
        let r = try await DeviceProofs.signKeys(
            s, product: "djdl", deviceId: device, issuedAt: now, allowEphemeral: true)
        XCTAssertEqual(r.keys, b)
        XCTAssertEqual(r.proof.signKey, b.signKey)
    }

    func testRefusesToRegisterKeysThatLiveInMemoryOnly() async throws {
        let s = mem()
        _ = try await s.ensure()
        for call in [
            { _ = try await DeviceProofs.keysRequest(s, product: "djdl", deviceId: device, issuedAt: now) },
            { _ = try await DeviceProofs.signKeys(s, product: "djdl", deviceId: device, issuedAt: now) },
        ] {
            do {
                try await call()
                XCTFail("registered memory-only keys")
            } catch { XCTAssertEqual(error as? DeviceKeyError, .unsupported("memory-only")) }
        }
        // Other proofs need no registration.
        _ = try await DeviceProofs.sign(s, purpose: .nonce, product: "djdl", deviceId: device, value: "x")
        // A durable store registers.
        let d = store(MemoryDeviceKeyVault())
        _ = try await DeviceProofs.keysRequest(d, product: "djdl", deviceId: device, issuedAt: now)
    }

    func testRefusesKeysThroughSignAndABadProductSlug() async throws {
        let s = store(MemoryDeviceKeyVault())
        do {
            _ = try await DeviceProofs.sign(s, purpose: .keys, product: "djdl", deviceId: device, value: "x")
            XCTFail("signed keys through sign")
        } catch { XCTAssertEqual(error as? DeviceProofError, .useSignKeysProof) }
        for product in ["", "Djdl", "a\nb", "-x", String(repeating: "a", count: 65)] {
            do {
                _ = try await DeviceProofs.keysRequest(s, product: product, deviceId: device)
                XCTFail("accepted slug \(product.debugDescription)")
            } catch { XCTAssertEqual(error as? DeviceProofError, .badProduct) }
        }
    }
}

// ── The corpus ───────────────────────────────────────────────────────────────────────

final class DeviceProofConformanceTests: XCTestCase {
    private func corpus() throws -> [String: Any] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: CorpusLocator.url("device-proof"))) as? [String: Any])
    }

    /// Every case's verdict, through the verifier, and the message bytes of every case that has them.
    func testVerifierAgreesWithEveryCorpusVerdict() throws {
        let c = try corpus()
        let cases = try XCTUnwrap(c["cases"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 60)
        for k in try XCTUnwrap(c["keyValueCases"] as? [[String: Any]]) {
            XCTAssertEqual(
                DeviceProofs.keysValue(
                    signKey: k["signKey"] as! String, agreeKey: k["agreeKey"] as! String,
                    issuedAt: k["issuedAt"] as! Int),
                k["value"] as? String)
        }
        for t in cases {
            let id = t["id"] as? String ?? "?"
            let f = DeviceProofFields(
                purpose: t["purpose"] as? String ?? "", product: t["product"] as? String ?? "",
                deviceId: t["deviceId"] as? String ?? "", value: t["value"] as? String ?? "",
                tokenHash: t["tokenHash"] as? String ?? "")
            let proof = DeviceProof(
                fields: f, signKey: t["signKey"] as? String ?? "", sig: t["sig"] as? String ?? "")
            let ok = DeviceProofs.verify(proof, now: t["now"] as? Int)
            XCTAssertEqual(ok, (t["verdict"] as? String) == "ok", id)
            if let hex = t["messageHex"] as? String {
                XCTAssertEqual(DeviceProofs.message(f).map { Data($0).hexString }, hex, id)
            }
        }
    }

    /// Every valid purpose: sign the case's fields with a fresh store key, check the bytes the
    /// store was asked to sign against the corpus message exactly, then verify.
    func testSignsEveryValidPurposeWithAFreshKey() async throws {
        let cases = try XCTUnwrap(corpus()["cases"] as? [[String: Any]])
            .filter { ($0["id"] as? String)?.hasPrefix("valid-") == true }
        XCTAssertEqual(
            Set(cases.compactMap { $0["purpose"] as? String }), Set(DeviceProofPurpose.allCases.map(\.rawValue)))
        for t in cases {
            let id = t["id"] as! String
            let purpose = DeviceProofPurpose(rawValue: t["purpose"] as! String)!
            let store = mem()
            let seen = LockedValue<Data?>(nil)
            let port = HookedPort(
                store: store,
                onSign: { m in
                    seen.set(m)
                    return try await store.sign(m)
                })
            let proof: DeviceProof
            var expected = t["messageHex"] as! String
            if purpose == .keys {
                // The value names the fresh keys, so the bytes differ from the corpus's; the
                // framing (version, purpose, slug, device, token hash `-`) must not.
                let r = try await DeviceProofs.signKeys(
                    port, product: t["product"] as! String, deviceId: t["deviceId"] as! String,
                    issuedAt: (t["now"] as! Int) - 10, allowEphemeral: true)
                proof = r.proof
                let value = DeviceProofs.keysValue(
                    signKey: r.keys.signKey, agreeKey: r.keys.agreeKey, issuedAt: (t["now"] as! Int) - 10)
                expected =
                    Data(
                        "pkey-proof/1\nkeys\n\(t["product"] as! String)\n\(t["deviceId"] as! String)\n\(value)\n-".utf8
                    ).hexString
            } else {
                proof = try await DeviceProofs.sign(
                    port, purpose: purpose, product: t["product"] as! String, deviceId: t["deviceId"] as! String,
                    value: t["value"] as! String, tokenHash: t["tokenHash"] as! String, now: t["now"] as? Int)
            }
            XCTAssertEqual(seen.current?.hexString, expected, id)
            XCTAssertTrue(DeviceProofs.verify(proof, now: t["now"] as? Int), id)
            XCTAssertNotEqual(proof.signKey, t["signKey"] as? String, "\(id): not a fresh key")
        }
    }
}

extension Data {
    fileprivate var hexString: String { map { String(format: "%02x", $0) }.joined() }
    fileprivate init(hexString h: String) {
        let c = Array(h.utf8)
        func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
        self.init(stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) })
    }
}
