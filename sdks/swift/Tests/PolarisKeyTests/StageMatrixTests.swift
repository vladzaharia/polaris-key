// @pkey-feature ui.stages packs.state update.bootguard ui.boot
// Cross-SDK boot stage machine conformance, driven off `conformance/corpus/v2`'s
// `stage-matrix.json`, mirrored into this bundle's `Resources/v2/` by `pnpm gen:corpus`.
//
// The Node runner (`conformance/runners/node/stageMatrix.test.ts`) and the Python runner
// (`sdks/python/tests/test_stage_matrix.py`) replay the SAME rows through their own
// implementations. For every row this asserts each step's emits (as values), the stage sequence
// built from the actual `stageChanged` emits, the final stage and the outcome. At the row's
// initial state and after every step it also sends every probe and asserts that the state comes
// back unchanged with no emits exactly when the probe's type is not in `accepts` for that state.
//
// The file is decoded into private `Decodable` structs and mapped onto the public types, as
// `GateMatrixTests` does. The mapping is strict: a value outside the vocabulary fails the test
// rather than being skipped. Every row and probe is well formed; v3's integer payloads that the
// corpus would call malformed are unit-tested below.

import Foundation
import PolarisKeyCore
import XCTest

final class StageMatrixTests: XCTestCase {
    private struct StageMatrix: Decodable {
        let stageMatrixVersion: Int
        let maxFailedBoots: Int
        let bootOkSeconds: Int
        let vocabulary: Vocabulary
        let accepts: [String: [String]]
        let probes: [RawEvent]
        let rows: [Row]
        let guardCases: [GuardCase]
        let confirmCases: [ConfirmCase]
    }
    private struct ConfirmCase: Decodable {
        let outcome: String
        let expect: String
    }
    private struct Vocabulary: Decodable {
        let stages: [String]
        let outcomes: [String]
        let events: [String]
        let emits: [String]
        let guardActions: [String]
        let confirmations: [String]
    }
    private struct Init: Decodable {
        let allowOffline: Bool?
        let allowGrace: Bool?
        let requiredPacks: [String]?
        let essentialPacks: [String]?
    }
    private struct RawEvent: Decodable {
        let type: String
        let result: String?
        let status: String?
        let decision: String?
        let installed: [String]?
        let code: String?
        let bytes: Int?
        let metered: Bool?
        let done: Int?
        let total: Int?
    }
    private struct RawEmit: Decodable {
        let type: String
        let stage: String?
        let previous: String?
        let status: String?
        let reason: String?
        let canPlayOffline: Bool?
        let code: String?
        let bytes: Int?
        let metered: Bool?
        let done: Int?
        let total: Int?
    }
    private struct Step: Decodable {
        let event: RawEvent
        let emits: [RawEmit]
    }
    private struct Expect: Decodable {
        let stages: [String]
        let outcome: String
    }
    private struct Row: Decodable {
        let name: String
        let `init`: Init
        let steps: [Step]
        let expect: Expect
    }
    private struct GuardInput: Decodable {
        let staged: Bool
        let failedBoots: Int
    }
    private struct GuardExpect: Decodable {
        let action: String
    }
    private struct GuardCase: Decodable {
        let name: String
        let input: GuardInput
        let expect: GuardExpect
    }

    private struct Unmappable: Error, CustomStringConvertible {
        let description: String
    }

    private func loadMatrix() throws -> StageMatrix {
        try CorpusBundleLoader.load(
            StageMatrix.self, (stageMatrixFile as NSString).deletingPathExtension)
    }

    // ── Strict mapping onto the public types ─────────────────────────────────────────
    private func value<T: RawRepresentable>(_ type: T.Type, _ raw: String?) throws -> T
    where T.RawValue == String {
        guard let raw, let value = T(rawValue: raw) else {
            throw Unmappable(description: "\(T.self) has no \(raw ?? "nil")")
        }
        return value
    }

    private func event(_ e: RawEvent) throws -> BootEvent {
        switch e.type {
        case "start": return .start
        case "shell.done": return .shellDone
        case "guard.done": return .guardDone(try value(BootEvent.GuardResult.self, e.result))
        case "sync.done": return .syncDone(try value(BootEvent.SyncResult.self, e.result))
        case "sync.timeout": return .syncTimeout
        case "gate.status": return .gateStatus(try value(LicenseStatus.self, e.status))
        case "decide.done": return .decideDone(try value(BootEvent.Decision.self, e.decision))
        case "fetch.done":
            guard let installed = e.installed else {
                throw Unmappable(description: "fetch.done without installed")
            }
            return .fetchDone(try value(BootEvent.FetchResult.self, e.result), installed: installed)
        case "mount.done": return .mountDone
        case "background.start": return .backgroundStart
        case "background.done": return .backgroundDone
        case "retry": return .retry
        case "play-offline": return .playOffline
        case "fail":
            guard let code = e.code else { throw Unmappable(description: "fail without code") }
            return .fail(code: code)
        case "fetch.consent":
            guard let bytes = e.bytes, let metered = e.metered else {
                throw Unmappable(description: "fetch.consent without bytes or metered")
            }
            return .fetchConsent(bytes: bytes, metered: metered)
        case "fetch.progress":
            guard let done = e.done, let total = e.total else {
                throw Unmappable(description: "fetch.progress without done or total")
            }
            return .fetchProgress(done: done, total: total)
        default: throw Unmappable(description: "unknown event \(e.type)")
        }
    }

