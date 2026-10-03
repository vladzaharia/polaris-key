// The v3 pack-type handlers (CONTENT §4.2, §13; P4-16): `data.json` and `l10n.table` (built in)
// and `ml.model` (registered by the host with its budget and load test), ports of client-core's
// `packs/handlers/` held to `packages/client-core/test/fixtures/pack-type-cases.json`.
//
// Every one is a tree, hot (a versioned directory and a pointer swap), and checks a newly staged
// payload before it commits (`PackHandler.check`, `pack-type-check-failed`). They PARSE untrusted
// bytes and never evaluate them: strict JSON (V4 §1.2, `strictParse`), plain PO and CSV readers,
// nothing that builds objects or code from data. Content is judged by bytes, never by name: every
// file of a `data.json` or `l10n.table` payload is parsed whatever it is called. Files are looked
// up by exact index path only (the engine's `checkPaths` already refused every non-normalised
// path); a descriptor's `file` must name an index path exactly.

import Foundation
import PolarisKeyCore

/// The default per-file limit of a `data.json` or `l10n.table` payload: 16 MiB.
public let PACK_TEXT_MAX_FILE_BYTES = 16 << 20
/// The largest `model.json` read.
public let PACK_DESCRIPTOR_MAX_BYTES = 65536

/// A token (`^[a-z][a-z0-9-]{0,31}$`): a runtime, a quantisation, a middleware name.
func isPackToken(_ s: String) -> Bool {
    let b = Array(s.utf8)
    guard !b.isEmpty, b.count <= 32, b[0] >= 97, b[0] <= 122 else { return false }
    return b.allSatisfy { ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 45 }
}


/// The files of an installed payload, in index order (a tree's, or nil).
private func payloadFiles(_ payload: PackPayloadReader) throws -> [InstalledFile] {
    try payload.read()?.files ?? []
}

// ── data.json ────────────────────────────────────────────────────────────────────────────────

/// One parsed `data.json` document.
public struct DataDocument: Sendable, Equatable {
    public let path: String
    public let value: JSONValue
}

/// `data.json` (CONTENT §4.2): JSON documents (balance tables, event definitions), hot. Every file
/// is strict JSON (WIRE-CONTRACT-V4 §1.2: UTF-8 without a BOM, an object at the top, no duplicate
/// member, trailing comma, comment, `NaN` or second value), whatever its name; its
/// `formatVersion` must be one it lists. Tiny, frequently tuned values belong in managed config,
/// not a pack.
public final class DataJsonHandler: PackHandler, Sendable {
    public let type = "data.json"
    public let layout = "tree"
    public let activation = "hot"
    public let formatVersions: [Int]
    public let maxFileBytes: Int
    private let onActivate: (@Sendable (String, [DataDocument]) async -> Void)?
    private let onDeactivate: (@Sendable (String) async -> Void)?
    private let active = Locked<[String: [DataDocument]]>([:])

    public init(
        formatVersions: [Int] = [1], maxFileBytes: Int = PACK_TEXT_MAX_FILE_BYTES,
        onActivate: (@Sendable (String, [DataDocument]) async -> Void)? = nil,
        onDeactivate: (@Sendable (String) async -> Void)? = nil
    ) {
        self.formatVersions = formatVersions
        self.maxFileBytes = maxFileBytes
        self.onActivate = onActivate
        self.onDeactivate = onDeactivate
    }

    public func supports(_ formatVersion: Int) -> Bool { formatVersions.contains(formatVersion) }

    /// The active release's documents, in index order; nil when none is active.
    public func documents(_ packId: String) -> [DataDocument]? { active.with { $0[packId] } }

    public func check(_ staged: StagedPack) async throws -> PackCheckRefusal? {
        for f in staged.files {
            if f.size > maxFileBytes { return PackCheckRefusal("size", path: f.path) }
            if strictParse(try readAll(f.source)) == nil {
                return PackCheckRefusal("json", path: f.path)
            }
        }
        return nil
    }

    public func activate(_ install: PackInstall, payload: PackPayloadReader) async throws {
        var docs: [DataDocument] = []
        for f in try payloadFiles(payload) {
            guard let v = strictParse(try readAll(f.source))?.value else {
                throw PackError(
                    ErrorCode.packTypeCheckFailed, "\(install.packId)'s \(f.path) is not strict JSON.",
                    detail: "json", path: f.path, packId: install.packId)
            }
            docs.append(DataDocument(path: f.path, value: v))
        }
        active.with { $0[install.packId] = docs }
        await onActivate?(install.packId, docs)
    }

    public func deactivate(_ install: PackInstall) async throws {
        active.with { $0[install.packId] = nil }
        await onDeactivate?(install.packId)
    }
}

// ── l10n.table ───────────────────────────────────────────────────────────────────────────────

