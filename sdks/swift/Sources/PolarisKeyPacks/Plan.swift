// The install planner (plans/P4-01.md §2.9; notes/A7 §4.2 exactly, with `full.requests`).
// `plan-matrix.json#rows` pins it. A pure integer function: it returns its verdicts
// (`plan-transport-unsupported`, `plan-insufficient-disk`, `plan-no-strategy`) and never throws.
// client-core `packs/plan.ts` is the reference.

import Foundation
import PolarisKeyCore

/// The strategies, in the rank that breaks a cost tie (`full` is always last).
public let PLAN_STRATEGIES = ["noop", "platform", "delta", "chunk", "file", "full"]

/// One installed release of the pack, as the planner sees it.
public struct PlanInstalled: Sendable, Equatable {
    public var release: String
    public var payloadSha256: String
    /// The chunk ids this release's chunk index holds (P4-11), when it is kept.
    public var chunks: [String]?
    /// The file hashes this release's files index holds, when it is kept.
    public var files: [String]?

    public init(release: String, payloadSha256: String, chunks: [String]? = nil, files: [String]? = nil) {
        self.release = release
        self.payloadSha256 = payloadSha256
        self.chunks = chunks
        self.files = files
    }

    public init?(json: JSONValue) {
        guard let o = json.objectValue, let r = o["release"]?.stringValue,
            let p = o["payloadSha256"]?.stringValue
        else { return nil }
        self.init(
            release: r, payloadSha256: p,
            chunks: o["chunks"]?.objectValue?["ids"]?.arrayValue?.compactMap(\.stringValue),
            files: o["files"]?.arrayValue?.compactMap(\.stringValue))
    }
}

/// What the host can do. `requestWeight` defaults to `PLAN_REQUEST_WEIGHT` (16,384).
public struct PlanCaps: Sendable, Equatable {
    public var strategies: [String]
    public var patchMethods: [String]
    public var transports: [String]
    public var memBudget: Int
    public var freeDisk: Int
    public var requestWeight: Int?

    public init(
        strategies: [String], patchMethods: [String], transports: [String], memBudget: Int,
        freeDisk: Int, requestWeight: Int? = nil
    ) {
        self.strategies = strategies
        self.patchMethods = patchMethods
        self.transports = transports
        self.memBudget = memBudget
        self.freeDisk = freeDisk
        self.requestWeight = requestWeight
    }

    public init?(json: JSONValue) {
        guard let o = json.objectValue, let mem = o["memBudget"]?.intValue,
            let disk = o["freeDisk"]?.intValue
        else { return nil }
        func strings(_ k: String) -> [String] { o[k]?.arrayValue?.compactMap(\.stringValue) ?? [] }
        self.init(
            strategies: strings("strategies"), patchMethods: strings("patchMethods"),
            transports: strings("transports"), memBudget: mem, freeDisk: disk,
            requestWeight: o["requestWeight"]?.intValue)
    }
}

/// A costed candidate, as the plan reports it.
public struct PlanCandidate: Sendable, Equatable {
    public var strategy: String
    /// The delta's id, for `delta`.
    public var delta: String?
    public var bytes: Int
    public var requests: Int
    public var cost: Int

    public var json: JSONValue {
        var o: [String: JSONValue] = [
            "strategy": .string(strategy), "bytes": .int(bytes), "requests": .int(requests),
            "cost": .int(cost),
        ]
        if let delta { o["delta"] = .string(delta) }
        return .object(o)
    }
}

/// `plan`'s answer.
public enum PlanResult: Sendable, Equatable {
    case chosen(PlanCandidate, peakDisk: Int, fallbacks: [PlanCandidate])
    case platform(transport: String)
    /// `plan-transport-unsupported`, `plan-insufficient-disk` or `plan-no-strategy`.
    case error(String)

    public var json: JSONValue {
        switch self {
        case .chosen(let c, let peak, let fallbacks):
            guard case .object(var o) = c.json else { return .null }
            o["peakDisk"] = .int(peak)
            o["fallbacks"] = .array(fallbacks.map(\.json))
            return .object(o)
        case .platform(let t):
            return .object([
                "strategy": .string("platform"), "transport": .string(t), "fallbacks": .array([]),
            ])
        case .error(let e): return .object(["error": .string(e)])
        }
    }
}

private struct Cand {
    var strategy: String
    var delta: String?
    var bytes: Int
    var requests: Int
    var ord: Int
    var cost = 0
    var peakDisk = 0
}

private func rank(_ s: String) -> Int { PLAN_STRATEGIES.firstIndex(of: s) ?? PLAN_STRATEGIES.count }