    private func emit(_ e: RawEmit) throws -> BootEmit {
        switch e.type {
        case "stage_changed":
            return .stageChanged(
                stage: try value(BootStage.self, e.stage),
                previous: try value(BootStage.self, e.previous))
        case "waiting": return .waiting(status: try value(LicenseStatus.self, e.status))
        case "update_available": return .updateAvailable
        case "blocked": return .blocked(reason: try value(BootEmit.BlockedReason.self, e.reason))
        case "offline":
            guard let canPlayOffline = e.canPlayOffline else {
                throw Unmappable(description: "offline without canPlayOffline")
            }
            return .offline(canPlayOffline: canPlayOffline)
        case "error":
            guard let code = e.code else { throw Unmappable(description: "error without code") }
            return .error(code: code)
        case "boot_rolled_back": return .bootRolledBack
        case "boot_ready": return .bootReady
        case "consent_needed":
            guard let bytes = e.bytes, let metered = e.metered else {
                throw Unmappable(description: "consent_needed without bytes or metered")
            }
            return .consentNeeded(bytes: bytes, metered: metered)
        case "fetch_progress":
            guard let done = e.done, let total = e.total else {
                throw Unmappable(description: "fetch_progress without done or total")
            }
            return .fetchProgress(done: done, total: total)
        default: throw Unmappable(description: "unknown emit \(e.type)")
        }
    }

    private func options(_ i: Init) -> BootOptions {
        var options = BootOptions()
        if let allowOffline = i.allowOffline { options.allowOffline = allowOffline }
        if let allowGrace = i.allowGrace { options.allowGrace = allowGrace }
        if let requiredPacks = i.requiredPacks { options.requiredPacks = requiredPacks }
        if let essentialPacks = i.essentialPacks { options.essentialPacks = essentialPacks }
        return options
    }

    /// `gate:waiting` while the gate waits, `fetch:waiting` while the fetch waits for consent,
    /// `offline:playable` at a playable offline stop (v3), otherwise the stage.
    private func acceptsKey(_ state: BootState) -> String {
        if state.stage == .gate && state.outcome == .waiting { return "gate:waiting" }
        if state.stage == .fetch && state.outcome == .waiting { return "fetch:waiting" }
        if state.stage == .offline && state.canPlayOffline { return "offline:playable" }
        return state.stage.rawValue
    }

    /// Sends every probe from `state`; returns how many it sent.
    private func probe(
        _ state: BootState, _ probes: [BootEvent], _ accepts: [String: [String]], _ where_: String
    ) throws -> Int {
        let key = acceptsKey(state)
        let accepted = try XCTUnwrap(accepts[key], "\(where_): accepts has no \(key)")
        for probe in probes {
            let result = bootTransition(state, probe)
            let ignored = result.emits.isEmpty && result.state == state
            XCTAssertEqual(
                ignored, !accepted.contains(probe.type), "\(where_): probe \(probe.type) in \(key)")
        }
        return probes.count
    }

    // ── The runner ───────────────────────────────────────────────────────────────────
    func testVersionAndVocabulary() throws {
        let matrix = try loadMatrix()
        print(
            "stage-matrix runner on \(ProcessInfo.processInfo.operatingSystemVersionString)")
        XCTAssertEqual(matrix.stageMatrixVersion, 3)
        XCTAssertEqual(matrix.maxFailedBoots, MAX_FAILED_BOOTS)
        XCTAssertEqual(matrix.bootOkSeconds, BOOT_OK_SECONDS)
        XCTAssertEqual(matrix.vocabulary.confirmations, BootConfirmation.allCases.map(\.rawValue))
        XCTAssertEqual(matrix.vocabulary.stages, BOOT_STAGES)
        XCTAssertEqual(matrix.vocabulary.outcomes, BOOT_OUTCOMES)
        XCTAssertEqual(matrix.vocabulary.events, BOOT_EVENT_TYPES)
        XCTAssertEqual(matrix.vocabulary.emits, BOOT_EMIT_TYPES)
        XCTAssertEqual(matrix.vocabulary.guardActions, BOOT_GUARD_ACTIONS)
        XCTAssertEqual(matrix.probes.map(\.type), matrix.vocabulary.events)
    }