/// `l10n.table` (CONTENT §4.2): PO, CSV or JSON tables (`L10n.swift`), hot. Each table's locale is
/// a well-formed BCP-47 tag and, when the variant has a `locale` axis, that locale.
public final class L10nTableHandler: PackHandler, Sendable {
    public let type = "l10n.table"
    public let layout = "tree"
    public let activation = "hot"
    public let formatVersions: [Int]
    public let maxFileBytes: Int
    private let onActivate: (@Sendable (String, [L10nTable]) async -> Void)?
    private let onDeactivate: (@Sendable (String, [L10nTable]) async -> Void)?
    private let active = Locked<[String: [L10nTable]]>([:])

    public init(
        formatVersions: [Int] = [1], maxFileBytes: Int = PACK_TEXT_MAX_FILE_BYTES,
        onActivate: (@Sendable (String, [L10nTable]) async -> Void)? = nil,
        onDeactivate: (@Sendable (String, [L10nTable]) async -> Void)? = nil
    ) {
        self.formatVersions = formatVersions
        self.maxFileBytes = maxFileBytes
        self.onActivate = onActivate
        self.onDeactivate = onDeactivate
    }

    public func supports(_ formatVersion: Int) -> Bool { formatVersions.contains(formatVersion) }

    /// The active release's tables, in index order; nil when none is active.
    public func tables(_ packId: String) -> [L10nTable]? { active.with { $0[packId] } }

    /// The check over files in index order: the first refusal, or the tables.
    public func checkFiles(_ files: [(path: String, bytes: [UInt8])], variant: [String: String])
        -> Result<[L10nTable], PackCheckRefusal>
    {
        var out: [L10nTable] = []
        for f in files {
            if f.bytes.count > maxFileBytes { return .failure(PackCheckRefusal("size", path: f.path)) }
            switch parseL10nFile(f.path, f.bytes) {
            case .failed(let detail): return .failure(PackCheckRefusal(detail, path: f.path))
            case .ok(let tables):
                if let want = variant["locale"], let t = tables.first(where: { !sameLocale($0.locale, want) }) {
                    return .failure(
                        PackCheckRefusal(
                            "locale", path: f.path, message: "\(f.path) is a \(t.locale) table in the \(want) variant."))
                }
                out += tables
            }
        }
        return .success(out)
    }

    public func check(_ staged: StagedPack) async throws -> PackCheckRefusal? {
        var files: [(path: String, bytes: [UInt8])] = []
        for f in staged.files {
            // The size rule before a byte is read.
            if f.size > maxFileBytes { return PackCheckRefusal("size", path: f.path) }
            files.append((f.path, try readAll(f.source)))
        }
        if case .failure(let r) = checkFiles(files, variant: staged.variant.variant) { return r }
        return nil
    }

    public func activate(_ install: PackInstall, payload: PackPayloadReader) async throws {
        var tables: [L10nTable] = []
        for f in try payloadFiles(payload) {
            guard case .ok(let t) = parseL10nFile(f.path, try readAll(f.source)) else {
                throw PackError(
                    ErrorCode.packTypeCheckFailed, "\(install.packId)'s \(f.path) is not a table.",
                    detail: "table", path: f.path, packId: install.packId)
            }
            tables += t
        }
        active.with { $0[install.packId] = tables }
        await onActivate?(install.packId, tables)
    }

    public func deactivate(_ install: PackInstall) async throws {
        let was = active.with { a -> [L10nTable] in
            defer { a[install.packId] = nil }
            return a[install.packId] ?? []
        }
        await onDeactivate?(install.packId, was)
    }
}

// ── ml.model ─────────────────────────────────────────────────────────────────────────────────

/// An `ml.model` payload's `model.json`.
public struct MlModelDescriptor: Sendable, Equatable {
    public let runtime: String
    /// The model file: exactly an index path.
    public let file: String
    /// The RAM the model needs, in bytes.
    public let memBytes: Int
    public let vramBytes: Int?
    public let quantization: String?
}

/// What a host's load test is given: the staged model file and its descriptor.
public struct MlModelLoadTest: Sendable {
    public let packId: String
    /// The store location of the staged payload (a directory with `DirStorage`).
    public let location: String
    public let file: InstalledFile
    public let descriptor: MlModelDescriptor
}

/// The active release of an `ml.model` pack.
public struct MlModel: Sendable, Equatable {
    public let packId: String
    /// The model file's index path.
    public let path: String
    public let location: String
    public let descriptor: MlModelDescriptor
}

