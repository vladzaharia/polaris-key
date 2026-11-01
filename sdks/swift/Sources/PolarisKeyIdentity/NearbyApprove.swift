// `identity.nearby.onRequest(...)` (WIRE-CONTRACT-V5 §12.11.5, §15.6.1): the approving device M. The LAN half
// (the advert, the three codes, number matching, the verified `VOUCH_REQ`) is the Connect code's
// (`NearbyApprover`); this file is the Identity half on top of it: what the person is asked, the `nearby/approve`
// call, the licence choice and the answer given back to the LAN session. Mirrors sdk-node's
// `identity/nearbyApprover.ts` and the approve half of `identity/nearby.ts`.
//
//   let approver = try await client.identity.nearby.onRequest(NearbyApproverOptions(prompt: true)) { ask in
//       show(ask.device, ask.platform, ask.codes)          // three codes; the person taps one
//       let step = try await ask.pick(tapped)              // or `await ask.deny()` for none of them
//       // step: .approved .mismatch .notNearby .denied .expired .deviceLimit .accountRequired .rateLimited
//       //       .choose(NearbyChoose)
//   }
//
// Rules this file keeps (the approver's rules):
//  - no silent approval: `nearby/approve` is reached only from a `pick` that matched on that session and whose
//    `VOUCH_REQ` verified (the engine refuses `finish` otherwise), and it carries exactly that request's
//    `request`, `deviceId`, `signKey` and `agreeKey`. The route takes a `VerifiedVouch`, which only this file
//    makes, from `NearbyPick.request`;
//  - `decision: deny` goes out only after a matched code (the licence choice cancelled). "None of these match"
//    (`ask.deny()`) and a wrong pick close the session and call no route;
//  - one pick per session: asking twice gives the first answer, never a second approve;
//  - the answer is given to the LAN session (`finish`), which sends the one `VOUCH_RESULT`; the 409 keys
//    registration retries once inside the route and never loops here, and a licence choice is asked at most as
//    often as the Worker asks;
//  - the wrap (V5 §13.11.3): once the Worker answered `approved`, and only if this device holds the root, M
//    seals the root to the new device's `agreeKey` from the verified `VOUCH_REQ` (and to no other key), sends
//    that wrap once as `KEYRING_WRAP`, and only then stores it (`PUT .../wraps/{deviceId}`: the server copy is
//    the fallback). A failure of either leaves the approval as it is;
//  - the request handle, the proofs and the token are in no description, mirror or error message.

import Foundation
import PolarisKeyCore

/// The LAN half of the approving device, as the Identity module reads it: `client.cloudConnect.nearby` on a
/// platform that can advertise on the network.
public protocol NearbyApproverLan: Sendable {
    func onRequest(_ handler: @escaping @Sendable (NearbyApproval) -> Void, options: NearbyApproverOptions)
        async throws -> NearbyApprover
}

/// Which side of nearby sign-in a device takes (`identity.nearby.available`).
public enum NearbyRole: String, Sendable, Equatable {
    /// D, the new device.
    case requester
    /// M, the signed-in device that approves.
    case approver
}

// MARK: - The permit and the route

/// The verified `VOUCH_REQ` of a session whose person picked the matching code. `nearby/approve` takes nothing
/// else: it is not built from a handle and keys by a host, and only the approver (below) makes one.
struct VerifiedVouch: Sendable, Equatable, CustomStringConvertible, CustomReflectable {
    let request: String
    let deviceId: String
    let signKey: String
    let agreeKey: String

    init(request: String, deviceId: String, signKey: String, agreeKey: String) {
        self.request = request
        self.deviceId = deviceId
        self.signKey = signKey
        self.agreeKey = agreeKey
    }

    init(_ v: VouchRequest) {
        self.init(request: v.request, deviceId: v.deviceId, signKey: v.signKey, agreeKey: v.agreeKey)
    }

