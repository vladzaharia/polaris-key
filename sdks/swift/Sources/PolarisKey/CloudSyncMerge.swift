// MergeRequest: the one conflict a person or an app is asked to settle (plans/U-08.md section 2.2 to 2.5;
// WIRE-CONTRACT-V5 section 11.5). `revision` is the only policy that asks; without an answer the device keeps
// its copy unsent and the cloud keeps the other, so nothing is lost. A port of client-core's `sync/merge.ts`.
//
// Two sources feed one registry: the machine's record requests (`w:<collection>/<record>`, journalled by the
// machine and pushed here by the host after every turn) and the saves layer's requests (`w:saves/<id>`,
// memory only: S5). A request is a live object: its members read the current state, so an app that holds one
// sees it reopen after a failed keep. `keep` never throws; a refusal is `.failed`.
//
// The registry takes no value, key or path into an event or a log line (H-11).

import Foundation
import PolarisKeyCore

/// What `request.keep` takes: `.local`, `.remote`, `.both` (saves, while a slot is free) or `.value(_)` (records).
public typealias MergeKeep = SyncMergeKeep

/// A request's file side (saves): the stored size and how it is sent.
public struct MergeFile: Sendable, Equatable {
    public let size: Int
    public let format: SyncFilePointer.Format

    public init(size: Int, format: SyncFilePointer.Format) {
        self.size = size
        self.format = format
    }
}

/// One side of a request.
public struct MergeSide: Sendable, Equatable {
    /// A record's value; a save's metadata (the SAVES-META keys included).
    public let value: JSONValue
    /// Remote: the server's version. Local: the base this copy was written on; nil: it did not exist.
    public let version: Int?
    /// Saves: `metadata.savedAt`. Records: nil.
    public let savedAt: Int?
    /// Saves: `metadata.deviceLabel`. Records: nil.
    public let device: String?
    public let file: MergeFile?

    public init(value: JSONValue, version: Int?, savedAt: Int? = nil, device: String? = nil, file: MergeFile? = nil) {
        self.value = value
        self.version = version
        self.savedAt = savedAt
        self.device = device
        self.file = file
    }

    init(_ s: SyncMergeSide) {
        self.init(
            value: s.value, version: s.version, savedAt: s.savedAt, device: s.device,
            file: s.file.map { MergeFile(size: $0.size, format: $0.format) })
    }
}

/// Why a request is open (plans/U-08.md section 2.2).
public enum MergeRequestCause: String, Sendable, Equatable {
    case write, accountMerge
}

/// The state of a request: `open`, or `applying` while its keep is being answered.
public typealias MergeRequestState = SyncMergeState

/// What `keep` came to.
public enum MergeOutcome: Sendable, Equatable {
    /// Applied. `version` is the record's version after the keep (nil: a keep of the other copy that was deleted
    /// there); `copyId` names the slot a `both` wrote.
    case kept(SyncMergeChoice, version: Int?, copyId: String?)
    /// Refused or failed: `code` is `sync-merge-closed`, `bad_request`, `conflict` or the failure's code.
    /// `reopened` is true when the request is open again for another choice.
    case failed(code: String, reopened: Bool)

    public var isOK: Bool { if case .kept = self { return true } else { return false } }
}

/// The request's members as the registry hands them out.
struct MergeView: Sendable, Equatable {
    var id: String
    var cause: MergeRequestCause
    var collection: String
    var record: String
    var local: MergeSide?
    var remote: MergeSide?
    var choices: [SyncMergeChoice]
    var state: SyncMergeState
    var error: String?
}

/// One open request. Identity is the object: two handles to the same request are equal.
public final class MergeRequest: @unchecked Sendable, Equatable {
    private let box: LockedValue<(view: MergeView, closed: Bool)>
    private weak var registry: MergeRegistry?
    /// The saves layer's answer to a keep; nil for a machine request.
    let backend: (@Sendable (MergeKeep) async -> MergeOutcome)?

    init(
        _ view: MergeView, registry: MergeRegistry, backend: (@Sendable (MergeKeep) async -> MergeOutcome)?
    ) {
        box = LockedValue((view, false))
        self.registry = registry
        self.backend = backend
    }

    var view: MergeView { box.with { $0.view } }
    func setView(_ v: MergeView) { box.with { $0.view = v } }
    var isClosed: Bool { box.with { $0.closed } }
    func markClosed() { box.with { $0.closed = true } }

