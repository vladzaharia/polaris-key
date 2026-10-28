// The Cloud Sync host's state file: `<state dir>/cloud-sync.json` (U-07.6). A port of Python's
// `cloud_sync/state.py`. It holds the machine's journal, the catalog last served by `/config/schema`
// (so a relaunch routes settings before the first fetch) and the names of the person's open settings
// (so a blinded tombstone can be mapped back).
//
// The file holds the WHOLE opened snapshot of the signed-in person's settings, not only the pending
// edits. Whoever signs out or loses the account must remove it; until then it is as sensitive as the
// settings themselves. The root is never written: the key ring keeps it.
//
// H-6: the file is created owner-only (0600), exclusively and without following a link (a planted
// symlink or file is refused), written whole, fsynced and renamed into place. It is kept out of
// backups (`isExcludedFromBackup`) and, on iOS-family systems, readable only after the first unlock
// (`completeUntilFirstUserAuthentication`).

import Foundation
import PolarisKeyCore

public let cloudSyncFileName = "cloud-sync.json"
/// Open-setting names kept for tombstone mapping; past this the oldest are dropped (H-5).
public let cloudSyncOpenKeysMax = 4096

/// What the file holds.
public struct CloudSyncFile: Sendable, Equatable {
    public var persisted: SyncMachineState?
    public var catalog: JSONValue?
    public var openKeys: [String]

    public init(persisted: SyncMachineState? = nil, catalog: JSONValue? = nil, openKeys: [String] = []) {
        self.persisted = persisted
        self.catalog = catalog
        self.openKeys = openKeys
    }
}

/// The catalog's outer shape; the host derives routes from it with `syncedSettings`.
public func isCatalogShape(_ v: JSONValue?) -> Bool {
    guard case .object(let o)? = v, syncIsNumber(o["schemaVersion"]), case .array? = o["entries"] else { return false }
    return true
}

public final class CloudSyncStateFile: @unchecked Sendable {
    public let url: URL
    private let product: String
    /// Writes and removals are serialised, so a slow one never lands after a newer one.
    private let lock = NSLock()

    public init(stateDir: URL, product: String) {
        self.url = stateDir.appendingPathComponent(cloudSyncFileName)
        self.product = product
    }

    /// Delete the file (after any write in progress), and any leftover `*.tmp` beside it. Throws if
    /// the file stays.
    public func remove() throws {
        try lock.withLock {
            do { try FileManager.default.removeItem(at: url) } catch let e as CocoaError where e.code == .fileNoSuchFile {}
            sweepTemporaries()
        }
    }

    /// The saved file, or an empty one when it is missing, corrupt or another product's.
    public func load() -> CloudSyncFile {
        guard let data = try? Data(contentsOf: url), data.count <= 64 * 1024 * 1024,
            case .object(let raw)? = try? JSONDecoder().decode(JSONValue.self, from: data),
            raw["v"] == .int(1), raw["product"] == .string(product)
        else { return CloudSyncFile() }
        let keys = raw["openKeys"]?.arrayValue?.compactMap(\.stringValue) ?? []
        return CloudSyncFile(
            persisted: raw["persisted"].flatMap { SyncMachineState(fileJSON: $0) },
            catalog: isCatalogShape(raw["catalog"]) ? raw["catalog"] : nil,
            openKeys: Array(keys.suffix(cloudSyncOpenKeysMax)))
    }

    public func save(_ file: CloudSyncFile) throws {
        var o: [String: JSONValue] = [
            "v": .int(1), "product": .string(product), "openKeys": .array(file.openKeys.map { .string($0) }),
        ]
        o["persisted"] = file.persisted.map { $0.fileJSON } ?? .null
        o["catalog"] = file.catalog ?? .null
        let data = try JSONEncoder().encode(JSONValue.object(o))
        try lock.withLock { try writeAtomic(data) }
    }

    // MARK: files