    var description: String { "VerifiedVouch()" }
    var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// One `nearby/approve` answer (§12.11.5). Every variant carries what `finish` takes.
enum NearbyApproveAnswer: Sendable, Equatable {
    case approved(deviceLabel: String?, finish: VouchApproveAnswer)
    /// Nothing was written; M shows the choice and calls again with `choice`.
    case choose(choices: JSONValue, finish: VouchApproveAnswer)
    /// `204`: the denial is final.
    case denied(finish: VouchApproveAnswer)
    /// A 404 after a fresh discovery lost `nearby`: the routes are off.
    case unavailable(finish: VouchApproveAnswer)
    /// Any other status. `code` is the Worker's, else the status's registry code.
    case refused(status: Int, code: String, retryAfterSeconds: Int?, finish: VouchApproveAnswer)

    var finish: VouchApproveAnswer {
        switch self {
        case .approved(_, let f), .choose(_, let f), .denied(let f), .unavailable(let f), .refused(_, _, _, let f):
            return f
        }
    }
}

extension IdentityClient {
    /// `POST nearby/approve`: M's decision on D's request, with exactly the ids and keys it is given (the
    /// verified `VOUCH_REQ`'s). Needs M's bearer and its registered signing key: a `409 device_keys_required`
    /// registers the keys and retries once. A refusal is an answer, not a throw; only a missing endpoint, a
    /// missing sign-in and a local failure throw.
    func nearbyApprove(_ vouch: VerifiedVouch, decision: String, choice: JSONValue? = nil) async throws
        -> NearbyApproveAnswer
    {
        let url = try await nearbyEndpoint("nearbyApprove")
        guard let binding = nearbyBinding.current else {
            throw PolarisError(
                code: PolarisError.serviceUnavailable, message: "nearby approval is not set up on this client.")
        }
        guard let bearer = await core.token, !(await core.tokenUnconfirmed) else {
            throw PolarisError(
                code: ErrorCode.accountRequired, message: "Sign in before approving a nearby device.")
        }
        let (port, deviceId) = try await binding.signer()
        var retried = false
        while true {
            var body: [String: JSONValue] = [
                "request": .string(vouch.request), "deviceId": .string(vouch.deviceId),
                "signKey": .string(vouch.signKey), "agreeKey": .string(vouch.agreeKey),
                "decision": .string(decision),
            ]
            if let choice { body["choice"] = choice }
            body["proof"] = .string(
                try await nearbyProof(port, .nearbyApprove, deviceId: deviceId, value: vouch.request))
            let response: PolarisResponse
            do {
                response = try await core.request(
                    url, method: "POST",
                    headers: ["content-type": "application/json", "authorization": "Bearer \(bearer)"],
                    body: try JSONEncoder().encode(JSONValue.object(body)))
            } catch let error as PolarisError where error.code == PolarisError.localOnly {
                throw error
            } catch {
                // No answer: the caller closes (`finish` maps `http: nil`).
                return .refused(
                    status: 0, code: IdentityClient.networkError, retryAfterSeconds: nil,
                    finish: VouchApproveAnswer(http: nil, body: nil, discoveryNearby: true))
            }
            if response.status == 409, !retried, nearbyRefusalCode(response) == ErrorCode.deviceKeysRequired {
                retried = true
                try await nearbyRegisterKeys(port, deviceId: deviceId, bearer: bearer)
                continue
            }
            return await nearbyAnswer(response, keysRetried: retried)
        }
    }

    private func nearbyAnswer(_ response: PolarisResponse, keysRetried: Bool) async -> NearbyApproveAnswer {
        let raw = String(decoding: response.body, as: UTF8.self)
        func finish(_ discoveryNearby: Bool, _ body: String?) -> VouchApproveAnswer {
            VouchApproveAnswer(http: response.status, body: body, discoveryNearby: discoveryNearby)
        }
        if response.status == 204 { return .denied(finish: finish(true, nil)) }
        if response.status == 200 {
            let object = (try? JSONDecoder().decode(JSONValue.self, from: response.body))?.objectValue
            switch object?["status"]?.stringValue {
            case "approved":
                return .approved(deviceLabel: object?["deviceLabel"]?.stringValue, finish: finish(true, raw))
            case "choose":
                return .choose(choices: object?["choices"] ?? .null, finish: finish(true, raw))
            default:
                return .refused(
                    status: 200, code: ErrorCode.badResponse, retryAfterSeconds: nil,
                    finish: finish(true, raw.isEmpty ? nil : raw))
            }
        }
        let code = nearbyRefusalCode(response)
        // `finish` reads the code from a flat body; the Worker nests it. After the one keys retry a second
        // `device_keys_required` must close, not ask for another retry: it is reported under a code the
        // engine does not map.
        let reported =
            keysRetried && response.status == 409 && code == ErrorCode.deviceKeysRequired
            ? "device_keys_retried" : code
        let flat = String(
            decoding: (try? JSONEncoder().encode(JSONValue.object(["code": .string(reported)]))) ?? Data(),
            as: UTF8.self)
        let retryAfter = response.header("retry-after").flatMap {
            Int($0.trimmingCharacters(in: .whitespaces))
        }
        if response.status == 404 {
            // N11: the same bytes whether the request is unknown or the routes went away.
            do { _ = try await nearbyEndpoint("nearbyApprove", fresh: true) } catch {
                return .unavailable(finish: finish(false, flat))
            }
        }
        return .refused(
            status: response.status, code: code, retryAfterSeconds: retryAfter, finish: finish(true, flat))
    }