/// `model.json` read from an index, or the refusal (`descriptor`).
func mlModelDescriptor(_ files: [InstalledFile]) throws -> MlModelDescriptor? {
    guard let f = files.first(where: { $0.path == "model.json" }), f.size <= PACK_DESCRIPTOR_MAX_BYTES,
        let (v, nonWire) = strictParse(try readAll(f.source)), case .object(let o) = v,
        case .string(let runtime)? = o["runtime"], isPackToken(runtime),
        case .string(let file)? = o["file"], file != "model.json", files.contains(where: { $0.path == file }),
        case .int(let mem)? = o["memBytes"], wireInteger(mem, pointer: "/memBytes", min: 0, in: nonWire)
    else { return nil }
    var vram: Int?
    if let x = o["vramBytes"] {
        guard case .int(let n) = x, wireInteger(n, pointer: "/vramBytes", min: 0, in: nonWire) else { return nil }
        vram = n
    }
    var quant: String?
    if let x = o["quantization"] {
        guard case .string(let q) = x, isPackToken(q) else { return nil }
        quant = q
    }
    return MlModelDescriptor(runtime: runtime, file: file, memBytes: mem, vramBytes: vram, quantization: quant)
}

/// `ml.model` (CONTENT §4.2): a model and its `model.json`, hot: the path swaps only after the
/// host's load test passes. Not built in: the host registers one with what it can run and the
/// memory a model may need.
public final class MlModelHandler: PackHandler, Sendable {
    public let type = "ml.model"
    public let layout = "tree"
    public let activation = "hot"
    public let runtimes: [String]
    public let ramBytes: Int
    public let vramBytes: Int
    public let quantizations: [String]?
    public let formatVersions: [Int]
    private let loadTest: (@Sendable (MlModelLoadTest) async throws -> Bool)?
    private let onActivate: (@Sendable (MlModel) async -> Void)?
    private let onDeactivate: (@Sendable (String) async -> Void)?
    private let active = Locked<[String: MlModel]>([:])

    /// Throws `invalid-options` unless `runtimes` is non-empty and the budgets are non-negative.
    public init(
        runtimes: [String], ramBytes: Int, vramBytes: Int = 0, quantizations: [String]? = nil,
        loadTest: (@Sendable (MlModelLoadTest) async throws -> Bool)? = nil,
        onActivate: (@Sendable (MlModel) async -> Void)? = nil,
        onDeactivate: (@Sendable (String) async -> Void)? = nil, formatVersions: [Int] = [1]
    ) throws {
        guard !runtimes.isEmpty, ramBytes >= 0, vramBytes >= 0 else {
            throw PackError(
                ErrorCode.invalidOptions,
                "MlModelHandler needs {runtimes: a non-empty list, ramBytes: a non-negative integer, vramBytes: a non-negative integer}.")
        }
        self.runtimes = runtimes
        self.ramBytes = ramBytes
        self.vramBytes = vramBytes
        self.quantizations = quantizations
        self.loadTest = loadTest
        self.onActivate = onActivate
        self.onDeactivate = onDeactivate
        self.formatVersions = formatVersions
    }

    public func supports(_ formatVersion: Int) -> Bool { formatVersions.contains(formatVersion) }

    /// The active release's model, or nil.
    public func model(_ packId: String) -> MlModel? { active.with { $0[packId] } }

    public func check(_ staged: StagedPack) async throws -> PackCheckRefusal? {
        let files = staged.files
        guard let d = try mlModelDescriptor(files) else { return PackCheckRefusal("descriptor", path: "model.json") }
        if !runtimes.contains(d.runtime) {
            return PackCheckRefusal(
                "runtime", path: "model.json",
                message: "this host runs \(runtimes.joined(separator: ", ")), not \(d.runtime).")
        }
        if let qs = quantizations, !(d.quantization.map(qs.contains) ?? false) {
            return PackCheckRefusal("quantization", path: "model.json")
        }
        if d.memBytes > ramBytes || (d.vramBytes ?? 0) > vramBytes {
            return PackCheckRefusal(
                "memory", path: "model.json",
                message:
                    "the model needs \(d.memBytes) B of RAM and \(d.vramBytes ?? 0) B of VRAM; the budget is \(ramBytes) B and \(vramBytes) B."
            )
        }
        if let loadTest {
            let file = files.first { $0.path == d.file }!
            let passed: Bool
            do {
                passed = try await loadTest(
                    MlModelLoadTest(packId: staged.packId, location: staged.location, file: file, descriptor: d))
            } catch {
                passed = false
            }
            if !passed { return PackCheckRefusal("load-test", path: d.file) }
        }
        return nil
    }

    public func activate(_ install: PackInstall, payload: PackPayloadReader) async throws {
        guard let d = try mlModelDescriptor(try payloadFiles(payload)) else {
            throw PackError(
                ErrorCode.packTypeCheckFailed, "\(install.packId)'s model.json cannot be read.",
                detail: "descriptor", path: "model.json", packId: install.packId)
        }
        let m = MlModel(packId: install.packId, path: d.file, location: install.location, descriptor: d)
        active.with { $0[install.packId] = m }
        await onActivate?(m)
    }

    public func deactivate(_ install: PackInstall) async throws {
        active.with { $0[install.packId] = nil }
        await onDeactivate?(install.packId)
    }
}