    /// `w:<collection>/<record>`; stable while the request is open.
    public var id: String { view.id }
    public var cause: MergeRequestCause { view.cause }
    public var collection: String { view.collection }
    /// The plain record id (never sent).
    public var record: String { view.record }
    /// Nil: this account's copy was deleted since (`accountMerge` only).
    public var local: MergeSide? { view.local }
    /// Nil: deleted elsewhere.
    public var remote: MergeSide? { view.remote }
    /// A record offers `local`, `remote` and `value`; a save offers `local`, `remote` and, while a slot of the 16
    /// is free and the other copy exists, `both`.
    public var choices: [SyncMergeChoice] { view.choices }
    public var state: MergeRequestState { view.state }
    /// The last keep's failure code.
    public var error: String? { view.error }

    /// Which copy is newer by `savedAt`; nil unless both carry one and they differ. Display only.
    public var newer: MergeNewer? {
        let v = view
        guard let l = v.local?.savedAt, let r = v.remote?.savedAt, l != r else { return nil }
        return l > r ? .local : .remote
    }

    /// Answer the request. Sends nothing for `.remote` (it reads the server copy); `.local` and `.value` send
    /// one write on the other copy's version; a save's `.both` writes into a free slot. Never throws: a
    /// refusal is `.failed` (`sync-merge-closed` once the request has closed, `bad_request` for a choice it does
    /// not offer or one already applying).
    public func keep(_ choice: MergeKeep) async -> MergeOutcome {
        guard let registry else { return MergeRegistry.closedOutcome }
        return await registry.keepRequest(self, choice)
    }

    public static func == (a: MergeRequest, b: MergeRequest) -> Bool { a === b }
}

/// Which copy is newer.
public enum MergeNewer: String, Sendable, Equatable { case local, remote }

/// A registered listener; `cancel()` removes it.
public final class MergeSubscription: Sendable {
    private let remove: @Sendable () -> Void
    init(_ remove: @escaping @Sendable () -> Void) { self.remove = remove }
    public func cancel() { remove() }
}

/// What the registry tells the client's stream.
enum MergeSignal: Sendable {
    case opened(MergeRequest)
    case closed(id: String, how: SyncMergeHow)
}

/// The machine as the registry reaches it (the host's actor, behind the client's API).
protocol MergeMachinePort: Sendable {
    func keep(_ id: String, _ choice: MergeKeep) async -> CallResult
    /// The machine's open requests; nil while no machine is running.
    func snapshot() async -> [SyncMachineConflict]?
}

/// The open requests of one client, from the machine and from the saves layer.
final class MergeRegistry: @unchecked Sendable {
    typealias Decider = @Sendable (MergeRequest) -> MergeKeep?

    private struct Pending {
        let cont: CheckedContinuation<MergeOutcome, Never>
        /// The machine accepted the keep (the request went `applying`): from then on an `open` request means
        /// the keep failed.
        var armed: Bool
    }

    private struct State {
        var machineReqs: [String: MergeRequest] = [:]
        var extra: [String: MergeRequest] = [:]
        var listeners: [(id: Int, fn: Decider)] = []
        var watchers: [Int: @Sendable (MergeSignal) -> Void] = [:]
        var pending: [String: Pending] = [:]
        var next = 0
        var noticed = false
    }

    private let state = LockedValue(State())
    private let portBox = LockedValue<(any MergeMachinePort)?>(nil)
    private let notice: (@Sendable (MergeRequest) -> Void)?

    init(notice: (@Sendable (MergeRequest) -> Void)? = nil) { self.notice = notice }

    func attach(_ port: any MergeMachinePort) { portBox.set(port) }

    // MARK: listing and listening

    /// The open requests in id order.
    func conflicts() async -> [MergeRequest] {
        await refresh()
        return all()
    }

    /// Register a listener; the requests already open are offered to it. A returned choice decides inline.
    func addListener(_ fn: @escaping Decider) async -> MergeSubscription {
        let id = state.with { s -> Int in
            s.next += 1
            s.listeners.append((s.next, fn))
            return s.next
        }
        await refresh()
        for r in all() where r.state == .open { offer(fn, r) }
        return MergeSubscription { [weak self] in self?.state.with { $0.listeners.removeAll { $0.id == id } } }
    }

    /// The opened and closed signals of every request (the client's `cloudSync` stream).
    @discardableResult
    func watch(_ fn: @escaping @Sendable (MergeSignal) -> Void) -> Int {
        state.with { s in
            s.next += 1
            s.watchers[s.next] = fn
            return s.next
        }
    }