    /// `PUT /<p>/devices/keys` with the `keys` proof, for M's approval that asked for them.
    private func nearbyRegisterKeys(_ port: any DeviceKeyPort, deviceId: String, bearer: String) async throws {
        let request = try await DeviceProofs.keysRequest(
            port, product: core.product, deviceId: deviceId, issuedAt: await core.now())
        let response = try await core.request(
            core.endpoints.deviceKeys, method: "PUT",
            headers: ["content-type": "application/json", "authorization": "Bearer \(bearer)"],
            body: try JSONEncoder().encode(request.body))
        guard response.isOK else {
            throw PolarisError(
                code: nearbyRefusalCode(response), message: "this device's keys could not be registered.",
                status: response.status)
        }
    }
}

// MARK: - What the host sees

/// What the person picks at the licence choice.
public enum NearbyChoice: Sendable, Equatable {
    /// Give the new device this licence.
    case license(String)
    /// Give it a new licence.
    case create

    var json: JSONValue {
        switch self {
        case .license(let id): return .object(["kind": .string("license"), "licenseId": .string(id)])
        case .create: return .object(["kind": .string("create")])
        }
    }
}

/// The licence choice of an approval: the licences the person may give the new device, and two ways on.
public final class NearbyChoose: Sendable {
    /// The licences on offer, in the same shape the redirect sign-in's choice uses.
    public let choices: LicenseChoiceView

    private let decision: Decision
    private let asks: Int
    private let used = LockedValue(false)

    fileprivate init(choices: LicenseChoiceView, decision: Decision, asks: Int) {
        self.choices = choices
        self.decision = decision
        self.asks = asks
    }

    private func once(_ run: () async throws -> NearbyApprovalStep) async throws -> NearbyApprovalStep {
        let first = used.with { u -> Bool in
            if u { return false }
            u = true
            return true
        }
        guard first else {
            throw PolarisError(code: ErrorCode.invalidOptions, message: "This choice was already answered.")
        }
        return try await run()
    }

    /// Give the new device this licence (one tap per licence), or a new one.
    public func choose(_ choice: NearbyChoice) async throws -> NearbyApprovalStep {
        try await once { try await decision.run("approve", choice: choice.json, asks: asks + 1) }
    }

    /// Decline: the Worker records a denial and the new device is told.
    public func cancel() async throws -> NearbyApprovalStep {
        // The right code was tapped on this session, so the Worker may be told "deny".
        try await once { try await decision.run("deny", choice: nil, asks: asks + 1) }
    }
}

/// What happens after the person taps a code, or a choice.
public enum NearbyApprovalStep: Sendable {
    case approved
    /// The tapped code was not the one the new device shows: it was not signed in.
    case mismatch
    case notNearby
    case denied
    case expired
    case deviceLimit
    case accountRequired
    case rateLimited
    case choose(NearbyChoose)
}

/// A licence choice is asked again (a lost mint) at most this often in one pick.
private let nearbyMaxAsks = 3

/// One `nearby/approve` for the verified request, then the answer to the LAN session; and the wrap after it.
private final class Decision: Sendable {
    private let client: IdentityClient
    private let approval: NearbyApproval
    private let vouch: VerifiedVouch
    private let keyring: (any NearbyKeyring)?
    private let wrapped = LockedValue(false)