    private func writeAtomic(_ data: Data) throws {
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let tmp = dir.appendingPathComponent(
            "\(cloudSyncFileName).\(SyncCrypto.random(12).map { String(format: "%02x", $0) }.joined()).tmp")
        // O_EXCL and O_NOFOLLOW: a planted file or symlink is refused, never written through.
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
        var done = false
        defer {
            if !done { unlink(tmp.path) }
        }
        do {
            var offset = 0
            try data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
                while offset < buf.count {
                    let n = write(fd, buf.baseAddress! + offset, buf.count - offset)
                    if n < 0 { if errno == EINTR { continue }; throw CocoaError(.fileWriteUnknown) }
                    offset += n
                }
            }
            guard fsync(fd) == 0 else { throw CocoaError(.fileWriteUnknown) }
        } catch {
            close(fd)
            throw error
        }
        close(fd)
        var kept = tmp
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? kept.setResourceValues(values)
        #if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: tmp.path)
        #endif
        guard rename(tmp.path, url.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
        done = true
        let dfd = open(dir.path, O_RDONLY)  // best effort: make the rename itself durable
        if dfd >= 0 {
            fsync(dfd)
            close(dfd)
        }
    }

    private func sweepTemporaries() {
        let dir = url.deletingLastPathComponent()
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        for n in names where n.hasPrefix("\(cloudSyncFileName).") && n.hasSuffix(".tmp") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(n))
        }
    }
}

// MARK: - The journal's file form

extension SyncMachineState {
    /// The file's form of the machine's journal.
    var fileJSON: JSONValue {
        var parts: [String: JSONValue] = [:]
        for (name, p) in partitions { parts[name] = p.fileJSON }
        var o: [String: JSONValue] = [
            "partitions": .object(parts), "hlc": .array([.int(hlc.physical), .int(hlc.counter)]),
            "offsetMs": .int(offsetMs), "contacted": .bool(contacted),
            "aliases": .object(aliases.mapValues { .string($0) }), "deviceLocal": .object(deviceLocal),
            "imported": .bool(imported), "e2eSeen": .bool(e2eSeen),
        ]
        if let subject { o["subject"] = .string(subject) }
        if let blocked { o["blocked"] = .string(blocked.rawValue) }
        return .object(o)
    }

    /// Reads the file's form; nil for anything malformed (the host then starts empty).
    init?(fileJSON v: JSONValue) {
        guard case .object(let o) = v, case .object(let ps)? = o["partitions"],
            case .array(let h)? = o["hlc"], h.count == 2, case .int(let hp) = h[0], case .int(let hc) = h[1],
            case .int(let off)? = o["offsetMs"], case .bool(let contacted)? = o["contacted"]
        else { return nil }
        var parts: [String: SyncPartition] = [:]
        for (name, p) in ps {
            guard let part = SyncPartition(fileJSON: p) else { return nil }
            parts[name] = part
        }
        var aliases: [String: String] = [:]
        for (k, a) in o["aliases"]?.objectValue ?? [:] {
            guard case .string(let s) = a else { return nil }
            aliases[k] = s
        }
        var blocked: SyncBlockReason?
        if let b = o["blocked"] {
            guard case .string(let s) = b, let r = SyncBlockReason(rawValue: s) else { return nil }
            blocked = r
        }
        self.init(
            subject: o["subject"]?.stringValue, partitions: parts, hlc: (hp, hc), offsetMs: off,
            contacted: contacted, aliases: aliases, blocked: blocked,
            deviceLocal: o["deviceLocal"]?.objectValue ?? [:], imported: o["imported"]?.boolValue ?? false,
            e2eSeen: o["e2eSeen"]?.boolValue ?? false)
    }
}

extension SyncPartition {
    var fileJSON: JSONValue {
        var o: [String: JSONValue] = [
            "nextMutationId": .int(nextMutationId), "cursor": .int(cursor),
            "pending": .array(pending.map(\.journalJSON)), "held": .object(held),
            "settings": .object(settings.mapValues(\.fileJSON)), "records": .object(records.mapValues(\.fileJSON)),
            "device": .object(device.mapValues(\.fileJSON)), "sealedKeys": .array(sealedKeys.map { .string($0) }),
        ]
        if let clientId { o["clientId"] = .string(clientId) }
        if let signedOutAt { o["signedOutAt"] = .int(signedOutAt) }
        if let encryptionSince { o["encryptionSince"] = .int(encryptionSince) }
        if let sealedFloor { o["sealedFloor"] = .int(sealedFloor) }
        if let headroom { o["headroom"] = .double(headroom) }
        return .object(o)
    }

