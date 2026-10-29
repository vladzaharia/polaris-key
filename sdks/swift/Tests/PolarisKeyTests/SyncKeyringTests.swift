// @pkey-feature sync.keyring
// U-39.3: the Cloud Sync key ring client (`client.keyring`) against a stub Worker that keeps one
// ring, its wraps, the recovery blob and the adopted roots. The crypto bytes are pinned by
// SyncVectorsTests; this file pins the client's rules: the pin, the Keychain root, the typed
// locked and ring-changed answers, the recovery path, reset and adopt, forget, and redaction.
// U-39.5 adds the iCloud Keychain root backup: written on create, reset, recovery and unlock,
// read as a silent rung on a new device, kept by sign-out, removed by reset and `deleteBackup()`.

import Foundation
import Security
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore
@testable import PolarisKeyPlatform

/// A Worker's key ring routes, in memory. A bearer token names the device: `pkeyt_<x>` is `dev_<x>`.
private final class RingServer: PolarisTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var ring: [String: Any]?
    private var recoveryCt: [String: Any]?
    private var wraps: [String: [String: Any]] = [:]
    private var adopted: [[String: Any]] = []
    private(set) var requests: [String] = []

    func requestLog() -> [String] { lock.withLock { requests } }

    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        lock.withLock { handle(request) }
    }

    private func json(_ status: Int, _ obj: Any?) -> PolarisResponse {
        let body = obj.map { (try? JSONSerialization.data(withJSONObject: $0)) ?? Data() } ?? Data()
        return PolarisResponse(status: status, body: body)
    }

    private func refuse(_ status: Int, _ code: String) -> PolarisResponse {
        json(status, ["error": ["code": code, "message": code]])
    }

    private func handle(_ r: PolarisRequest) -> PolarisResponse {
        let token = (r.headers["authorization"] ?? "").replacingOccurrences(of: "Bearer ", with: "")
        let device = "dev_" + token.replacingOccurrences(of: "pkeyt_", with: "")
        let path = r.url.path.components(separatedBy: "/devices/keyring").last ?? ""
        requests.append("\(r.method) \(path)")
        let body = r.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        switch (r.method, path) {
        case ("GET", ""):
            var ringOut: Any = NSNull()
            if var g = ring {
                g["recovery"] = ["set": recoveryCt != nil]
                g["adopted"] = adopted
                ringOut = g
            }
            return json(200, ["ring": ringOut, "wrap": wraps[device] ?? NSNull()])
        case ("POST", ""), ("POST", "/reset"):
            if path == "" && ring != nil { return refuse(409, "keyring_conflict") }
            let wrap = body["wrap"] as! [String: Any]
            ring = [
                "ringId": body["ringId"]!, "epoch": 1, "rootKid": body["rootKid"]!, "state": "active",
                "createdAt": 1_700_000_000,
            ]
            wraps = [
                device: wrap.merging(["epoch": 1, "kid": body["rootKid"]!, "by": device]) { a, _ in a }
            ]
            recoveryCt = (body["recovery"] as? [String: Any]).map {
                ["ct": $0["ct"]!, "epoch": 1, "kid": body["rootKid"]!]
            }
            return json(201, nil)
        case ("PUT", "/recovery"):
            recoveryCt = body
            return json(204, nil)
        case ("GET", "/recovery"):
            guard let rc = recoveryCt else { return refuse(404, "not_found") }
            return json(200, rc)
        case ("POST", "/adopt"):
            adopted.append([
                "ringId": body["fromRingId"]!, "epoch": body["epoch"]!, "kid": body["kid"]!, "ct": body["ct"]!,
            ])
            return json(204, nil)
        default:
            if path.hasPrefix("/wraps/") {
                let id = String(path.dropFirst("/wraps/".count))
                if r.method == "PUT" {
                    if wraps[id] != nil { return refuse(409, "keyring_conflict") }
                    wraps[id] = body.merging(["by": device]) { a, _ in a }
                    return json(204, nil)
                }
                if r.method == "DELETE" {
                    wraps[id] = nil
                    return json(204, nil)
                }
            }
            return refuse(404, "not_found")
        }
    }
}