    init(client: IdentityClient, approval: NearbyApproval, vouch: VerifiedVouch, keyring: (any NearbyKeyring)?) {
        self.client = client
        self.approval = approval
        self.vouch = vouch
        self.keyring = keyring
    }

    /// Once, after `approved` (V5 §13.11.3): seal the wrap for the new device, send it over the channel, and only
    /// then store the same bytes on the Worker. A refused or failed `PUT` cannot take the channel copy with it,
    /// and a lost channel leaves the stored copy as the fallback.
    private func wrap() async {
        guard let ring = keyring, ring.unlocked else { return }
        let first = wrapped.with { w -> Bool in
            if w { return false }
            w = true
            return true
        }
        guard first else { return }
        // The ids and the key are the verified request's, which `approve` just confirmed.
        guard let record = try? await ring.sealWrapTo(deviceId: vouch.deviceId, agreeKey: vouch.agreeKey) else {
            return  // No wrap (a locked ring): the approval stands.
        }
        try? await approval.sendRecord(type: nearbyKeyringWrapRecord, body: record)
        // A conflict or the network: the channel copy, if it arrived, still stands.
        try? await ring.putWrap(deviceId: vouch.deviceId, record: record)
    }

    private static func step(_ a: NearbyApproveAnswer) -> NearbyApprovalStep {
        switch a {
        case .approved: return .approved
        case .denied: return .denied
        case .unavailable, .choose: return .expired
        case .refused(_, let code, _, _):
            switch code {
            case ErrorCode.notNearby: return .notNearby
            case ErrorCode.deviceLimit: return .deviceLimit
            case ErrorCode.accountRequired, ErrorCode.unauthorized: return .accountRequired
            case ErrorCode.rateLimited: return .rateLimited
            default: return .expired
            }
        }
    }

    func run(_ decision: String, choice: JSONValue?, asks: Int) async throws -> NearbyApprovalStep {
        let answer: NearbyApproveAnswer
        do {
            answer = try await client.nearbyApprove(vouch, decision: decision, choice: choice)
        } catch let error as PolarisError {
            // Nothing to answer with: the session closes and the person is told what it was.
            await approval.close()
            return error.code == ErrorCode.accountRequired ? .accountRequired : .expired
        }
        let out: NearbyFinish
        do {
            out = try await approval.finish(answer.finish)
        } catch NearbyError.closed {
            // The LAN session ended meanwhile. The Worker's answer stands: an approval is an approval, and the
            // new device's own poll signs it in. The stored wrap is the fallback for the lost channel.
            if case .approved = answer { await wrap() }
            return Self.step(answer)
        }
        switch out {
        case .waitChoice, .waitKeys:
            if case .waitChoice = out, asks < nearbyMaxAsks {
                if case .choose(let choices, _) = answer, let view = Self.view(choices) {
                    return .choose(NearbyChoose(choices: view, decision: self, asks: asks))
                }
                // A lost mint (409): ask again for the licences, with no choice, to show them afresh.
                if decision == "approve" { return try await run("approve", choice: nil, asks: asks + 1) }
            }
            // A choice nobody can show, or a retry the route already spent: end it.
            await approval.close()
            return .expired
        case .sent, .closed:
            if case .approved = answer { await wrap() }
            return Self.step(answer)
        }
    }

    private static func view(_ choices: JSONValue) -> LicenseChoiceView? {
        guard let data = try? JSONEncoder().encode(choices) else { return nil }
        return try? JSONDecoder().decode(LicenseChoiceView.self, from: data)
    }
}

/// One session asking for approval, as the host's handler sees it.
public final class NearbyAsk: Sendable, CustomStringConvertible, CustomReflectable {
    /// The new device's name, as it reports it (unverified: show it as reported by the device).
    public let device: String?
    public let platform: String
    /// The three codes in the order to show, each like `123 456`.
    public let codes: [String]

    private let client: IdentityClient
    private let approval: NearbyApproval
    private let keyring: (any NearbyKeyring)?
    private let state = LockedValue(State())

    private struct State {
        var picked: Task<NearbyApprovalStep, Error>?
        var denied = false
    }

    fileprivate init(client: IdentityClient, approval: NearbyApproval, keyring: (any NearbyKeyring)?) {
        self.client = client
        self.approval = approval
        self.keyring = keyring
        self.device = approval.label.flatMap { PeerDisplay.cleanLabel($0) }
        self.platform = approval.platform
        self.codes = approval.codes
    }