    func testEveryRowAndProbe() throws {
        let matrix = try loadMatrix()
        let probes = try matrix.probes.map(event)
        XCTAssertEqual(probes.map(\.type), BOOT_EVENT_TYPES)
        XCTAssertGreaterThanOrEqual(matrix.rows.count, 56)
        var sent = 0
        var states = 0
        for row in matrix.rows {
            var state = initialBootState(options(row.`init`))
            var stages: [String] = []
            sent += try probe(state, probes, matrix.accepts, "\(row.name), initial state")
            states += 1
            for (i, step) in row.steps.enumerated() {
                let where_ = "\(row.name), step \(i + 1) (\(step.event.type))"
                let result = bootTransition(state, try event(step.event))
                XCTAssertEqual(result.emits, try step.emits.map(emit), where_)
                for case .stageChanged(let stage, _) in result.emits { stages.append(stage.rawValue) }
                state = result.state
                // v3: canPlayOffline is true exactly at an offline stop whose emit said so.
                var offlineEmit: Bool? = nil
                for case .offline(let can) in result.emits { offlineEmit = can }
                if let offlineEmit {
                    XCTAssertEqual(state.canPlayOffline, offlineEmit, where_)
                } else if !result.emits.isEmpty {
                    XCTAssertFalse(state.canPlayOffline, where_)
                }
                sent += try probe(state, probes, matrix.accepts, "\(where_), after")
                states += 1
            }
            XCTAssertEqual(stages, row.expect.stages, row.name)
            XCTAssertEqual(state.stage.rawValue, row.expect.stages.last, row.name)
            XCTAssertEqual(state.outcome.rawValue, row.expect.outcome, row.name)
        }
        XCTAssertEqual(sent, states * BOOT_EVENT_TYPES.count)
        print("stage-matrix: \(matrix.rows.count) rows, \(sent) probe transitions")
    }

    func testGuardCases() throws {
        let matrix = try loadMatrix()
        XCTAssertGreaterThanOrEqual(matrix.guardCases.count, 7)
        for c in matrix.guardCases {
            let action = bootGuardAction(staged: c.input.staged, failedBoots: c.input.failedBoots)
            XCTAssertEqual(action.rawValue, c.expect.action, c.name)
        }
    }

    // ── Unit properties the corpus cannot express ────────────────────────────────────
    func testPurityAndDefaults() {
        let state = initialBootState()
        XCTAssertEqual(
            state,
            BootState(
                stage: .idle, outcome: .running, options: BootOptions(), sync: .pending,
                resume: .shell))
        XCTAssertEqual(
            state.options,
            BootOptions(allowOffline: true, allowGrace: true, requiredPacks: [], essentialPacks: []))
        XCTAssertFalse(state.canPlayOffline)
        let first = bootTransition(state, .start)
        XCTAssertEqual(first, bootTransition(state, .start))
        XCTAssertEqual(state, initialBootState())
        XCTAssertEqual(bootGuardAction(staged: true, failedBoots: MAX_FAILED_BOOTS - 1), .applyStaged)
        XCTAssertEqual(bootGuardAction(staged: true, failedBoots: MAX_FAILED_BOOTS), .rollBack)
    }

    /// Stage matrix v2 (plans/P3-01.md §2.10): boot confirmation, one case per outcome.
    func testConfirmCases() throws {
        let matrix = try loadMatrix()
        XCTAssertEqual(
            Set(matrix.confirmCases.map(\.outcome)), Set(BootOutcome.allCases.map(\.rawValue)))
        XCTAssertEqual(matrix.confirmCases.count, BootOutcome.allCases.count)
        for c in matrix.confirmCases {
            guard let outcome = BootOutcome(rawValue: c.outcome) else {
                XCTFail("unknown outcome \(c.outcome)")
                continue
            }
            XCTAssertEqual(bootConfirmation(outcome).rawValue, c.expect, c.outcome)
        }
    }

    // ── Stage matrix v3: the integer payloads the corpus would call malformed ────────
    private func fetching(_ options: BootOptions) -> BootState {
        var state = initialBootState(options)
        let events: [BootEvent] = [
            .start, .shellDone, .guardDone(.ok), .syncDone(.ok), .gateStatus(.ok),
            .decideDone(.none),
        ]
        for e in events { state = bootTransition(state, e).state }
        XCTAssertEqual(state.stage, .fetch)
        return state
    }

    func testV3IgnoresMalformedConsentAndProgress() {
        let state = fetching(BootOptions(requiredPacks: ["core"]))
        let bad: [BootEvent] = [
            .fetchConsent(bytes: -1, metered: false),
            .fetchConsent(bytes: 9_007_199_254_740_992, metered: false),
            .fetchProgress(done: 2, total: 1),
            .fetchProgress(done: -1, total: 1),
            .fetchProgress(done: 0, total: 9_007_199_254_740_992),
        ]
        for e in bad {
            let r = bootTransition(state, e)
            XCTAssertEqual(r.state, state, "\(e)")
            XCTAssertEqual(r.emits, [], "\(e)")
        }
    }

    func testV3ResetsCanPlayOfflineWhenThePlayableStopIsLeft() {
        var state = fetching(BootOptions(requiredPacks: ["core"], essentialPacks: ["hd"]))
        state = bootTransition(state, .fetchDone(.offline, installed: ["core"])).state
        XCTAssertTrue(state.canPlayOffline)
        state = bootTransition(state, .playOffline).state
        XCTAssertEqual(state.stage, .mount)
        XCTAssertFalse(state.canPlayOffline)
    }
}

/// The corpus file these tests replay (its guard cases are `update.bootguard`'s proof).
private let stageMatrixFile = "stage-matrix.json"