/// Holds the first POST to the key ring route until `release()`, then forwards it.
private final class RingGate: PolarisTransport, @unchecked Sendable {
    private let inner: any PolarisTransport
    private let lock = NSLock()
    private var held = false
    private var reached = false
    private var waiter: CheckedContinuation<Void, Never>?
    init(_ inner: any PolarisTransport) { self.inner = inner }

    var isHeld: Bool { lock.withLock { reached && held } }
    func release() {
        let w = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            held = false
            defer { waiter = nil }
            return waiter
        }
        w?.resume()
    }

    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        let first = lock.withLock { () -> Bool in
            if request.method == "POST", !reached {
                reached = true
                held = true
                return true
            }
            return false
        }
        if first {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                let resumeNow = lock.withLock { () -> Bool in
                    if !held { return true }
                    waiter = c
                    return false
                }
                if resumeNow { c.resume() }
            }
        }
        return try await inner.send(request)
    }
}

/// The iCloud Keychain, as one Apple ID shares it between devices: items by (subject, ringId).
private final class FakeICloud: SyncRootBackupPort, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    var failWrites = false
    var failLoads = false
    struct Down: Error {}

    private func key(_ s: String, _ r: String) -> String { "\(s):\(r)" }
    var keys: [String] { lock.withLock { items.keys.sorted() } }
    func value(_ s: String, _ r: String) -> Data? { lock.withLock { items[key(s, r)] } }
    func plant(_ s: String, _ r: String, _ v: Data) { lock.withLock { items[key(s, r)] = v } }

    func load(subject: String, ringId: String) throws -> Data? {
        if failLoads { throw Down() }
        return value(subject, ringId)
    }
    func save(subject: String, ringId: String, value: Data) throws {
        if failWrites { throw Down() }
        lock.withLock { items[key(subject, ringId)] = value }
    }
    func remove(subject: String, ringId: String) throws {
        lock.withLock { items[key(subject, ringId)] = nil }
    }
}

private let subjectA = "ps_" + "aB3-_xYz09" + "QrStUvWxyZ_-"

private final class Listener: SyncRootListener, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [Bool] = []
    func setRoot(present: Bool) { lock.withLock { seen.append(present) } }
    var values: [Bool] { lock.withLock { seen } }
}

final class SyncKeyringTests: XCTestCase {
    private struct Device {
        let keyring: SyncKeyring
        let core: CoreContext
        let roots: RingRootStore
        let store: InMemoryStore
        let keys: DeviceKeyStore
        var id: String { "dev_\(name)" }
        let name: String
    }