    init?(fileJSON v: JSONValue) {
        guard case .object(let o) = v, case .int(let next)? = o["nextMutationId"], case .int(let cursor)? = o["cursor"],
            case .array(let pend)? = o["pending"]
        else { return nil }
        self.init(clientId: o["clientId"]?.stringValue)
        nextMutationId = next
        self.cursor = cursor
        for p in pend {
            guard let op = SyncOp(journal: p) else { return nil }
            pending.append(op)
        }
        held = o["held"]?.objectValue ?? [:]
        for (k, r) in o["settings"]?.objectValue ?? [:] {
            guard let row = SyncRow(fileJSON: r) else { return nil }
            settings[k] = row
        }
        for (k, r) in o["records"]?.objectValue ?? [:] {
            guard let row = SyncRow(fileJSON: r) else { return nil }
            records[k] = row
        }
        for (k, d) in o["device"]?.objectValue ?? [:] {
            guard let s = SyncDeviceSetting(fileJSON: d) else { return nil }
            device[k] = s
        }
        signedOutAt = o["signedOutAt"]?.intValue
        encryptionSince = o["encryptionSince"]?.intValue
        sealedKeys = o["sealedKeys"]?.arrayValue?.compactMap(\.stringValue) ?? []
        sealedFloor = o["sealedFloor"]?.intValue
        headroom = syncNumber(o["headroom"])
    }
}

extension SyncRow {
    var fileJSON: JSONValue {
        var o: [String: JSONValue] = ["value": value, "version": .int(version)]
        if bad { o["bad"] = .bool(true) }
        if let plain { o["plain"] = .int(plain) }
        return .object(o)
    }

    init?(fileJSON v: JSONValue) {
        guard case .object(let o) = v, let value = o["value"], case .int(let version)? = o["version"] else { return nil }
        self.init(value: value, version: version, bad: o["bad"]?.boolValue ?? false, plain: o["plain"]?.intValue)
    }
}

extension SyncDeviceSetting {
    var fileJSON: JSONValue {
        var o: [String: JSONValue] = ["editedHlc": .string(editedHlc)]
        if cleared { o["cleared"] = .bool(true) } else if let value { o["value"] = value }
        if preContact { o["preContact"] = .bool(true) }
        return .object(o)
    }

    init?(fileJSON v: JSONValue) {
        guard case .object(let o) = v, case .string(let hlc)? = o["editedHlc"] else { return nil }
        self.init(
            value: o["value"], cleared: o["cleared"]?.boolValue ?? false, editedHlc: hlc,
            preContact: o["preContact"]?.boolValue ?? false)
    }
}

extension SyncOp {
    /// Reads `journalJSON`'s form; nil for anything malformed.
    init?(journal v: JSONValue) {
        guard case .object(let o) = v, case .int(let id)? = o["mutationId"], case .object(let t)? = o["target"],
            case .string(let opName)? = o["op"], let op = SyncOpName(rawValue: opName)
        else { return nil }
        let target: SyncTarget
        if case .string(let key)? = t["setting"], case .string(let sc)? = t["scope"], let scope = SyncScope(rawValue: sc) {
            target = .setting(key, scope)
        } else if case .array(let r)? = t["record"], r.count == 2, case .string(let c) = r[0], case .string(let i) = r[1] {
            target = .record(c, i)
        } else {
            return nil
        }
        var base: Int?
        var any = false
        switch o["baseVersion"] {
        case .int(let b)?: base = b
        case .string("*")?: any = true
        case nil: break
        default: return nil
        }
        var parked: SyncParkReason?
        if let p = o["parked"] {
            guard case .string(let s) = p, let r = SyncParkReason(rawValue: s) else { return nil }
            parked = r
        }
        self.init(
            mutationId: id, target: target, op: op, value: o["value"], member: o["member"]?.stringValue,
            element: o["element"], observedSeq: o["observedSeq"]?.intValue, editedHlc: o["editedHlc"]?.stringValue,
            baseVersion: base, baseAny: any, preContact: o["preContact"]?.boolValue ?? false,
            moved: o["moved"]?.boolValue ?? false, parked: parked)
    }
}