    func unwatch(_ id: Int) { state.with { _ = $0.watchers.removeValue(forKey: id) } }

    private func all() -> [MergeRequest] {
        state.with { s in
            Array(s.machineReqs.values) + Array(s.extra.values)
        }.sorted { syncUTF16Less($0.id, $1.id) }
    }

    // MARK: the machine's requests

    private static func machineView(_ c: SyncMachineConflict) -> MergeView {
        MergeView(
            id: c.id, cause: .write, collection: c.collection, record: c.record, local: MergeSide(c.local),
            remote: c.remote.map(MergeSide.init), choices: c.choices, state: c.state, error: c.error)
    }

    /// Bring the machine's requests in line with its state (a request that vanished is closed, silently).
    func refresh() async {
        guard let port = portBox.current, let snap = await port.snapshot() else { return }
        state.with { apply(snap, &$0) }
    }

    private func apply(_ snapshot: [SyncMachineConflict], _ s: inout State) {
        let live = Dictionary(snapshot.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        for (id, r) in s.machineReqs {
            if let c = live[id] {
                r.setView(Self.machineView(c))
            } else {
                r.markClosed()
                s.machineReqs.removeValue(forKey: id)
            }
        }
        for (id, c) in live where s.machineReqs[id] == nil {
            s.machineReqs[id] = MergeRequest(Self.machineView(c), registry: self, backend: nil)
        }
    }

    private enum Step {
        case announce(MergeRequest)
        case closed(id: String, how: SyncMergeHow)
        case resume(CheckedContinuation<MergeOutcome, Never>, MergeOutcome)
    }

    /// The host calls this after every machine turn, inside the turn: the events just taken, the machine's open
    /// requests now, and the record version of each request id that closed. Listeners and watchers run here, so
    /// they must not call back into the client synchronously.
    func ingest(_ events: [SyncEvent], _ snapshot: [SyncMachineConflict], versions: [String: Int]) {
        var steps: [Step] = []
        state.with { s in
            let live = Dictionary(snapshot.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
            for e in events {
                switch e {
                case .conflict(let id, _, _):
                    guard let c = live[id] else { continue }
                    let view = Self.machineView(c)
                    let r: MergeRequest
                    if let have = s.machineReqs[id] {
                        have.setView(view)
                        r = have
                    } else {
                        r = MergeRequest(view, registry: self, backend: nil)
                        s.machineReqs[id] = r
                    }
                    // A keep of this request conflicted again: it reopens for the person.
                    if let p = s.pending.removeValue(forKey: id) {
                        steps.append(.resume(p.cont, .failed(code: "conflict", reopened: true)))
                    }
                    steps.append(.announce(r))
                case .conflictClosed(let id, let how):
                    if let r = s.machineReqs.removeValue(forKey: id) { r.markClosed() }
                    if let p = s.pending.removeValue(forKey: id) {
                        if how == .superseded {
                            steps.append(.resume(p.cont, Self.closedOutcome))
                        } else if let choice = SyncMergeChoice(rawValue: how.rawValue) {
                            steps.append(.resume(p.cont, .kept(choice, version: versions[id], copyId: nil)))
                        }
                    }
                    steps.append(.closed(id: id, how: how))
                default: break
                }
            }
            // The machine's state is the truth: views follow it, and a request that vanished is closed.
            apply(snapshot, &s)
            for (id, p) in s.pending {
                guard let r = s.machineReqs[id] else {
                    s.pending.removeValue(forKey: id)
                    steps.append(.resume(p.cont, Self.closedOutcome))
                    continue
                }
                let v = r.view
                if v.state == .applying {
                    s.pending[id]?.armed = true
                } else if p.armed {
                    // A keep whose write was refused for good reopens the request with the failure code.
                    s.pending.removeValue(forKey: id)
                    steps.append(.resume(p.cont, .failed(code: v.error ?? "conflict", reopened: true)))
                }
            }
        }
        run(steps)
    }

    private func run(_ steps: [Step]) {
        for step in steps {
            switch step {
            case .announce(let r): announce(r)
            case .closed(let id, let how): emit(.closed(id: id, how: how))
            case .resume(let cont, let outcome): cont.resume(returning: outcome)
            }
        }
    }

    // MARK: the saves layer's requests

    /// An open saves request by id, or nil.
    func find(_ id: String) -> MergeRequest? { state.with { $0.extra[id] } }

    /// Open a request, or reopen the one with that id (its sides and choices replaced). A listener may decide it
    /// inline.
    @discardableResult
    func open(_ view: MergeView, backend: @escaping @Sendable (MergeKeep) async -> MergeOutcome) -> MergeRequest {
        let r = state.with { s -> MergeRequest in
            if let have = s.extra[view.id] {
                have.setView(view)
                return have
            }
            let r = MergeRequest(view, registry: self, backend: backend)
            s.extra[view.id] = r
            return r
        }
        announce(r)
        return r
    }

    /// Replace what an open request shows (a later write replaced the local copy; the state moved).
    func update(_ id: String, _ change: (inout MergeView) -> Void) {
        guard let r = find(id) else { return }
        var v = r.view
        change(&v)
        r.setView(v)
    }

    /// Tell the listeners again that a saves request is open (a keep conflicted again).
    func reannounce(_ id: String) {
        if let r = find(id) { announce(r) }
    }

    /// Close a saves request. No-op when it is not open.
    func close(_ id: String, _ how: SyncMergeHow) {
        guard
            let r = state.with({ s -> MergeRequest? in
                guard let r = s.extra.removeValue(forKey: id) else { return nil }
                return r
            })
        else { return }
        r.markClosed()
        emit(.closed(id: id, how: how))
    }

    /// Close every saves request (the person's data is gone).
    func closeAllExtra() {
        let ids = state.with { Array($0.extra.keys) }.sorted(by: syncUTF16Less)
        for id in ids { close(id, .superseded) }
    }

    // MARK: keep

    static let closedOutcome: MergeOutcome = .failed(code: ErrorCode.syncMergeClosed, reopened: false)
    static let badRequest: MergeOutcome = .failed(code: "bad_request", reopened: false)

    func keepRequest(_ r: MergeRequest, _ choice: MergeKeep) async -> MergeOutcome {
        if r.backend == nil { await refresh() }
        if r.isClosed { return Self.closedOutcome }
        let v = r.view
        if v.state == .applying { return Self.badRequest }
        if !v.choices.contains(choice.choice) { return Self.badRequest }
        if let backend = r.backend { return await backend(choice) }
        return await keepMachine(r, choice)
    }

    private func keepMachine(_ r: MergeRequest, _ choice: MergeKeep) async -> MergeOutcome {
        guard let port = portBox.current else { return Self.closedOutcome }
        let id = r.id
        if choice.choice == .remote {
            // `remote` is settled by the machine at once; the closing event arrives with the same turn.
            let remoteVersion = r.view.remote?.version
            if case .failed(let code) = await port.keep(id, choice) { return .failed(code: code, reopened: false) }
            state.with { _ = $0.machineReqs.removeValue(forKey: id) }
            r.markClosed()
            return .kept(.remote, version: remoteVersion, copyId: nil)
        }
        return await withCheckedContinuation { (cont: CheckedContinuation<MergeOutcome, Never>) in
            let taken = state.with { s -> Bool in
                if s.pending[id] != nil { return true }
                s.pending[id] = Pending(cont: cont, armed: false)
                return false
            }
            if taken {
                cont.resume(returning: Self.badRequest)
                return
            }
            Task {
                if case .failed(let code) = await port.keep(id, choice) {
                    let p = state.with { $0.pending.removeValue(forKey: id) }
                    p?.cont.resume(returning: .failed(code: code, reopened: false))
                }
            }
        }
    }

    // MARK: announcing

    private func announce(_ r: MergeRequest) {
        emit(.opened(r))
        let (listeners, first) = state.with { s -> ([(id: Int, fn: Decider)], Bool) in
            if s.listeners.isEmpty && !s.noticed {
                s.noticed = true
                return ([], true)
            }
            return (s.listeners, false)
        }
        if listeners.isEmpty {
            if first { notice?(r) }
            return
        }
        for l in listeners {
            if r.state != .open || r.isClosed { break }
            offer(l.fn, r)
        }
    }

    /// Hand a request to a listener; a returned choice decides it at once.
    private func offer(_ fn: Decider, _ r: MergeRequest) {
        guard let choice = fn(r) else { return }
        Task { _ = await self.keepRequest(r, choice) }
    }

    private func emit(_ signal: MergeSignal) {
        let fns = state.with { Array($0.watchers.values) }
        for fn in fns { fn(signal) }
    }
}