/// `plan(target, installed, caps)`: `noop` when a release with the target payload is installed;
/// a platform-bound target takes `platform` when the host lists its transport, else
/// `plan-transport-unsupported`. Otherwise every allowed, feasible candidate is costed
/// (`bytes + requestWeight × requests`), with `peakDisk` = payload size + bytes: each delta whose
/// method the host lists, whose base is installed and whose `memBytes` fits `memBudget`; `chunk`
/// from the installed seeds; `file` from the installed files indexes; `full` whenever the target
/// has one, whatever `strategies` says. Candidates over `freeDisk` drop. The cheapest wins (ties:
/// strategy rank, then record order); the rest are fallbacks in cost order with `full` last.
public func plan(target t: PlanTarget, installed inst: [PlanInstalled], caps: PlanCaps) -> PlanResult {
    if inst.contains(where: { $0.payloadSha256 == t.payload.sha256 }) {
        return .chosen(
            PlanCandidate(strategy: "noop", delta: nil, bytes: 0, requests: 0, cost: 0),
            peakDisk: 0, fallbacks: [])
    }
    if let transport = t.platform {
        return caps.transports.contains(transport)
            ? .platform(transport: transport) : .error(ErrorCode.planTransportUnsupported)
    }
    let strategies = Set(caps.strategies)
    let have = Set(inst.map(\.payloadSha256))
    var cands: [Cand] = []

    if strategies.contains("delta") {
        for (k, d) in t.deltas.enumerated()
        where caps.patchMethods.contains(d.method) && have.contains(d.from)
            && d.memBytes <= caps.memBudget
        {
            cands.append(
                Cand(
                    strategy: "delta", delta: d.id, bytes: d.artifacts.reduce(0) { $0 + $1.bytes },
                    requests: d.artifacts.count, ord: k))
        }
    }

    let seeds = inst.compactMap(\.chunks)
    if strategies.contains("chunk"), let chunks = t.chunks, !seeds.isEmpty {
        var seeded = Set<String>()
        for s in seeds { for id in s { seeded.insert(id) } }
        var seen = Set<String>()
        var prev: PlanChunkRecord?
        var runs = 0
        var bytes = chunks.indexBytes
        for r in chunks.records {
            if seeded.contains(r.id) || seen.contains(r.id) { continue }
            seen.insert(r.id)
            bytes += r.clen
            if prev == nil || r.bundle != prev!.bundle || r.offset != prev!.offset + prev!.clen {
                runs += 1
            }
            prev = r
        }
        cands.append(Cand(strategy: "chunk", delta: nil, bytes: bytes, requests: 1 + runs, ord: 0))
    }

    let withFiles = inst.filter { $0.files != nil }
    if strategies.contains("file"), let files = t.files, !withFiles.isEmpty {
        var held = Set<String>()
        for i in withFiles { for x in i.files! { held.insert(x) } }
        var missing: [String: Int] = [:]
        var order: [String] = []
        for f in files.files where !held.contains(f.sha256) && missing[f.sha256] == nil {
            missing[f.sha256] = f.blobBytes
            order.append(f.sha256)
        }
        let sum = order.reduce(0) { $0 + missing[$1]! }
        cands.append(
            Cand(
                strategy: "file", delta: nil, bytes: files.indexBytes + files.gapsBytes + sum,
                requests: 1 + (files.gapsBytes > 0 ? 1 : 0) + missing.count, ord: 0))
    }

    if let full = t.full {
        cands.append(
            Cand(strategy: "full", delta: nil, bytes: full.bytes, requests: full.requests ?? 1, ord: 0))
    }

    if cands.isEmpty { return .error(ErrorCode.planNoStrategy) }
    let w = caps.requestWeight ?? PLAN_REQUEST_WEIGHT
    let all = cands.map { c -> Cand in
        var c = c
        c.cost = c.bytes + w * c.requests
        c.peakDisk = t.payload.size + c.bytes
        return c
    }
    var feasible = all.filter { $0.peakDisk <= caps.freeDisk }
    if feasible.isEmpty { return .error(ErrorCode.planInsufficientDisk) }
    // A stable sort: equal keys keep their candidate order, as `Array.prototype.sort` does.
    feasible = feasible.enumerated().sorted { a, b in
        if a.element.cost != b.element.cost { return a.element.cost < b.element.cost }
        let ra = rank(a.element.strategy)
        let rb = rank(b.element.strategy)
        if ra != rb { return ra < rb }
        if a.element.ord != b.element.ord { return a.element.ord < b.element.ord }
        return a.offset < b.offset
    }.map(\.element)
    let chosen = feasible[0]
    let rest = feasible.dropFirst()
    let ordered = rest.filter { $0.strategy != "full" } + rest.filter { $0.strategy == "full" }
    func publish(_ c: Cand) -> PlanCandidate {
        PlanCandidate(strategy: c.strategy, delta: c.delta, bytes: c.bytes, requests: c.requests, cost: c.cost)
    }
    return .chosen(publish(chosen), peakDisk: chosen.peakDisk, fallbacks: ordered.map(publish))
}