    private func device(
        _ name: String, server: any PolarisTransport, backup: SyncKeyringOptions.Backup = .off,
        subject: String? = nil
    ) async throws -> Device {
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev_\(name)")
        await store.setToken("pkeyt_\(name)")
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: [:],
                trustRefresh: false, store: store, transport: server))
        try await core.start()
        let keys = try DeviceKeyStore.inMemory(productSlug: "djdl")
        let roots = RingRootStore.inMemory()
        let keyring = SyncKeyring(
            core: core,
            options: SyncKeyringOptions(keys: keys, rootStore: roots, backup: backup, subject: { subject }))
        return Device(keyring: keyring, core: core, roots: roots, store: store, keys: keys, name: name)
    }

    func testDefaultKeyringUsesTheClientKeychainAccessGroup() throws {
        func ring(_ group: String?) throws -> SyncKeyring {
            let core = try CoreContext(
                options: CoreOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: [:],
                    trustRefresh: false, store: InMemoryStore(productSlug: "djdl", deviceId: "dev_x"),
                    keychainAccessGroup: group))
            return PolarisKeyClient.keyring(core: core, attachments: LockedValue([:]))
        }
        XCTAssertEqual(try ring("TEAM.group.shared").options.accessGroup, "TEAM.group.shared")
        XCTAssertNil(try ring(nil).options.accessGroup)
    }

    private func code(_ e: Error) -> String? { (e as? PolarisError)?.code }

    func testCreateHoldsTheRootPinsAndKeepsItInTheKeychain() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        let listener = Listener()
        _ = a.keyring.attach(listener)
        let made = try await a.keyring.create()
        XCTAssertEqual(made.recoveryCode?.count, 39)
        XCTAssertTrue(made.ringId.hasPrefix("rg_"))
        XCTAssertFalse(a.keyring.codec.locked)
        XCTAssertEqual(a.keyring.codec.kid, made.rootKid)
        XCTAssertEqual(listener.values, [false, true])
        let pin = await a.keyring.pin()
        XCTAssertEqual(pin, SyncRingPin(ringId: made.ringId, epoch: 1, rootKid: made.rootKid))
        let status = await a.keyring.status()
        XCTAssertTrue(status.unlocked)
        XCTAssertTrue(status.rootStored)
        // The codec round-trips, with the name inside the envelope.
        let env = try a.keyring.codec.seal(collection: "$settings", name: "theme", value: .string("dark"))
        guard
            case .ok(let name, let value) = try a.keyring.codec.open(
                collection: "$settings", name: "theme", envelope: env)
        else { return XCTFail("did not open") }
        XCTAssertEqual(name, "theme")
        XCTAssertEqual(value, .string("dark"))
        let blinded = try a.keyring.codec.blind(kind: .record, ctx: "saves", name: "slot-1")
        XCTAssertTrue(SyncBlind.isBlindedName(blinded))
    }

    func testCreateWhereARingExistsIsAConflictAndHoldsNothing() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        _ = try await a.keyring.create()
        let b = try await device("b", server: server)
        do {
            _ = try await b.keyring.create()
            XCTFail("expected a conflict")
        } catch { XCTAssertEqual(code(error), "keyring_conflict") }
        XCTAssertTrue(b.keyring.codec.locked)
        let bs = await b.keyring.status()
        XCTAssertNil(bs.pinned)
        XCTAssertFalse(bs.rootStored)
    }

    func testAnotherDeviceUnlocksAfterAWrapAndReadsTheFirstDevicesData() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        _ = try await a.keyring.create()
        let b = try await device("b", server: server)
        let none = try await b.keyring.unlock()
        XCTAssertEqual(none, .locked(reason: .noWrap))
        let bPub = try await b.keys.ensure().agreeKey
        try await a.keyring.wrapTo(deviceId: b.id, agreeKey: bPub)
        let got = try await b.keyring.unlock()
        guard case .unlocked = got else { return XCTFail("\(got)") }
        let env = try a.keyring.codec.seal(collection: "saves", name: "slot", value: .int(7))
        guard case .ok(_, let v) = try b.keyring.codec.open(collection: "saves", name: "slot", envelope: env)
        else { return XCTFail("b could not open a's envelope") }
        XCTAssertEqual(v, .int(7))
        // A wrap that stands is create-only; removing it locks the next start's unwrap path.
        try await a.keyring.removeWrap(deviceId: b.id)
        let log = server.requestLog()
        XCTAssertTrue(log.contains { $0.hasPrefix("DELETE /wraps/") })
    }

    func testWrapToRefusesBadInputBeforeAnyRequest() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        do {
            try await a.keyring.wrapTo(deviceId: "dev_b", agreeKey: Data(count: 32))
            XCTFail("locked")
        } catch { XCTAssertEqual(code(error), ErrorCode.syncLocked) }
        _ = try await a.keyring.create()
        let before = server.requestLog().count
        for bad in ["", "a/b", "a b", "a?x"] {
            do {
                try await a.keyring.wrapTo(deviceId: bad, agreeKey: Data(count: 32))
                XCTFail("accepted \(bad)")
            } catch { XCTAssertEqual(code(error), ErrorCode.invalidArgument) }
        }
        do {
            try await a.keyring.wrapTo(deviceId: "dev_b", agreeKey: Data(count: 31))
            XCTFail("short key")
        } catch { XCTAssertEqual(code(error), ErrorCode.invalidArgument) }
        XCTAssertEqual(server.requestLog().count, before)
    }

    func testRecoveryWithTheCodeUnlocksAndDepositsAWrap() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        let made = try await a.keyring.create()
        let c = try await device("c", server: server)
        // A wrong but well-formed code, and a malformed one (no request at all).
        let other = try SyncRecovery.encode(code: SyncRecovery.newCode())
        do {
            _ = try await c.keyring.recover(other)
            XCTFail("wrong code")
        } catch { XCTAssertEqual(code(error), ErrorCode.recoveryCodeInvalid) }
        let before = server.requestLog().count
        do {
            _ = try await c.keyring.recover("0000-0000")
            XCTFail("malformed")
        } catch { XCTAssertEqual(code(error), ErrorCode.recoveryCodeInvalid) }
        XCTAssertEqual(server.requestLog().count, before)
        XCTAssertTrue(c.keyring.codec.locked)
        let done = try await c.keyring.recover(made.recoveryCode!.lowercased())
        XCTAssertEqual(done.ringId, made.ringId)
        XCTAssertTrue(done.wrapDeposited)
        XCTAssertFalse(c.keyring.codec.locked)
        let pin = await c.keyring.pin()
        XCTAssertEqual(pin?.ringId, made.ringId)
        // The deposited wrap lets a restart without the Keychain root unlock.
        try c.roots.clear()
        await c.keyring.lock()
        let again = try await c.keyring.unlock()
        guard case .unlocked = again else { return XCTFail("\(again)") }
    }

    func testANewRecoveryCodeReplacesTheOldOne() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        let made = try await a.keyring.create()
        let fresh = try await a.keyring.setRecoveryCode()
        XCTAssertNotEqual(fresh, made.recoveryCode)
        let c = try await device("c", server: server)
        do {
            _ = try await c.keyring.recover(made.recoveryCode!)
            XCTFail("old code")
        } catch { XCTAssertEqual(code(error), ErrorCode.recoveryCodeInvalid) }
        let ok = try await c.keyring.recover(fresh)
        XCTAssertEqual(ok.ringId, made.ringId)
    }

    func testAChangedRingIsReportedNotOpenedUntilConfirmed() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        let first = try await a.keyring.create()
        // Another device starts over: the Worker now serves a different ring.
        let d = try await device("d", server: server)
        let second = try await d.keyring.reset()
        XCTAssertNotEqual(first.ringId, second.ringId)
        let changed = try await a.keyring.unlock()
        guard case .ringChanged(let pinned, let served, _, _) = changed else { return XCTFail("\(changed)") }
        XCTAssertEqual(pinned.ringId, first.ringId)
        XCTAssertEqual(served.ringId, second.ringId)
        // The root held for the old ring is untouched, and so is the pin.
        XCTAssertEqual(a.keyring.codec.kid, first.rootKid)
        let stillPinned = await a.keyring.pin()
        XCTAssertEqual(stillPinned?.ringId, first.ringId)
        // Confirming a ring the Worker no longer serves is reported again, not adopted.
        let stale = SyncRingPin(ringId: first.ringId, epoch: 1, rootKid: "00")
        let again = try await a.keyring.acceptRingChange(confirmed: stale)
        guard case .ringChanged = again else { return XCTFail("\(again)") }
        // Confirmed, but this device has no wrap on the new ring yet: nothing is pinned.
        let noWrap = try await a.keyring.acceptRingChange(confirmed: served)
        XCTAssertEqual(noWrap, .locked(reason: .noWrap))
        let unchanged = await a.keyring.pin()
        XCTAssertEqual(unchanged?.ringId, first.ringId)
        // With a wrap, the confirmed ring is opened and re-pinned.
        let aPub = try await a.keys.ensure().agreeKey
        try await d.keyring.wrapTo(deviceId: a.id, agreeKey: aPub)
        let ok = try await a.keyring.acceptRingChange(confirmed: served)
        XCTAssertEqual(ok, .unlocked(ringId: second.ringId, epoch: 1))
        let moved = await a.keyring.pin()
        XCTAssertEqual(moved, served)
        XCTAssertEqual(a.keyring.codec.kid, second.rootKid)
    }

    func testARestartIsUnlockedFromTheKeychainOnlyWhileItMatchesThePin() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        let made = try await a.keyring.create()
        // A new process: same Core store and Keychain item, nothing in memory.
        let restarted = SyncKeyring(core: a.core, options: SyncKeyringOptions(keys: a.keys, rootStore: a.roots))
        XCTAssertTrue(restarted.codec.locked)
        let status = await restarted.status()
        XCTAssertTrue(status.unlocked)
        XCTAssertEqual(restarted.codec.kid, made.rootKid)
        // A stored root for another ring is not used.
        let rogue = RingRootStore.inMemory()
        let kid = SyncCrypto.deriveKid(root: Data(repeating: 9, count: 32))
        try rogue.save(
            StoredRingRoot(
                ringId: "rg_" + String(repeating: "B", count: 22), epoch: 1,
                kid: kid.map { String(format: "%02x", $0) }.joined(),
                root: Base64URL.encode(Data(repeating: 9, count: 32))))
        let wrongRing = SyncKeyring(core: a.core, options: SyncKeyringOptions(keys: a.keys, rootStore: rogue))
        let ws = await wrongRing.status()
        XCTAssertFalse(ws.unlocked)
    }

    func testForgetDropsTheRootTheKeychainItemAndThePin() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        let listener = Listener()
        _ = a.keyring.attach(listener)
        _ = try await a.keyring.create()
        try await a.keyring.forget()
        XCTAssertTrue(a.keyring.codec.locked)
        XCTAssertEqual(listener.values.last, false)
        let s = await a.keyring.status()
        XCTAssertFalse(s.unlocked)
        XCTAssertFalse(s.rootStored)
        XCTAssertNil(s.pinned)
        let rec = await a.store.readRecord("sync-ring-pin")
        XCTAssertNil(rec)
        do {
            _ = try a.keyring.codec.seal(collection: "$settings", name: "x", value: .null)
            XCTFail("locked")
        } catch { XCTAssertEqual(code(error), ErrorCode.syncLocked) }
        // Forgetting is local: the Worker keeps this device's wrap, so the person unlocks again.
        let again = try await a.keyring.unlock()
        guard case .unlocked = again else { return XCTFail("\(again)") }
    }

    func testResetKeepsTheOldRootForAdoptAndAdoptedDataOpens() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        let first = try await a.keyring.create()
        let old = try a.keyring.codec.seal(collection: "saves", name: "slot", value: .string("old"))
        let second = try await a.keyring.reset(recovery: false)
        XCTAssertNil(second.recoveryCode)
        XCTAssertNotEqual(first.ringId, second.ringId)
        // The envelope sealed under the previous root still opens: its root is kept for adopt.
        guard case .ok(_, let v) = try a.keyring.codec.open(collection: "saves", name: "slot", envelope: old)
        else { return XCTFail("old envelope") }
        XCTAssertEqual(v, .string("old"))
        do {
            try await a.keyring.adopt(ringId: "rg_" + String(repeating: "Z", count: 22))
            XCTFail("unknown ring")
        } catch { XCTAssertEqual(code(error), ErrorCode.invalidArgument) }
        try await a.keyring.adopt(ringId: first.ringId)
        // Another device that holds only the new root opens the adopted one through the ring.
        let b = try await device("b", server: server)
        let bPub = try await b.keys.ensure().agreeKey
        try await a.keyring.wrapTo(deviceId: b.id, agreeKey: bPub)
        _ = try await b.keyring.unlock()
        guard case .invalid(.kid) = try b.keyring.codec.open(collection: "saves", name: "slot", envelope: old)
        else { return XCTFail("b should not read it yet") }
        let opened = try await b.keyring.openAdopted()
        XCTAssertEqual(opened, [first.ringId])
        guard case .ok(_, let w) = try b.keyring.codec.open(collection: "saves", name: "slot", envelope: old)
        else { return XCTFail("b after adopt") }
        XCTAssertEqual(w, .string("old"))
    }

    func testLockedOperationsRefuseWithSyncLocked() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        do {
            _ = try await a.keyring.setRecoveryCode()
            XCTFail("locked")
        } catch { XCTAssertEqual(code(error), ErrorCode.syncLocked) }
        do {
            try await a.keyring.adopt(ringId: "rg_" + String(repeating: "A", count: 22))
            XCTFail("locked")
        } catch { XCTAssertEqual(code(error), ErrorCode.syncLocked) }
        do {
            _ = try a.keyring.codec.blind(kind: .setting, ctx: "$settings", name: "x")
            XCTFail("locked")
        } catch { XCTAssertEqual(code(error), ErrorCode.syncLocked) }
    }

    func testNothingPrintsTheRootOrTheRecoveryCode() async throws {
        let server = RingServer()
        let a = try await device("a", server: server)
        let made = try await a.keyring.create()
        let stored = try XCTUnwrap(try a.roots.load())
        var seen = ""
        dump(a.keyring, to: &seen)
        dump(a.keyring.codec, to: &seen)
        dump(made, to: &seen)
        seen += "\(a.keyring) \(a.keyring.codec) \(made) \(stored) \(String(reflecting: made))"
        let secrets = [made.recoveryCode!, stored.root] + [made.recoveryCode!.replacingOccurrences(of: "-", with: "")]
        for s in secrets { XCTAssertFalse(seen.contains(s), "a secret was printed") }
        // The Worker never saw the root or the code in the clear.
        let all = server.requestLog().joined()
        XCTAssertFalse(all.contains(stored.root))
    }

    // N-2: a ring made (or unlocked) before `forget()` ran never stores its root after it.
    func testACreateThatStartedBeforeForgetKeepsNoRoot() async throws {
        let gate = RingGate(RingServer())
        let a = try await device("a", server: gate)
        let making = Task { try await a.keyring.create() }
        while !gate.isHeld { try await Task.sleep(nanoseconds: 5_000_000) }
        try await a.keyring.forget()
        gate.release()
        do {
            _ = try await making.value
            XCTFail("a create that began before the forget completed")
        } catch {}
        XCTAssertNil(try a.roots.load(), "the root was stored after the forget")
        XCTAssertFalse(a.keyring.unlocked)
        let pin = await a.core.store.readRecord("sync-ring-pin")
        XCTAssertNil(pin, "the pin was written after the forget")
    }

    // ── U-39.5: the iCloud Keychain root backup ──────────────────────────────────────────

    private func backedUp(_ icloud: FakeICloud, ringId: String) throws -> StoredRingRoot {
        let data = try XCTUnwrap(icloud.value(subjectA, ringId), "no backup item")
        return try JSONDecoder().decode(StoredRingRoot.self, from: data)
    }

    func testCreateWritesTheBackupItemForTheSubjectAndRing() async throws {
        let icloud = FakeICloud()
        let a = try await device("a", server: RingServer(), backup: .custom(icloud), subject: subjectA)
        let made = try await a.keyring.create()
        XCTAssertEqual(icloud.keys, ["\(subjectA):\(made.ringId)"])
        let item = try backedUp(icloud, ringId: made.ringId)
        XCTAssertEqual(item.ringId, made.ringId)
        XCTAssertEqual(item.kid, made.rootKid)
        XCTAssertEqual(item, try XCTUnwrap(try a.roots.load()), "the same record as the device Keychain item")
        // Nothing but the root's record: the recovery code is never in the backup.
        let text = String(decoding: try XCTUnwrap(icloud.value(subjectA, made.ringId)), as: UTF8.self)
        XCTAssertFalse(text.contains(try XCTUnwrap(made.recoveryCode)))
    }

    func testANewDeviceUnlocksSilentlyFromTheBackupWithNoWrap() async throws {
        let icloud = FakeICloud()
        let server = RingServer()
        let a = try await device("a", server: server, backup: .custom(icloud), subject: subjectA)
        let made = try await a.keyring.create()
        // Device b has no wrap on the server and no local root; it shares the Apple ID.
        let b = try await device("b", server: server, backup: .custom(icloud), subject: subjectA)
        let got = try await b.keyring.unlock()
        XCTAssertEqual(got, .unlocked(ringId: made.ringId, epoch: 1))
        XCTAssertEqual(b.keyring.codec.kid, made.rootKid)
        let pin = await b.keyring.pin()
        XCTAssertEqual(pin, SyncRingPin(ringId: made.ringId, epoch: 1, rootKid: made.rootKid))
        XCTAssertNotNil(try b.roots.load(), "the device keeps its own copy")
        let env = try a.keyring.codec.seal(collection: "saves", name: "slot", value: .int(3))
        guard case .ok(_, let v) = try b.keyring.codec.open(collection: "saves", name: "slot", envelope: env)
        else { return XCTFail("b could not open a's envelope") }
        XCTAssertEqual(v, .int(3))
        XCTAssertFalse(server.requestLog().contains { $0.hasPrefix("GET /recovery") }, "no recovery code was needed")
    }

    func testABackupThatIsNotTheServedRingsRootIsIgnored() async throws {
        let icloud = FakeICloud()
        let server = RingServer()
        let a = try await device("a", server: server, backup: .custom(icloud), subject: subjectA)
        let made = try await a.keyring.create()
        // A root whose record names the right ring and kid but is another key.
        let rogue = StoredRingRoot(
            ringId: made.ringId, epoch: 1, kid: made.rootKid, root: Base64URL.encode(Data(repeating: 7, count: 32)))
        icloud.plant(subjectA, made.ringId, try JSONEncoder().encode(rogue))
        let b = try await device("b", server: server, backup: .custom(icloud), subject: subjectA)
        let got = try await b.keyring.unlock()
        XCTAssertEqual(got, .locked(reason: .noWrap))
        XCTAssertTrue(b.keyring.codec.locked)
        // Garbage, and another subject's item, are misses too.
        icloud.plant(subjectA, made.ringId, Data("{}".utf8))
        let again = try await b.keyring.unlock()
        XCTAssertEqual(again, .locked(reason: .noWrap))
        let c = try await device(
            "c", server: server, backup: .custom(icloud), subject: "ps_" + String(repeating: "Z", count: 22))
        let other = try await c.keyring.unlock()
        XCTAssertEqual(other, .locked(reason: .noWrap))
    }

    func testSignOutKeepsTheBackupAndTheNextSignInUnlocksFromIt() async throws {
        let icloud = FakeICloud()
        let server = RingServer()
        let a = try await device("a", server: server, backup: .custom(icloud), subject: subjectA)
        let made = try await a.keyring.create()
        let before = icloud.value(subjectA, made.ringId)
        try await a.keyring.forget()
        XCTAssertNil(try a.roots.load(), "the device Keychain item is gone")
        XCTAssertEqual(icloud.value(subjectA, made.ringId), before, "R-11: sign-out keeps the backup item")
        // Remove the wrap too, so only the backup can unlock the next sign-in.
        try await a.keyring.removeWrap(deviceId: a.id)
        let got = try await a.keyring.unlock()
        XCTAssertEqual(got, .unlocked(ringId: made.ringId, epoch: 1))
    }

    func testResetRemovesTheOldRingsItemAndWritesTheNewOne() async throws {
        let icloud = FakeICloud()
        let a = try await device("a", server: RingServer(), backup: .custom(icloud), subject: subjectA)
        let first = try await a.keyring.create()
        let second = try await a.keyring.reset()
        XCTAssertNotEqual(first.ringId, second.ringId)
        XCTAssertEqual(icloud.keys, ["\(subjectA):\(second.ringId)"])
        XCTAssertEqual(try backedUp(icloud, ringId: second.ringId).kid, second.rootKid)
    }

    func testStartOverFromALockedDeviceRemovesTheOldItem() async throws {
        let icloud = FakeICloud()
        let server = RingServer()
        let a = try await device("a", server: server, backup: .custom(icloud), subject: subjectA)
        let first = try await a.keyring.create()
        try await a.keyring.forget()
        _ = try await a.keyring.unlock()  // pins the ring again
        await a.keyring.lock()
        let second = try await a.keyring.reset()
        XCTAssertEqual(icloud.keys, ["\(subjectA):\(second.ringId)"])
        XCTAssertNotEqual(first.ringId, second.ringId)
    }

    func testDeleteBackupRemovesTheItemAndForgetDoesNot() async throws {
        let icloud = FakeICloud()
        let a = try await device("a", server: RingServer(), backup: .custom(icloud), subject: subjectA)
        _ = try await a.keyring.create()
        try await a.keyring.forget()
        XCTAssertEqual(icloud.keys.count, 1)
        _ = try await a.keyring.unlock()
        try await a.keyring.deleteBackup()
        XCTAssertEqual(icloud.keys, [])
    }

    func testARecoveryWritesTheBackupToo() async throws {
        let icloud = FakeICloud()
        let server = RingServer()
        let a = try await device("a", server: server)
        let made = try await a.keyring.create()
        let b = try await device("b", server: server, backup: .custom(icloud), subject: subjectA)
        _ = try await b.keyring.recover(try XCTUnwrap(made.recoveryCode))
        XCTAssertEqual(icloud.keys, ["\(subjectA):\(made.ringId)"])
    }

    func testNoSubjectOrOptOutOrAFailingStoreNeverTouchesTheRingCalls() async throws {
        let icloud = FakeICloud()
        let noSubject = try await device("a", server: RingServer(), backup: .custom(icloud), subject: nil)
        _ = try await noSubject.keyring.create()
        XCTAssertEqual(icloud.keys, [], "no subject, no item")
        let off = try await device("b", server: RingServer(), backup: .off, subject: subjectA)
        _ = try await off.keyring.create()
        XCTAssertEqual(icloud.keys, [])
        icloud.failWrites = true
        icloud.failLoads = true
        let down = try await device("c", server: RingServer(), backup: .custom(icloud), subject: subjectA)
        let made = try await down.keyring.create()
        XCTAssertFalse(down.keyring.codec.locked, "a backup that cannot be written does not fail create")
        try await down.keyring.deleteBackup()
        let again = try await down.keyring.unlock()
        XCTAssertEqual(again, .unlocked(ringId: made.ringId, epoch: 1))
    }

    func testRealSubjectsAndRingIdsFitThePlatformStoreAndItsAddress() async throws {
        let keychain = BackupKeychain()
        let store = PlatformBackupStore(backend: keychain)
        // The wire patterns decide the shape: `ps_` + 22 and `rg_` + 22 base64url characters, with
        // `-` and `_` anywhere after the prefix.
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        for n in 0..<200 {
            let tail = { (shift: Int) in String((0..<22).map { alphabet[($0 * 7 + n * 3 + shift) % alphabet.count] }) }
            let subject = "ps_" + tail(1)
            let ringId = "rg_" + tail(5)
            XCTAssertTrue(SignedInUser.isSubject(subject))
            XCTAssertNotNil(subject.range(of: PAIRWISE_SUBJECT_PATTERN, options: .regularExpression))
            XCTAssertNotNil(ringId.range(of: SYNC_RING_ID_PATTERN, options: .regularExpression))
            let item = PlatformBackupStore.Item.syncRoot(product: "djdl", subject: subject, ringId: ringId)
            try store.set(item, value: Data(#"{"v":1}"#.utf8))
            XCTAssertNotNil(try store.get(item))
        }
        let edge = "ps_" + String(repeating: "-", count: 22)
        let edgeRing = "rg_" + String(repeating: "_", count: 22)
        try store.set(.syncRoot(product: "djdl", subject: edge, ringId: edgeRing), value: Data("{}".utf8))
    }

    func testThePlatformBackupMapsToTheSyncRootItem() async throws {
        let keychain = BackupKeychain()
        let port = PlatformSyncRootBackup(product: "djdl", store: PlatformBackupStore(backend: keychain))
        let ringId = "rg_" + String(repeating: "Q", count: 22)
        try port.save(subject: subjectA, ringId: ringId, value: Data("{}".utf8))
        let key = "pkey-sync:djdl|\(subjectA):\(ringId)"
        XCTAssertEqual(keychain.keys, [key])
        XCTAssertEqual(try port.load(subject: subjectA, ringId: ringId), Data("{}".utf8))
        try port.remove(subject: subjectA, ringId: ringId)
        XCTAssertEqual(keychain.keys, [])
        // A value that is not a JSON object, or a bad name, is refused by the store, not stored.
        XCTAssertThrowsError(try port.save(subject: "bad/subject", ringId: ringId, value: Data("{}".utf8)))
    }
}

/// An in-memory keychain keyed by service and account.
private final class BackupKeychain: KeychainBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    var keys: [String] { lock.withLock { items.keys.sorted() } }
    private func key(_ q: [String: Any]) -> String {
        "\(q[kSecAttrService as String] ?? "")|\(q[kSecAttrAccount as String] ?? "")"
    }
    func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?) {
        lock.withLock { items[key(query)].map { (errSecSuccess, $0) } ?? (errSecItemNotFound, nil) }
    }
    func add(_ a: [String: Any]) -> OSStatus {
        lock.withLock { items[key(a)] = a[kSecValueData as String] as? Data }
        return errSecSuccess
    }
    func update(_ q: [String: Any], _ a: [String: Any]) -> OSStatus {
        lock.withLock {
            guard items[key(q)] != nil else { return errSecItemNotFound }
            items[key(q)] = a[kSecValueData as String] as? Data
            return errSecSuccess
        }
    }
    func delete(_ q: [String: Any]) -> OSStatus {
        lock.withLock { items.removeValue(forKey: key(q)) == nil ? errSecItemNotFound : errSecSuccess }
    }
}
