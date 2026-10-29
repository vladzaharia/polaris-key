// `client.keyring` — the Cloud Sync key ring (U-39.3; WIRE-CONTRACT-V5 §13.10, §13.11): create the
// ring, hold its root `R`, wrap `R` to another device, set the recovery code and recover from it,
// reset, adopt, and seal and open values with the root's keys. The Node client is the reference
// (`packages/sdk-node/src/keyring/client.ts`); the crypto is `PolarisKeyCore/Sync`.
//
// Rules this module keeps:
//  - `R` is held in memory and in one Keychain item (`RingRootStore`: service `pkey:<product>`,
//    account `sync-root`, `AfterFirstUnlockThisDeviceOnly`, never synchronizable). It is never
//    returned, logged, put in an error or printed: every type that holds it prints as redacted
//    (`CustomReflectable`). A restart gets it back from the Keychain item, or through `unlock()`,
//    which opens this device's own wrap.
//  - The device's agreement key never leaves its `DeviceKeyPort`: a wrap is opened through the
//    port's `dh`.
//  - The recovery code is returned once, to the caller, and kept nowhere.
//  - A wrap is accepted only when `kid(R)` equals the ring's `rootKid`.
//  - The first root this client acquires (create, recover, unlock) pins `{ringId, epoch, rootKid}`
//    in the Core store (no secret). A served ring or wrap that differs is never opened: `unlock()`
//    answers `ringChanged`, and only the recovery code (`recover`) or an explicit
//    `acceptRingChange(confirmed:)` re-pins. `forget()` drops the pin and the Keychain root; the
//    release hook calls it. The stored root is used only while it matches the pin.
//  - iCloud Keychain backup (U-39.5, R-11): the same root also goes into `PlatformBackupStore`
//    (synchronizable; service `pkey-sync:<product>`, account `<subject>:<ringId>`), written when the
//    ring is created, reset, recovered or unlocked. A new device with no local root reads it, once
//    it matches the served ring's `kid`, as a silent rung before the recovery code is asked for.
//    Sign-out (`forget()`) keeps the item, because deleting a synchronizable item deletes it on
//    every device of the Apple ID. Only `reset()` (which removes the old ring's item), `deleteBackup()`
//    (account deletion) and the person's own Keychain remove it. A backup that cannot be read or
//    written is skipped: it never fails a ring call. `SyncKeyringOptions.backup = .off` opts out.

import Foundation
import PolarisKeyCore
import PolarisKeyPlatform

/// Told when this device gains or loses the root: Cloud Sync's machine takes the root as a flag.
public protocol SyncRootListener: Sendable {
    func setRoot(present: Bool)
}

/// The served ring, as `GET /<p>/devices/keyring` answers it.
public struct SyncKeyringRing: Sendable, Equatable {
    public struct Adopted: Sendable, Equatable {
        public let ringId: String
        public let epoch: Int
        public let kid: String
        public let ct: String
    }
    public struct Previous: Sendable, Equatable {
        public let ringId: String
        public let kid: String
        public let until: Int
    }
    public let ringId: String
    public let epoch: Int
    public let rootKid: String
    public let state: String
    public let createdAt: Int
    public let recoverySet: Bool
    public let recoveryCreatedAt: Int?
    public let adopted: [Adopted]
    public let previous: Previous?
}

/// This device's own wrap, as served.
public struct SyncKeyringWrapInfo: Sendable, Equatable {
    public let epoch: Int
    public let kid: String
    /// The HPKE KEM id (`32`), or an older Worker's `"x25519"`.
    public let kem: JSONValue
    public let enc: String
    public let ct: String
    public let by: String?
}

public struct SyncKeyringState: Sendable, Equatable {
    public let ring: SyncKeyringRing?
    public let wrap: SyncKeyringWrapInfo?
}

/// What this device holds right now; no request is made.
public struct SyncKeyringStatus: Sendable, Equatable {
    public let unlocked: Bool
    public let ringId: String?
    public let epoch: Int?
    public let pinned: SyncRingPin?
    /// Whether the Keychain holds a root for this product.
    public let rootStored: Bool
}

public enum SyncUnlockResult: Sendable, Equatable {
    case unlocked(ringId: String, epoch: Int)
    case locked(reason: LockReason)
    /// The served ring is not the pinned one. Nothing was opened or replaced; confirm with the
    /// person, then `recover(_:)` or `acceptRingChange(confirmed:)`. `by` is the device that wrapped.
    case ringChanged(pinned: SyncRingPin, served: SyncRingPin, createdAt: Int, by: String?)

    public enum LockReason: String, Sendable {
        case noRing = "no-ring", noWrap = "no-wrap", unusableWrap = "unusable-wrap"
    }
}

/// A new ring. It prints without the recovery code.
public struct SyncCreatedRing: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    public let ringId: String
    public let epoch: Int
    public let rootKid: String
    /// The recovery code, shown once, when the ring was created with one.
    public let recoveryCode: String?
    public var description: String { "SyncCreatedRing(ringId: \(ringId), epoch: \(epoch))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }
}

public struct SyncRecovered: Sendable, Equatable {
    public let ringId: String
    public let epoch: Int
    /// False when the Worker refused this device's own wrap or one already stood.
    public let wrapDeposited: Bool
}

public struct SyncRecoveryBlob: Sendable, Equatable {
    public let ct: String
    public let epoch: Int
    public let kid: String
}

/// The key material of one ring. It prints as redacted.
private struct HeldRoot: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable, Sendable {
    let ringId: String
    let epoch: Int
    let kid: Data
    let root: Data
    var description: String { "HeldRoot(redacted)" }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }
}

