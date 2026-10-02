// In-memory pack storage and state store (client-core `packs/memory.ts`): the `PackStorage` and
// `PackStateStore` a test, a corpus harness or a host without persistent storage runs the engine
// over. Nothing survives the process.

import Foundation
import PolarisKeyCore

/// One stored payload: a container's bytes or a tree's files, and the index kept with it.
public struct MemoryPayload: Sendable {
    public var layout: String
    public var payload: [UInt8]?
    public var tree: [String: [UInt8]]?
    public var index: FilesIndexDoc?

    public init(layout: String, payload: [UInt8]?, tree: [String: [UInt8]]?, index: FilesIndexDoc?) {
        self.layout = layout
        self.payload = payload
        self.tree = tree
        self.index = index
    }
}

private final class MemoryBox: @unchecked Sendable {
    let lock = NSLock()
    var store: [String: MemoryPayload] = [:]
    var staging: [String: [String: [UInt8]]] = [:]
    var outputs: [String: (container: [UInt8], length: Int, tree: [String: [UInt8]])] = [:]
    func with<R>(_ body: (MemoryBox) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try body(self)
    }
}

private struct MemoryStaged: StagedObject {
    let box: MemoryBox
    let planId: String
    let sha256: String
    func size() throws -> Int { box.with { $0.staging[planId]?[sha256]?.count ?? 0 } }
    func source() throws -> any ByteSource { MemorySource(box.with { $0.staging[planId]?[sha256] ?? [] }) }
    func append(_ bytes: [UInt8]) throws {
        box.with { $0.staging[planId, default: [:]][sha256, default: []] += bytes }
    }
    func reset() throws { box.with { _ = $0.staging[planId]?.removeValue(forKey: sha256) } }
}

private struct MemorySink: ByteSink {
    let box: MemoryBox
    let planId: String
    func write(_ offset: Int, _ bytes: [UInt8]) throws {
        box.with { b in
            var o = b.outputs[planId] ?? ([], 0, [:])
            if o.container.count < offset + bytes.count {
                o.container += [UInt8](repeating: 0, count: offset + bytes.count - o.container.count)
            }
            o.container.replaceSubrange(offset..<(offset + bytes.count), with: bytes)
            o.length = Swift.max(o.length, offset + bytes.count)
            b.outputs[planId] = o
        }
    }
}

private struct MemoryTree: TreeSink {
    let box: MemoryBox
    let planId: String
    func writeFile(_ path: String, _ bytes: [UInt8]) throws {
        box.with { b in
            var o = b.outputs[planId] ?? ([], 0, [:])
            o.tree[path] = bytes
            b.outputs[planId] = o
        }
    }
}

/// `PackStorage` over maps. `freeDisk` is what the planner is told (default 1 GiB).
public final class MemoryPackStorage: PackStorage, @unchecked Sendable {
    private let box = MemoryBox()
    public let freeDiskBytes: Int

    public init(freeDisk: Int = 1 << 30) { self.freeDiskBytes = freeDisk }

    /// The stored payloads by location (`<packId>/<payloadSha256>`).
    public var store: [String: MemoryPayload] {
        get { box.with { $0.store } }
        set { box.with { $0.store = newValue } }
    }
    /// The staged objects by plan id, then SHA-256.
    public var staging: [String: [String: [UInt8]]] {
        get { box.with { $0.staging } }
        set { box.with { $0.staging = newValue } }
    }

    public func stagedObject(_ planId: String, _ sha256: String) throws -> any StagedObject {
        MemoryStaged(box: box, planId: planId, sha256: sha256)
    }

    public func output(_ planId: String, _ layout: String) throws -> PackOutput {
        box.with { $0.outputs[planId] = ([], 0, [:]) }
        return PackOutput(sink: MemorySink(box: box, planId: planId), tree: MemoryTree(box: box, planId: planId))
    }

    public func commit(
        _ planId: String, _ packId: String, _ payloadSha256: String, _ layout: String,
        _ index: FilesIndexDoc?
    ) throws -> String {
        try box.with { b in
            guard let o = b.outputs[planId] else { throw PackPortError.unsupported }
            let location = "\(packId)/\(payloadSha256)"
            b.store[location] =
                layout == "tree"
                ? MemoryPayload(layout: layout, payload: nil, tree: o.tree, index: index)
                : MemoryPayload(layout: layout, payload: Array(o.container[0..<o.length]), tree: nil, index: index)
            b.outputs[planId] = nil
            return location
        }
    }

    public func installed(_ install: PackInstall) throws -> InstalledPayload? {
        guard let p = box.with({ $0.store[install.location] }) else { return nil }
        if p.layout == "tree" {
            let files = (p.tree ?? [:]).map { path, bytes in
                InstalledFile(path: path, sha256: sha256Of(bytes), size: bytes.count, source: MemorySource(bytes))
            }
            return InstalledPayload(payload: nil, files: files)
        }
        let whole = MemorySource(p.payload ?? [])
        return InstalledPayload(
            payload: whole,
            files: p.index?.files.map {
                InstalledFile(
                    path: $0.path, sha256: $0.sha256, size: $0.size,
                    source: sliceSource(whole, $0.offset ?? 0, $0.size))
            })
    }

    public func verify(_ install: PackInstall) throws -> Bool {
        guard let p = box.with({ $0.store[install.location] }) else { return false }
        if p.layout == "tree" {
            let files = (p.tree ?? [:]).map { TreeFile(path: $0.key, size: $0.value.count, sha256: sha256Of($0.value)) }
            return treeDigest(files) == install.payloadSha256
        }
        return sha256Of(p.payload ?? []) == install.payloadSha256
    }

    public func remove(_ location: String) throws { box.with { _ = $0.store.removeValue(forKey: location) } }

    public func removeStaging(_ planId: String) throws {
        box.with {
            $0.staging[planId] = nil
            $0.outputs[planId] = nil
        }
    }

    public func list() throws -> (locations: [String], plans: [String]) {
        box.with { (Array($0.store.keys), Array($0.staging.keys)) }
    }

    public func freeDisk() throws -> Int { freeDiskBytes }
}

public func memoryPackStorage(freeDisk: Int = 1 << 30) -> MemoryPackStorage {
    MemoryPackStorage(freeDisk: freeDisk)
}

/// A `PackStateStore` over one string, with its quarantine in `torn` and its hold list.
public final class MemoryPackStateStore: PackStateStore, @unchecked Sendable {
    private let lock = NSLock()
    private var _text: String?
    private var _torn: String?
    private var _holdList: String?

    public init(_ initial: String? = nil) { _text = initial }

    private func locked<R>(_ body: () throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    public var text: String? {
        get { locked { _text } }
        set { locked { _text = newValue } }
    }
    public var torn: String? {
        get { locked { _torn } }
        set { locked { _torn = newValue } }
    }
    public var holdList: String? {
        get { locked { _holdList } }
        set { locked { _holdList = newValue } }
    }

    public func read() throws -> String? { text }
    public func replace(_ text: String) throws { self.text = text }
    public func quarantine(_ text: String) throws { locked { if _torn == nil { _torn = text } } }
    public func quarantined() throws -> Bool { torn != nil }
    public func clearQuarantine() throws {
        locked {
            _torn = nil
            _holdList = nil
        }
    }
    public var keepsHoldList: Bool { true }
    public func readHoldList() throws -> String? { holdList }
    public func writeHoldList(_ text: String) throws { locked { if _holdList == nil { _holdList = text } } }
}

public func memoryPackStateStore(_ initial: String? = nil) -> MemoryPackStateStore {
    MemoryPackStateStore(initial)
}