    public var description: String { "NearbyAsk()" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }

    /// The person tapped this code. A wrong one closes the session (`.mismatch`); the right one, with a verified
    /// request, asks the Worker. Asking twice gives the first answer.
    public func pick(_ code: String) async throws -> NearbyApprovalStep {
        let task = try state.with { s -> Task<NearbyApprovalStep, Error> in
            if let t = s.picked { return t }
            if s.denied { throw PolarisError(code: ErrorCode.invalidOptions, message: "Already denied.") }
            let t = Task { [client, approval, keyring] in
                switch try await approval.pick(code) {
                case .mismatch: return NearbyApprovalStep.mismatch
                // The request did not verify: nothing was approved, and the session is closed.
                case .invalid: return .expired
                // The matched code and the verified request earn the permit; nothing else does.
                case .request(let request):
                    return try await Decision(
                        client: client, approval: approval, vouch: VerifiedVouch(request), keyring: keyring
                    ).run("approve", choice: nil, asks: 1)
                }
            }
            s.picked = t
            return t
        }
        return try await task.value
    }

    /// "None of these match": the session closes, nothing is approved and no route is called.
    public func deny() async {
        let go = state.with { s -> Bool in
            if s.picked != nil || s.denied { return false }
            s.denied = true
            return true
        }
        if go { await approval.decline() }
    }

    /// Called once when the session ends (it expired or the peer left). Returns the remover.
    @discardableResult
    public func onEnd(_ fn: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        approval.onClose { _ in fn() }
    }
}

// MARK: - The namespace

/// `client.identity.nearby`: nearby approval on the approving side, and whether a device can take part.
public struct NearbyNamespace: Sendable {
    let client: IdentityClient

    /// True when Identity is on, discovery names `nearby` and the role's endpoints, and this runtime can use
    /// the network. Never throws.
    public func available(role: NearbyRole) async -> Bool {
        guard let binding = client.nearbyBinding.current, await client.core.enabled(.identity),
            let fragment = await client.core.discoveryDocument?.identity, fragment.nearby
        else { return false }
        switch role {
        case .requester:
            return binding.lan?() != nil
                && [fragment.nearbyStart, fragment.nearbyPoll].allSatisfy { ($0 ?? "").isEmpty == false }
        case .approver:
            return binding.approver?() != nil && (fragment.nearbyApprove ?? "").isEmpty == false
        }
    }

    /// M, a signed-in device: advertise while the person has "Approve a nearby device" open (`prompt: true`), or
    /// has allowed background approval (`prompt: false`, `background: true`), and hand each session that reaches
    /// the code to `handler` as an ask. Returns the handle that stops, pauses and resumes it. Throws
    /// `account_required` when signed out, `nearby-unsupported` when this runtime cannot advertise, and the
    /// typed N/A when nearby approval is not served. Signing out stops it.
    public func onRequest(
        _ options: NearbyApproverOptions, handler: @escaping @Sendable (NearbyAsk) -> Void
    ) async throws -> NearbyApprover {
        guard let binding = client.nearbyBinding.current else {
            throw PolarisError(
                code: PolarisError.serviceUnavailable, message: "nearby approval is not set up on this client.")
        }
        guard let lan = binding.approver?() else {
            let u = Unsupported(
                feature: Feature.identityNearby, reason: UnsupportedReason.runtime,
                detail: "this runtime cannot advertise to nearby devices")
            throw PolarisError(
                code: ErrorCode.nearbyUnsupported, message: "Nearby approval is not available here.",
                detail: u.detail, unsupported: u)
        }
        var o = options
        // This device's name in the other device's list (§12.7.1); never an account identifier.
        if o.label == nil, let label = await client.core.deviceLabel(nil), !label.isEmpty { o.label = label }
        let client = client
        let keyring = binding.keyring?()
        return try await lan.onRequest(
            { approval in handler(NearbyAsk(client: client, approval: approval, keyring: keyring)) }, options: o)
    }
}

extension IdentityClient {
    /// Nearby approval on this device: `nearby.onRequest(_:handler:)` (M) and `nearby.available(role:)`.
    public var nearby: NearbyNamespace { NearbyNamespace(client: self) }
}