/// The roots in memory, shared between the keyring and its codec.
private final class RingMemory: @unchecked Sendable, CustomReflectable {
    private let lock = NSLock()
    private var heldValue: HeldRoot?
    private var othersValue: [HeldRoot] = []
    private var listeners: [(id: Int, l: any SyncRootListener)] = []
    private var nextId = 0

    var customMirror: Mirror { Mirror(self, children: [], displayStyle: .class) }

    var held: HeldRoot? { lock.withLock { heldValue } }
    var others: [HeldRoot] { lock.withLock { othersValue } }

    func set(held: HeldRoot?, others: [HeldRoot]? = nil) {
        let ls = lock.withLock { () -> [any SyncRootListener] in
            heldValue = held
            if let others { othersValue = others }
            return listeners.map(\.l)
        }
        for l in ls { l.setRoot(present: held != nil) }
    }

    func addOther(_ h: HeldRoot) {
        lock.withLock {
            othersValue.removeAll { $0.ringId == h.ringId }
            othersValue.append(h)
        }
    }

    func attach(_ l: any SyncRootListener) -> @Sendable () -> Void {
        let (id, present) = lock.withLock { () -> (Int, Bool) in
            nextId += 1
            listeners.append((nextId, l))
            return (nextId, heldValue != nil)
        }
        l.setRoot(present: present)
        return { [weak self] in self?.lock.withLock { self?.listeners.removeAll { $0.id == id } } }
    }
}

/// What the E2E machine's host seals and opens with. It holds no key itself: every call reads the
/// ring's current root, and refuses with `sync-locked` once the ring is locked.
public final class SyncCodec: Sendable, CustomReflectable, CustomStringConvertible {
    private let memory: RingMemory
    fileprivate init(memory: RingMemory) { self.memory = memory }

    /// The current root's `kid`, lowercase hex; nil while locked.
    public var kid: String? { memory.held.map { hexOf($0.kid) } }
    public var locked: Bool { memory.held == nil }
    public var description: String { "SyncCodec(locked: \(locked))" }
    public var customMirror: Mirror { Mirror(self, children: [], displayStyle: .class) }

    private func need() throws -> HeldRoot {
        guard let h = memory.held else { throw SyncKeyring.lockedError() }
        return h
    }

    public func seal(collection: String, name: String, value: JSONValue) throws -> Data {
        try SyncEnvelope.seal(root: try need().root, collection: collection, name: name, value: value)
    }

    /// Tries the current root, then any adopted root whose `kid` the envelope names.
    public func open(collection: String, name: String, envelope: Data, aliases: [String] = [])
        throws -> SyncEnvelope.Opened
    {
        try tryRoots(envelope) {
            SyncEnvelope.open(root: $0, collection: collection, name: name, envelope: envelope, aliases: aliases)
        }
    }

    /// Opens an envelope whose name is inside it. The caller checks the name it gets back.
    public func openAny(collection: String, envelope: Data) throws -> SyncEnvelope.Opened {
        try tryRoots(envelope) { SyncEnvelope.openAnyName(root: $0, collection: collection, envelope: envelope) }
    }

    public func blind(kind: SyncBlind.Kind, ctx: String, name: String) throws -> String {
        SyncBlind.blind(root: try need().root, kind: kind, ctx: ctx, n: name)
    }

    private func tryRoots(_ envelope: Data, _ attempt: (Data) -> SyncEnvelope.Opened) throws -> SyncEnvelope.Opened {
        let current = try need()
        var last = attempt(current.root)
        guard case .invalid(.kid) = last else { return last }
        let env = Data(envelope)
        guard env.count >= 1 + SyncCrypto.kidBytes else { return last }
        let kid = env[1..<(1 + SyncCrypto.kidBytes)]
        for o in memory.others where Data(o.kid) == Data(kid) {
            last = attempt(o.root)
            if case .invalid(.kid) = last { continue }
            return last
        }
        return last
    }
}

/// `SyncCodec` is the host codec's port (U-07.5). `open` gains no default here: the host passes the
/// app's aliases explicitly.
extension SyncCodec: SyncCodecPort {}

private func hexOf(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

private func unhex(_ s: String) -> Data? {
    guard s.utf8.count % 2 == 0, s.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) })
    else { return nil }
    var d = Data()
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        d.append(UInt8(s[i..<j], radix: 16)!)
        i = j
    }
    return d
}

/// A strict, canonical base64url value of `bytes` bytes (any length when nil).
private func unb64(_ s: String, _ bytes: Int? = nil) -> Data? {
    guard !s.isEmpty, let d = Base64URL.decodeStrict(s) else { return nil }
    return bytes == nil || d.count == bytes ? d : nil
}

private func same(_ a: Data, _ b: Data) -> Bool {
    guard a.count == b.count else { return false }
    var d: UInt8 = 0
    for (x, y) in zip(a, b) { d |= x ^ y }
    return d == 0
}

