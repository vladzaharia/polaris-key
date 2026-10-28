// Shared fakes for the Cloud Sync host tests: a scripted Worker, a fixture-root codec, a fake key ring,
// a clock and a temporary state directory.

import Foundation
import Testing

@testable import PolarisKey
@testable import PolarisKeyCore

let hRoot = Data((0..<32).map { UInt8(truncatingIfNeeded: 11 * $0 + 5) })
let hVOL = "audio.volume"
let hBIND = "input.bindings"
let hOPEN = "my.private.key"
let hALICE = "sub_alice"
let hBOB = "sub_bob"
let hT0 = 1_760_000_000_000
let hC = HostCodec.settingsCollection

func hJ(_ s: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }
let hMirror = hJ(
    """
    {"schemaVersion":1,"entries":[
      {"key":"audio.volume","kind":"config","user":{"sync":"user","conflict":"lastWrite"}},
      {"key":"input.bindings","kind":"config","user":{"sync":"user","conflict":"merge"}}]}
    """)

func hReply(_ over: [String: JSONValue] = [:]) -> JSONValue {
    var o: [String: JSONValue] = [
        "encryption": .string("e2e"), "subject": .string(hALICE), "cursor": .int(1), "more": .bool(false),
        "serverNow": .int(hT0), "catalogVersion": .int(1), "lastMutationId": .int(0), "changes": .array([]),
        "tombstones": .array([]), "aliases": .object([:]),
        "usage": hJ("{\"bytes\":0,\"settings\":0,\"records\":0,\"files\":0}"),
        "quota": hJ("{\"bytes\":268435456,\"files\":true}"),
    ]
    for (k, v) in over { o[k] = v }
    return .object(o)
}

/// A scripted Worker, a fake key ring and a clock.
final class HostRig: @unchecked Sendable {
    let lock = NSLock()
    var nowValue = hT0
    var subjectValue: String? = hALICE
    var sentValue: [SyncRequest] = []
    var inFlight = 0
    private(set) var maxInFlight = 0
    var fetches = 0
    var schema: JSONValue?
    var listener: (any SyncRootListener)?
    var responder: @Sendable (SyncRequest, HostRig) -> SyncResponse = { req, _ in
        if req.method == .get { return .answer(status: 200, body: hReply()) }
        let ids = (req.body?.objectValue?["mutations"]?.arrayValue ?? []).compactMap { $0.objectValue?["mutationId"] }
        return .answer(
            status: 200,
            body: hReply([
                "results": .array(
                    ids.map { .object(["mutationId": $0, "status": .string("ok"), "version": .int(2)]) })
            ]))
    }
    var sendDelayMs = 0
    let purgeStarted = LockedValue<Bool>(false)
    var onSend: (@Sendable (HostRig) -> Void)?
    let codec = FixtureCodec(hRoot)
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pk-host-\(UUID().uuidString)")

    var now: Int { get { lock.withLock { nowValue } } set { lock.withLock { nowValue = newValue } } }
    var subject: String? { get { lock.withLock { subjectValue } } set { lock.withLock { subjectValue = newValue } } }
    var sent: [SyncRequest] { lock.withLock { sentValue } }
    var fetchCount: Int { lock.withLock { fetches } }
    func setSchema(_ s: JSONValue?) { lock.withLock { schema = s } }
    func setRoot(_ present: Bool) {
        codec.lock(!present)
        lock.withLock { listener }?.setRoot(present: present)
    }
    var unlocked: Bool { !codec.locked }

    func deps() -> CloudSyncHostDeps {
        CloudSyncHostDeps(
            product: "demo", stateDir: dir,
            send: { [self] req in
                lock.withLock {
                    sentValue.append(req)
                    inFlight += 1
                    maxInFlight = max(maxInFlight, inFlight)
                }
                onSend?(self)
                if sendDelayMs > 0 { try? await Task.sleep(nanoseconds: UInt64(sendDelayMs) * 1_000_000) }
                lock.withLock { inFlight -= 1 }
                return responder(req, self)
            },
            codec: codec, keyringUnlocked: { [self] in unlocked },
            attachKeyring: { [self] l in
                lock.withLock { listener = l }
                l.setRoot(present: unlocked)
                return { [self] in lock.withLock { listener = nil } }
            },
            discovery: { .e2e },
            fetchSchema: { [self] in
                lock.withLock { fetches += 1 }
                return lock.withLock { schema }
            },
            subject: { [self] in subject }, clock: { [self] in now })
    }

    func host(_ options: CloudSyncOptions = CloudSyncOptions(catalog: hMirror)) async throws -> CloudSyncHost {
        let h = CloudSyncHost(deps: deps(), options: options)
        try await h.start()
        return h
    }
    deinit { try? FileManager.default.removeItem(at: dir) }
}

func hSignedIn(_ rig: HostRig, options: CloudSyncOptions = CloudSyncOptions(catalog: hMirror)) async throws
    -> CloudSyncHost
{
    let h = try await rig.host(options)
    _ = try await h.signIn(hALICE)
    await h.touch()
    return h
}