private let ringIdPattern = try! NSRegularExpression(pattern: "^rg_[A-Za-z0-9_-]{22}$")
private func isRingId(_ s: String) -> Bool {
    ringIdPattern.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

/// Where the root is backed up for a new device of the same person. The bytes are a JSON object
/// (the stored-root record); the port never sees the person's recovery code.
public protocol SyncRootBackupPort: Sendable {
    func load(subject: String, ringId: String) throws -> Data?
    func save(subject: String, ringId: String, value: Data) throws
    func remove(subject: String, ringId: String) throws
}

#if canImport(Security)
    /// The iCloud Keychain backup: `PlatformBackupStore.syncRoot` for one product.
    struct PlatformSyncRootBackup: SyncRootBackupPort {
        let product: String
        let store: PlatformBackupStore

        init(product: String, accessGroup: String?) {
            self.init(product: product, store: PlatformBackupStore(accessGroup: accessGroup))
        }

        init(product: String, store: PlatformBackupStore) {
            self.product = product
            self.store = store
        }

        private func item(_ subject: String, _ ringId: String) -> PlatformBackupStore.Item {
            .syncRoot(product: product, subject: subject, ringId: ringId)
        }

        func load(subject: String, ringId: String) throws -> Data? { try store.get(item(subject, ringId)) }
        func save(subject: String, ringId: String, value: Data) throws {
            try store.set(item(subject, ringId), value: value)
        }
        func remove(subject: String, ringId: String) throws { try store.delete(item(subject, ringId)) }
    }
#endif

/// The seams a host or a test may replace.
public struct SyncKeyringOptions: Sendable {
    /// Whether, and where, the root is backed up beyond this device.
    public enum Backup: Sendable {
        /// The platform backup (iCloud Keychain on Apple), on by default. It needs a signed-in
        /// subject; without one, or where the platform has none, nothing is backed up.
        case platform
        /// No backup: the opt-out.
        case off
        /// A host's own store.
        case custom(any SyncRootBackupPort)
    }
    public var backup: Backup = .platform
    /// The signed-in subject, for the backup's account name. Nil: no backup is read or written.
    /// `client.keyring` and `configureKeyring(_:)` fill it from the identity client.
    public var subject: (@Sendable () -> String?)?
    /// This device's keys. Nil: the product's `DeviceKeyStore` (the one `client.connect` makes by
    /// default). Give the same port you gave `ConnectOptions`.
    public var keys: (any DeviceKeyPort)?
    /// Where the root is kept. Nil: the Keychain.
    public var rootStore: RingRootStore?
    /// A keychain access group for the default key port and root store.
    public var accessGroup: String?
    public init(
        keys: (any DeviceKeyPort)? = nil, rootStore: RingRootStore? = nil, accessGroup: String? = nil,
        backup: Backup = .platform, subject: (@Sendable () -> String?)? = nil
    ) {
        self.keys = keys
        self.rootStore = rootStore
        self.accessGroup = accessGroup
        self.backup = backup
        self.subject = subject
    }
}

public actor SyncKeyring: CustomReflectable {
    private static let pinRecord = "sync-ring-pin"

    private let core: CoreContext
    nonisolated let options: SyncKeyringOptions
    private nonisolated let memory = RingMemory()
    private var madeKeys: (any DeviceKeyPort)?
    private var madeRoots: RingRootStore?
    private var madeBackup: (any SyncRootBackupPort)?
    private var memoryPin: SyncRingPin?
    /// Bumped by `forget()`: an acquisition that began before it is not kept (N-2).
    private var forgetGeneration = 0
    private var ring: SyncKeyringRing?

    /// What the E2E machine seals and opens with; it reads the ring's current root on every call.
    public nonisolated let codec: SyncCodec

    public init(core: CoreContext, options: SyncKeyringOptions = SyncKeyringOptions()) {
        self.core = core
        self.options = options
        self.codec = SyncCodec(memory: memory)
    }

    public nonisolated var customMirror: Mirror { Mirror(self, children: [], displayStyle: .class) }

    // ── Errors ───────────────────────────────────────────────────────────────────────────

    static func lockedError() -> PolarisError {
        PolarisError(
            code: ErrorCode.syncLocked,
            message: "This device holds no root for the key ring; unlock it first.")
    }

    private static func badArg(_ what: String) -> PolarisError {
        PolarisError(code: ErrorCode.invalidArgument, message: what)
    }

    private static func badResponse(_ what: String) -> PolarisError {
        PolarisError(code: ErrorCode.invalidResponse, message: what)
    }

    // ── State ────────────────────────────────────────────────────────────────────────────

    /// Feeds the machine: it is told now, and on every unlock and lock. Returns a detach function.
    public nonisolated func attach(_ listener: any SyncRootListener) -> @Sendable () -> Void {
        memory.attach(listener)
    }

    /// Whether this device holds a root right now.
    public nonisolated var unlocked: Bool { memory.held != nil }

    /// What this device holds, with no request. A stored root that matches the pin is taken back
    /// first, so a restart is unlocked offline.
    public func status() async -> SyncKeyringStatus {
        await restoreStored()
        let h = memory.held
        return SyncKeyringStatus(
            unlocked: h != nil, ringId: h?.ringId, epoch: h?.epoch, pinned: await pin(),
            rootStored: ((try? roots().load()) ?? nil) != nil)
    }

    /// Forgets every root held in memory (quit). The Keychain item, the pin and the server's rows
    /// and wraps are untouched; `forget()` is the sign-out.
    public func lock() {
        memory.set(held: nil, others: [])
        ring = nil
    }

    /// Sign-out: forgets every root, in memory and in the device Keychain, and drops the pin, so the
    /// next person on this device starts clean. A root that cannot be deleted throws, so the sign-out
    /// stops rather than leave it behind. The iCloud backup item is kept (R-11): deleting it would
    /// delete it on every device of the Apple ID.
    public func forget() async throws {
        // N-2: a root being acquired when this runs is not stored after it.
        forgetGeneration += 1
        lock()
        memoryPin = nil
        var failure: Error?
        do { try roots().clear() } catch { failure = error }
        do { try await core.store.writeRecordChecked(Self.pinRecord, nil) } catch { failure = failure ?? error }
        if let failure { throw failure }
    }

    private func keyPort() throws -> any DeviceKeyPort {
        if let k = options.keys { return k }
        if let k = madeKeys { return k }
        let k = try DeviceKeyStore(productSlug: core.product, accessGroup: options.accessGroup)
        madeKeys = k
        return k
    }

    private func roots() throws -> RingRootStore {
        if let r = options.rootStore { return r }
        if let r = madeRoots { return r }
        let r = try RingRootStore(productSlug: core.product, accessGroup: options.accessGroup)
        madeRoots = r
        return r
    }

    // ── The backup ───────────────────────────────────────────────────────────────────────

    private func backupPort() -> (any SyncRootBackupPort)? {
        if let b = madeBackup { return b }
        let b: (any SyncRootBackupPort)?
        switch options.backup {
        case .off: b = nil
        case .custom(let c): b = c
        case .platform:
            #if canImport(Security)
                b = PlatformSyncRootBackup(product: core.product, accessGroup: options.accessGroup)
            #else
                b = nil
            #endif
        }
        madeBackup = b
        return b
    }

    /// The backup port and the signed-in subject, when both exist.
    private func backupTarget() -> (port: any SyncRootBackupPort, subject: String)? {
        guard let port = backupPort(), let subject = options.subject?(), !subject.isEmpty else { return nil }
        return (port, subject)
    }

    /// The backed-up root, when it is for `ring` and still derives its own `kid`. Anything wrong
    /// with the item (absent, unreadable, another ring) is a miss.
    private func backedUpRoot(matching ring: SyncRingPin) -> HeldRoot? {
        guard let t = backupTarget(), let data = (try? t.port.load(subject: t.subject, ringId: ring.ringId)) ?? nil,
            let s = try? JSONDecoder().decode(StoredRingRoot.self, from: data), s.v == StoredRingRoot.version
        else { return nil }
        return heldRoot(from: s, matching: ring)
    }

    /// Writes the root to the backup unless the same record is already there. Best effort.
    private func backUp(_ h: HeldRoot) {
        guard let t = backupTarget() else { return }
        let record = StoredRingRoot(
            ringId: h.ringId, epoch: h.epoch, kid: hexOf(h.kid), root: Base64URL.encode(h.root))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let value = try? encoder.encode(record) else { return }
        if let have = (try? t.port.load(subject: t.subject, ringId: h.ringId)) ?? nil, have == value { return }
        try? t.port.save(subject: t.subject, ringId: h.ringId, value: value)
    }

    /// The rings this client knows of: held, pinned or last served.
    private func knownRingIds() async -> [String] {
        var ids: [String] = []
        for id in [memory.held?.ringId, await pin()?.ringId, ring?.ringId] {
            if let id, !ids.contains(id) { ids.append(id) }
        }
        return ids
    }

    /// Removes the backup item of every ring this client knows of (account deletion: call it before
    /// the account goes). Nothing to remove without a signed-in subject. A store that cannot delete
    /// throws, so the caller can say so. Sign-out never calls this (R-11).
    public func deleteBackup() async throws {
        guard let t = backupTarget() else { return }
        var failure: Error?
        for id in await knownRingIds() {
            do { try t.port.remove(subject: t.subject, ringId: id) } catch { failure = failure ?? error }
        }
        if let failure { throw failure }
    }

    // ── The pin ──────────────────────────────────────────────────────────────────────────

    private struct PinRecord: Codable {
        var product: String
        var ringId: String
        var epoch: Int
        var rootKid: String
    }

    /// The pinned ring, or nil before this client first acquired a root. It never depends on the
    /// subject the Worker serves: only `forget()` drops it.
    public func pin() async -> SyncRingPin? {
        if let data = await core.store.readRecord(Self.pinRecord),
            let r = try? JSONDecoder().decode(PinRecord.self, from: data), r.product == core.product
        {
            return SyncRingPin(ringId: r.ringId, epoch: r.epoch, rootKid: r.rootKid)
        }
        return memoryPin
    }

    private func writePin(_ p: SyncRingPin) async throws {
        memoryPin = p
        let rec = PinRecord(product: core.product, ringId: p.ringId, epoch: p.epoch, rootKid: p.rootKid)
        try await core.store.writeRecordChecked(Self.pinRecord, try JSONEncoder().encode(rec))
    }

    // ── Reads ────────────────────────────────────────────────────────────────────────────

    /// `GET /<p>/devices/keyring`: the ring, and this device's own wrap.
    public func read() async throws -> SyncKeyringState {
        let res = try await request("GET", "devices/keyring")
        guard let out = Self.parseState(res.body) else {
            throw Self.badResponse("The key ring answer is not in the contract shape.")
        }
        ring = out.ring
        return out
    }

    /// Opens this device's wrap and holds the root. A device with no ring, no wrap, or a wrap it
    /// cannot use stays locked (a result, not an error); a network or server failure throws.
    public func unlock() async throws -> SyncUnlockResult { try await unlock(accepting: nil) }

    /// The person confirmed that the ring they were shown (`served` of a `ringChanged` answer) is
    /// theirs: open this device's wrap for it and pin it. If the Worker now serves another, the
    /// answer is `ringChanged` again. Call it only from confirmed UI.
    public func acceptRingChange(confirmed: SyncRingPin) async throws -> SyncUnlockResult {
        try await unlock(accepting: confirmed)
    }

    private func unlock(accepting accept: SyncRingPin?) async throws -> SyncUnlockResult {
        let gen = forgetGeneration
        let state = try await read()
        guard let ring = state.ring else { return .locked(reason: .noRing) }
        let pinned = await pin()
        // An accept holds only for the ring the person was shown; a ring that moved since is
        // reported again, not adopted.
        let expected = accept ?? pinned
        let served = SyncRingPin(ringId: ring.ringId, epoch: ring.epoch, rootKid: ring.rootKid)
        if let expected, expected != served {
            return .ringChanged(
                pinned: pinned ?? expected, served: served, createdAt: ring.createdAt, by: state.wrap?.by)
        }
        guard let kid = unhex(ring.rootKid) else { return .locked(reason: .unusableWrap) }
        if let h = memory.held, h.ringId == ring.ringId, h.epoch == ring.epoch, same(h.kid, kid) {
            return .unlocked(ringId: ring.ringId, epoch: ring.epoch)
        }
        // The Keychain root, when it is this ring's (and, when a pin stands, the pinned one).
        if let stored = storedRoot(matching: served) {
            try await hold(stored, store: false, gen: gen)
            return .unlocked(ringId: ring.ringId, epoch: ring.epoch)
        }
        // The iCloud backup: a new device of the same person unlocks silently, before the recovery
        // code is asked for. It must match the served ring's `kid`, like any other root.
        if let backed = backedUpRoot(matching: served) {
            try await hold(backed, store: true, gen: gen)
            return .unlocked(ringId: ring.ringId, epoch: ring.epoch)
        }
        guard let wrap = state.wrap else { return .locked(reason: .noWrap) }
        guard
            let keys = try? keyPort(), let enc = unb64(wrap.enc, 32), let ct = unb64(wrap.ct),
            wrap.kid == ring.rootKid, wrap.epoch == ring.epoch, Self.kemOK(wrap.kem),
            let mine = try await keys.publicKeys(), let agree = unb64(mine.agreeKey, 32)
        else { return .locked(reason: .unusableWrap) }
        let root = try await SyncHPKE.unwrapRoot(
            recipientPublicKey: agree, dh: { try await keys.dh($0) },
            context: await wrapContext(ring.ringId, ring.epoch), kid: kid,
            wrap: SyncHPKE.Wrap(kem: SyncHPKE.kemX25519, enc: enc, ct: ct))
        guard let root, same(SyncCrypto.deriveKid(root: root), kid) else { return .locked(reason: .unusableWrap) }
        try await hold(HeldRoot(ringId: ring.ringId, epoch: ring.epoch, kid: kid, root: root), store: true, gen: gen)
        return .unlocked(ringId: ring.ringId, epoch: ring.epoch)
    }

    private static func kemOK(_ k: JSONValue) -> Bool {
        k == .string("x25519") || k == .int(SyncHPKE.kemX25519)
    }

    // ── Writes ───────────────────────────────────────────────────────────────────────────

    /// Makes the ring: a fresh root, a wrap to this device, and (by default) a recovery blob. The
    /// root is held on success. `keyring_conflict` (a ring exists) leaves nothing held: `unlock()`.
    public func create(recovery: Bool = true) async throws -> SyncCreatedRing {
        try await makeRing("devices/keyring", withRecovery: recovery)
    }

    /// Starts over: a new ring and root, optionally a new recovery code. The server keeps the old
    /// ring as `previous` for 30 days; a root this device held is kept in memory for `adopt`.
    public func reset(recovery: Bool = true) async throws -> SyncCreatedRing {
        try await makeRing("devices/keyring/reset", withRecovery: recovery)
    }

    /// Wraps the root to another device of the same person (`PUT .../wraps/{deviceId}`).
    /// `agreeKey` is that device's X25519 key, from the nearby approval (R-9).
    public func wrapTo(deviceId: String, agreeKey: Data) async throws {
        let h = try need()
        guard Self.deviceIdOK(deviceId) else { throw Self.badArg("A device id is required.") }
        guard agreeKey.count == 32 else { throw Self.badArg("The agreement key must be 32 bytes.") }
        let w = try SyncHPKE.wrapRoot(
            recipientPublicKey: agreeKey, context: await wrapContext(h.ringId, h.epoch, deviceId), kid: h.kid,
            root: h.root)
        var body: [String: Any] = ["epoch": h.epoch, "kid": hexOf(h.kid)]
        body.merge(Self.wireWrap(w)) { a, _ in a }
        try await send("PUT", "devices/keyring/wraps/\(Self.segment(deviceId))", body)
    }

    /// `wrapTo` with the key as base64url text, as a nearby approval carries it.
    public func wrapTo(deviceId: String, agreeKey: String) async throws {
        guard let k = unb64(agreeKey, 32) else { throw Self.badArg("The agreement key must be 32 bytes.") }
        try await wrapTo(deviceId: deviceId, agreeKey: k)
    }

    /// `DELETE .../wraps/{deviceId}`: the Worker removes a device's own wrap only.
    public func removeWrap(deviceId: String) async throws {
        guard Self.deviceIdOK(deviceId) else { throw Self.badArg("A device id is required.") }
        try await send("DELETE", "devices/keyring/wraps/\(Self.segment(deviceId))")
    }

    /// Makes a new recovery code, seals the root under it and stores the blob. The previous code
    /// stops working. Returns the code to show the person; it is kept nowhere.
    public func setRecoveryCode() async throws -> String {
        let h = try need()
        let code = SyncRecovery.newCode()
        let blob = try SyncRecovery.wrap(code: code, ringId: h.ringId, epoch: h.epoch, kid: h.kid, root: h.root)
        try await send(
            "PUT", "devices/keyring/recovery",
            ["ct": Base64URL.encode(blob), "epoch": h.epoch, "kid": hexOf(h.kid)])
        return try SyncRecovery.encode(code: code)
    }

    /// `GET .../recovery`: the sealed blob (5 reads a day per device; the account is emailed).
    public func recoveryBlob() async throws -> SyncRecoveryBlob {
        let res = try await request("GET", "devices/keyring/recovery")
        guard let v = Self.object(res.body), let ct = v["ct"]?.stringValue, let epoch = v["epoch"]?.intValue,
            let kid = v["kid"]?.stringValue
        else { throw Self.badResponse("The recovery answer is not in the contract shape.") }
        return SyncRecoveryBlob(ct: ct, epoch: epoch, kid: kid)
    }

    /// Recovers the root from the typed or pasted recovery code. The code is checked before any
    /// request; a bad checksum or a failed unwrap is `recovery-code-invalid`. On success the root
    /// is held and pinned, and this device deposits its own wrap so the next start unlocks
    /// without the code.
    public func recover(_ codeText: String) async throws -> SyncRecovered {
        let invalid = PolarisError(
            code: ErrorCode.recoveryCodeInvalid, message: "The recovery code is not valid for this key ring.")
        let gen = forgetGeneration
        guard let code = SyncRecovery.parse(codeText) else { throw invalid }
        guard let ring = try await read().ring, ring.recoverySet else {
            throw PolarisError(code: ErrorCode.notFound, message: "There is no recovery code for this key ring.")
        }
        guard let kid = unhex(ring.rootKid) else { throw Self.badResponse("Bad ring kid.") }
        let blob = try await recoveryBlob()
        guard blob.epoch == ring.epoch, blob.kid == ring.rootKid else {
            throw Self.badResponse("The recovery blob does not belong to the current ring.")
        }
        guard let bytes = unb64(blob.ct) else { throw invalid }
        guard
            let root = SyncRecovery.unwrap(code: code, ringId: ring.ringId, epoch: ring.epoch, kid: kid, blob: bytes),
            same(SyncCrypto.deriveKid(root: root), kid)
        else { throw invalid }
        try await hold(HeldRoot(ringId: ring.ringId, epoch: ring.epoch, kid: kid, root: root), store: true, gen: gen)
        return SyncRecovered(ringId: ring.ringId, epoch: ring.epoch, wrapDeposited: await depositOwnWrap())
    }

    /// Adopts an earlier or merged root under the current one (`POST .../adopt`): the id of a ring
    /// whose root this client holds (kept by `reset()` or `openAdopted()`). The root is sealed
    /// under `K_adopt` of the current root.
    public func adopt(ringId: String) async throws {
        _ = try need()
        guard let old = memory.others.first(where: { $0.ringId == ringId }) else {
            throw Self.badArg("No root is held for that ring.")
        }
        try await adopt(old)
    }

    /// Adopts a root the host has: `{ringId, epoch, root}`.
    public func adopt(ringId: String, epoch: Int, root: Data) async throws {
        _ = try need()
        guard isRingId(ringId), root.count == SyncCrypto.rootBytes else {
            throw Self.badArg("No root is held for that ring.")
        }
        try await adopt(HeldRoot(ringId: ringId, epoch: epoch, kid: SyncCrypto.deriveKid(root: root), root: root))
    }

    private func adopt(_ old: HeldRoot) async throws {
        let h = try need()
        guard isRingId(old.ringId), old.epoch >= 1 else { throw Self.badArg("No root is held for that ring.") }
        let from = SyncRecovery.AdoptFrom(fromRingId: old.ringId, epoch: old.epoch, kid: old.kid)
        let blob = try SyncRecovery.sealAdopt(currentRoot: h.root, from: from, oldRoot: old.root)
        try await send(
            "POST", "devices/keyring/adopt",
            [
                "fromRingId": old.ringId, "epoch": old.epoch, "kid": hexOf(old.kid),
                "ct": Base64URL.encode(blob),
            ])
    }

    /// Opens the ring's `adopted` candidates with the current root and keeps the roots they hold,
    /// so `codec.open` reads data sealed under them. Returns the ring ids it opened; a candidate
    /// that does not open (or names a different `kid`) is skipped.
    public func openAdopted() async throws -> [String] {
        let h = try need()
        let gen = forgetGeneration
        let current: SyncKeyringRing?
        if let r = ring { current = r } else { current = try await read().ring }
        guard gen == forgetGeneration else { throw CancellationError() }
        var opened: [String] = []
        for a in current?.adopted ?? [] {
            guard let kid = unhex(a.kid), let ct = unb64(a.ct) else { continue }
            guard
                let root = SyncRecovery.openAdopt(
                    currentRoot: h.root, from: SyncRecovery.AdoptFrom(fromRingId: a.ringId, epoch: a.epoch, kid: kid),
                    blob: ct),
                same(SyncCrypto.deriveKid(root: root), kid)
            else { continue }
            memory.addOther(HeldRoot(ringId: a.ringId, epoch: a.epoch, kid: kid, root: root))
            opened.append(a.ringId)
        }
        return opened
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────

    private func need() throws -> HeldRoot {
        guard let h = memory.held else { throw Self.lockedError() }
        return h
    }

    /// Takes a freshly acquired root: pinned first (no root is held without a pin), then kept in
    /// the Keychain and the backup (a failure there leaves the root in memory only), then held.
    private func hold(_ h: HeldRoot, store: Bool, gen: Int) async throws {
        // N-2: the ring was forgotten (sign-out) since this acquisition began: nothing is kept.
        guard gen == forgetGeneration else { throw CancellationError() }
        let pinned = SyncRingPin(ringId: h.ringId, epoch: h.epoch, rootKid: hexOf(h.kid))
        if await pin() != pinned { try await writePin(pinned) }
        if gen != forgetGeneration {
            // Forgotten while the pin was written: take the pin back as well.
            memoryPin = nil
            try? await core.store.writeRecordChecked(Self.pinRecord, nil)
            throw CancellationError()
        }
        if store {
            try? roots().save(
                StoredRingRoot(ringId: h.ringId, epoch: h.epoch, kid: hexOf(h.kid), root: Base64URL.encode(h.root)))
        }
        backUp(h)
        var others = memory.others
        if let old = memory.held, old.ringId != h.ringId || old.epoch != h.epoch { others.append(old) }
        memory.set(held: h, others: others)
    }

    /// The Keychain root, when it is for `ring` and still derives its own `kid`.
    private func storedRoot(matching ring: SyncRingPin) -> HeldRoot? {
        guard let s = (try? roots().load()) ?? nil else { return nil }
        return heldRoot(from: s, matching: ring)
    }

    private func heldRoot(from s: StoredRingRoot, matching ring: SyncRingPin) -> HeldRoot? {
        guard s.ringId == ring.ringId, s.epoch == ring.epoch,
            s.kid == ring.rootKid, let root = unb64(s.root, SyncCrypto.rootBytes), let kid = unhex(s.kid),
            same(SyncCrypto.deriveKid(root: root), kid)
        else { return nil }
        return HeldRoot(ringId: s.ringId, epoch: s.epoch, kid: kid, root: root)
    }

    /// A restart: the stored root comes back only while it is the pinned ring's.
    private func restoreStored() async {
        guard memory.held == nil, let p = await pin(), let h = storedRoot(matching: p) else { return }
        memory.set(held: h)
    }

    private func wrapContext(_ ringId: String, _ epoch: Int, _ deviceId: String? = nil) async
        -> SyncHPKE.WrapContext
    {
        let id: String
        if let deviceId { id = deviceId } else { id = await core.deviceId }
        return SyncHPKE.WrapContext(product: core.product, deviceId: id, ringId: ringId, epoch: epoch)
    }

    private func agreeKey() async throws -> Data {
        let keys: any DeviceKeyPort
        do { keys = try keyPort() } catch {
            throw PolarisError(
                code: ErrorCode.deviceKeysRequired,
                message: "Device keys are needed for the key ring; give the client a DeviceKeyPort.")
        }
        guard let pub = unb64(try await keys.ensure().agreeKey, 32) else {
            throw PolarisError(code: ErrorCode.deviceKeysInvalid, message: "The device agreement key is not usable.")
        }
        return pub
    }

    private func makeRing(_ path: String, withRecovery: Bool) async throws -> SyncCreatedRing {
        let gen = forgetGeneration
        let agree = try await agreeKey()
        let root = SyncCrypto.random(SyncCrypto.rootBytes)
        let kid = SyncCrypto.deriveKid(root: root)
        let ringId = "rg_" + Base64URL.encode(SyncCrypto.random(16))
        let epoch = 1
        let wrap = try SyncHPKE.wrapRoot(
            recipientPublicKey: agree, context: await wrapContext(ringId, epoch), kid: kid, root: root)
        var body: [String: Any] = ["ringId": ringId, "rootKid": hexOf(kid), "wrap": Self.wireWrap(wrap)]
        var shown: String?
        if withRecovery {
            let code = SyncRecovery.newCode()
            let blob = try SyncRecovery.wrap(code: code, ringId: ringId, epoch: epoch, kid: kid, root: root)
            body["recovery"] = ["ct": Base64URL.encode(blob)]
            shown = try SyncRecovery.encode(code: code)
        }
        let before = await knownRingIds()
        try await send("POST", path, body)
        // Start over: the old ring's backup item goes (the server keeps `previous` for 30 days, and
        // this client keeps the old root in memory for `adopt`). A create has no old ring to remove.
        if path != "devices/keyring", let t = backupTarget() {
            for old in before where old != ringId { try? t.port.remove(subject: t.subject, ringId: old) }
        }
        try await hold(HeldRoot(ringId: ringId, epoch: epoch, kid: kid, root: root), store: true, gen: gen)
        ring = nil
        return SyncCreatedRing(ringId: ringId, epoch: epoch, rootKid: hexOf(kid), recoveryCode: shown)
    }

    /// After a recovery: stores this device's own wrap. Never throws; false when it could not.
    private func depositOwnWrap() async -> Bool {
        do {
            try await wrapTo(deviceId: await core.deviceId, agreeKey: try await agreeKey())
            return true
        } catch { return false }
    }

    private static func deviceIdOK(_ id: String) -> Bool {
        !id.isEmpty && !id.contains(where: { $0 == "/" || $0 == "?" || $0 == "#" || $0.isWhitespace })
    }

    private static func segment(_ s: String) -> String {
        s.addingPercentEncoding(
            withAllowedCharacters: CharacterSet(
                charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"))
            ?? s
    }

    private static func wireWrap(_ w: SyncHPKE.Wrap) -> [String: Any] {
        ["kem": SyncHPKE.kemX25519, "enc": Base64URL.encode(w.enc), "ct": Base64URL.encode(w.ct)]
    }

    // ── Requests ─────────────────────────────────────────────────────────────────────────

    private func request(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws
        -> PolarisResponse
    {
        guard let token = await core.token else {
            throw PolarisError(
                code: ErrorCode.noToken, message: "Activate, register or sign in before using the key ring.")
        }
        var headers = ["authorization": "Bearer \(token)"]
        var data: Data?
        if let body {
            headers["content-type"] = "application/json"
            data = try JSONSerialization.data(withJSONObject: body)
        }
        let res = try await core.request(core.endpoints.url(path), method: method, headers: headers, body: data)
        guard res.isOK else { throw Self.refusal(res) }
        return res
    }

    private func send(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws {
        _ = try await request(method, path, body)
    }

    private static func refusal(_ res: PolarisResponse) -> PolarisError {
        // The Worker answers `{"error": {"code", "message"}}`, or `{"error": "<code>"}` for a bare 404.
        if let o = object(res.body) {
            if case .object(let e)? = o["error"], let code = e["code"]?.stringValue {
                return PolarisError(
                    code: code, message: e["message"]?.stringValue ?? "The server answered \(res.status).",
                    status: res.status)
            }
            if let code = o["error"]?.stringValue {
                return PolarisError(code: code, message: "The server answered \(res.status).", status: res.status)
            }
        }
        return PolarisError(
            code: ErrorCode.invalidResponse, message: "The server answered \(res.status).", status: res.status)
    }

    private static func object(_ data: Data) -> [String: JSONValue]? {
        (try? JSONDecoder().decode(JSONValue.self, from: data))?.objectValue
    }

    private static func parseState(_ data: Data) -> SyncKeyringState? {
        guard let b = object(data), let r = b["ring"], let w = b["wrap"] else { return nil }
        var ring: SyncKeyringRing?
        if r != .null {
            guard let o = r.objectValue, let ringId = o["ringId"]?.stringValue, let epoch = o["epoch"]?.intValue,
                let rootKid = o["rootKid"]?.stringValue, let state = o["state"]?.stringValue,
                let createdAt = o["createdAt"]?.intValue, let rec = o["recovery"]?.objectValue,
                let set = rec["set"]?.boolValue, let list = o["adopted"]?.arrayValue
            else { return nil }
            var adopted: [SyncKeyringRing.Adopted] = []
            for a in list {
                guard let a = a.objectValue, let id = a["ringId"]?.stringValue, let ep = a["epoch"]?.intValue,
                    let kid = a["kid"]?.stringValue, let ct = a["ct"]?.stringValue
                else { return nil }
                adopted.append(.init(ringId: id, epoch: ep, kid: kid, ct: ct))
            }
            var previous: SyncKeyringRing.Previous?
            if let p = o["previous"], p != .null {
                guard let p = p.objectValue, let id = p["ringId"]?.stringValue, let kid = p["kid"]?.stringValue,
                    let until = p["until"]?.intValue
                else { return nil }
                previous = .init(ringId: id, kid: kid, until: until)
            }
            ring = SyncKeyringRing(
                ringId: ringId, epoch: epoch, rootKid: rootKid, state: state, createdAt: createdAt,
                recoverySet: set, recoveryCreatedAt: rec["createdAt"]?.intValue, adopted: adopted,
                previous: previous)
        }
        var wrap: SyncKeyringWrapInfo?
        if w != .null {
            guard let o = w.objectValue, let epoch = o["epoch"]?.intValue, let kid = o["kid"]?.stringValue,
                let kem = o["kem"], kem.stringValue != nil || kem.intValue != nil,
                let enc = o["enc"]?.stringValue, let ct = o["ct"]?.stringValue
            else { return nil }
            wrap = SyncKeyringWrapInfo(epoch: epoch, kid: kid, kem: kem, enc: enc, ct: ct, by: o["by"]?.stringValue)
        }
        return SyncKeyringState(ring: ring, wrap: wrap)
    }
}

// ── `client.keyring` ─────────────────────────────────────────────────────────────────────

private final class KeyringAttachment {}

extension PolarisKeyClient {
    /// Builds the key ring client with `options` (keys, root store). Throws `invalid-options` when
    /// it was already built: configure before the first `client.keyring` read.
    @discardableResult
    public nonisolated func configureKeyring(_ options: SyncKeyringOptions) throws -> SyncKeyring {
        var options = options
        if options.subject == nil { options.subject = { [identity] in identity.account } }
        let built = SyncKeyring(core: core, options: options)
        return try attachments.with { table in
            if table[ObjectIdentifier(KeyringAttachment.self)] != nil {
                throw PolarisError(
                    code: ErrorCode.invalidOptions,
                    message: "client.keyring is already built; call configureKeyring(_:) before the first read.")
            }
            table[ObjectIdentifier(KeyringAttachment.self)] = built
            return built
        }
    }

    /// The Cloud Sync key ring: `status`, `unlock`, `create`, `reset`, `wrapTo`, `recover`,
    /// `forget`, and the `codec` the E2E machine seals with. Built on first read.
    public nonisolated var keyring: SyncKeyring {
        Self.keyring(core: core, attachments: attachments, subject: { [identity] in identity.account })
    }

    static func keyring(
        core: CoreContext, attachments: LockedValue<[ObjectIdentifier: any Sendable]>,
        subject: (@Sendable () -> String?)? = nil
    ) -> SyncKeyring {
        attachments.with { table in
            let key = ObjectIdentifier(KeyringAttachment.self)
            if let k = table[key] as? SyncKeyring { return k }
            // The client's Keychain access group, so a host sharing one stores the root in it.
            let k = SyncKeyring(
                core: core, options: SyncKeyringOptions(accessGroup: core.keychainAccessGroup, subject: subject))
            table[key] = k
            return k
        }
    }
}
