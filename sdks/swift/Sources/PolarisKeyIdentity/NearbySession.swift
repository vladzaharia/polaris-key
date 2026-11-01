// `identity.signIn.startNearby(_:)` (WIRE-CONTRACT-V5 §12.11.5, §15.6.1): the new device D signs in because a
// signed-in device M nearby approves it. The session joins the two halves: the HTTP routes (NearbyRoutes.swift:
// `start`, `poll`) and the LAN request the Connect code built (`NearbyRequester`: the approvers D lists, the
// code D shows, `VOUCH_REQ`). Mirrors sdk-node's `identity/nearbySession.ts`.
//
//   session.approvers / onApprovers(_:)  who answered nearby: id, cleaned label, platform
//   session.choose(_:)                   the person tapped one; answers the code to show (`482 913`)
//   session.code                         the code on screen once chosen
//   session.result / onResult(_:)        what `VOUCH_RESULT` said. Display only
//   session.wait()                       the paced poll: `.signedIn`, `.expired` or `.cancelled`;
//                                        a refusal throws `sign-in-denied`
//   session.confirmAccount()             the person saw the signed-in account and says it is theirs
//   session.declineAccount()             it is not: the held records are dropped and the device signs out
//   session.wrap / onWrap(_:)            what became of the KEYRING_WRAP M sent: none, applied or refused
//   session.cancel()                     stop; the LAN request closes
//   session.ended / onEnd(_:)            the sign-in ended unconfirmed (decline, cancel, the 300 s deadline)
//
// Rules this file keeps:
//  - the order is `start`, then the LAN request, and the poll is paced from `start`: the first poll is one
//    interval after it. The poll decides the outcome: a token is `.signedIn`, `timeout` is `.expired`,
//    `access_denied` throws `sign-in-denied`. `VOUCH_RESULT` never signs anyone in and never ends the wait;
//  - one answer: the first terminal outcome (or refusal) is kept and every later `wait()` gets the same;
//  - an unsupported runtime never calls a route for it: the LAN probe runs before `nearby/start`;
//  - unconfirmed until `confirmAccount()` (§15.6.1 rule 12): the token is held under the unconfirmed mark. A
//    decline, a `cancel()` or the `expiresIn`-second deadline (a monotonic timer, from the moment the poll
//    answered) discards the session ONCE (idempotent, serialized): the held records are dropped, the LAN request
//    declines and closes, the Worker is asked to sign out (best effort), and whatever it answered the
//    credential, its mark and its documents go locally. A `ready` poll that lands after such an end discards at
//    once. The peer closing the LAN session is deliberately NOT an end: M closes right after `approved`;
//  - confirm and the deadline decide under one lock, so exactly one of them wins; the discard and the confirm act
//    only on the token THIS session's poll stored (a later sign-in made another way is left alone);
//  - the stored subject, the `signedIn` event (and so Cloud Sync and Connect) and the end of the explicit
//    sign-out state wait for `confirmAccount()`; a confirm after the end throws `sign-in-failed`;
//  - records `0x0030` to `0x003F` reach the session only after `confirmAccount()` (the engine holds them: rule
//    12). `KEYRING_WRAP` (0x0030) is kept and opened through the key ring, once, after the confirmation; the
//    others are not this session's. Without a key ring the wrap is dropped and `unlock()` works later from the
//    server copy;
//  - the request handle, the proofs, the token and the code are in no description, mirror or error message.

import Foundation
import PolarisKeyCore

/// What `signIn.startNearby` takes.
public struct NearbySignInOptions: Sendable {
    /// The device label the approver is shown (§12.7.1 and `HELLO`), else the client's default.
    public var deviceName: String?

    public init(deviceName: String? = nil) { self.deviceName = deviceName }
}

/// `KEYRING_WRAP`, the Sync record that carries a wrap of the root over the nearby channel.
let nearbyKeyringWrapRecord = 0x0030

/// One approver D can pick. Display data from an unverified peer: any device on the network can list itself
/// under any label.
public struct NearbyApproverEntry: Sendable, Equatable {
    public let id: String
    public let label: String?
    public let platform: String
}

/// The LAN request, as the session reads it. `NearbyRequester` is the one implementation; a test brings its own.
public protocol NearbyRequestHandle: Sendable {
    func approvers() async -> [NearbyApproverInfo]
    func result() async -> VouchStatus?
    func choose(_ id: String) async throws -> String
    func confirmAccount() async throws
    func declineAccount() async
    func close() async
    func onApprovers(_ fn: @escaping @Sendable ([NearbyApproverInfo]) -> Void) -> @Sendable () -> Void
    func onResult(_ fn: @escaping @Sendable (VouchStatus) -> Void) -> @Sendable () -> Void
    func onRecord(_ fn: @escaping @Sendable (NearbyRecord) -> Void) -> @Sendable () -> Void
}

extension NearbyRequester: NearbyRequestHandle {}

/// The LAN half of nearby sign-in, as the Identity module reads it: `client.cloudConnect.nearby` on a platform
/// that can browse the network.
public protocol NearbySignInLan: Sendable {
    func request(_ options: NearbyRequestOptions) async throws -> any NearbyRequestHandle
}

/// What became of the `KEYRING_WRAP` M sent over the LAN.
public enum NearbyWrapState: String, Sendable, Equatable {
    /// None has arrived, or it is not yet taken.
    case none
    /// The key ring opened it: the device holds the root.
    case applied
    /// The key ring did not take it (another ring, a wrap that did not open, the Worker unreachable).
    case refused
}

/// The Cloud Sync key ring, as nearby sign-in uses it: D opens the wrap M sent, M seals one for D. The umbrella
/// hands `client.keyring` over; a test brings its own.
public protocol NearbyKeyring: Sendable {
    /// Whether this device holds the root now.
    var unlocked: Bool { get }
    /// D: take the `KEYRING_WRAP` record (strict JSON). True when the device holds the root afterwards.
    func adoptWrap(_ record: Data) async throws -> Bool
    /// M: seal the root to `agreeKey` for `deviceId`; nothing is stored. The record's bytes.
    func sealWrapTo(deviceId: String, agreeKey: String) async throws -> Data
    /// M: store the wrap `sealWrapTo` made (`PUT .../wraps/{deviceId}`): the fallback when the channel copy is lost.
    func putWrap(deviceId: String, record: Data) async throws
}

/// What nearby sign-in needs of the rest of the client (`installNearby`).
public struct NearbyBinding: Sendable {
    /// D's device keys (made when none exist) and its `X-PKey-Device` value.
    public var signer: @Sendable () async throws -> (port: any DeviceKeyPort, deviceId: String)
    /// The LAN half; nil where this runtime cannot browse the network (the typed `nearby-unsupported`).
    public var lan: (@Sendable () -> (any NearbySignInLan)?)?
    /// The deadline's clock (a test injects its own).
    public var timer: NearbyTimer
    /// The LAN half of the approving device M; nil where this runtime cannot advertise on the network.
    public var approver: (@Sendable () -> (any NearbyApproverLan)?)?
    /// The Cloud Sync key ring; nil leaves the wrap alone (D drops it, M sends none).
    public var keyring: (@Sendable () -> (any NearbyKeyring)?)?

    public init(
        signer: @escaping @Sendable () async throws -> (port: any DeviceKeyPort, deviceId: String),
        lan: (@Sendable () -> (any NearbySignInLan)?)?, timer: @escaping NearbyTimer = nearbySystemTimer,
        approver: (@Sendable () -> (any NearbyApproverLan)?)? = nil,
        keyring: (@Sendable () -> (any NearbyKeyring)?)? = nil
    ) {
        self.signer = signer
        self.lan = lan
        self.timer = timer
        self.approver = approver
        self.keyring = keyring
    }
}

extension IdentityClient {
    /// Hand over what nearby sign-in needs. The umbrella does it when it builds the client; nil removes it.
    public func installNearby(_ binding: NearbyBinding?) { nearbyBinding.set(binding) }

    /// Whether this device can take part in nearby sign-in as D: the runtime can browse the network and the
    /// product's discovery names nearby approval and its routes. No request is made.
    public func nearbyAvailable() async -> Bool {
        guard nearbyBinding.current?.lan?() != nil, await core.enabled(.identity) else { return false }
        guard let fragment = await core.discoveryDocument?.identity, fragment.nearby else { return false }
        return [fragment.nearbyStart, fragment.nearbyPoll].allSatisfy { ($0 ?? "").isEmpty == false }
    }

    /// Whether this token is still the one the credential store holds (a later sign-in replaces it).
    func nearbyHolds(_ token: String) async -> Bool { await core.token == token }

    /// The person confirmed the account: the token is a sign-in (the explicit sign-out state ends), the subject
    /// is stored and the event goes out, so Cloud Sync and Connect start now and not before (§12.11.5 rule 9).
    func nearbyConfirm(subject: String) async throws {
        let previous = holdSubjectFirst(subject)
        do { try await core.confirmToken() } catch {
            restoreSubject(previous, ifHeld: subject)
            throw error
        }
        announceSubject(subject, previous: previous)
        notifyIdentity(IdentityChange(kind: IdentityChange.signedIn, subject: subject))
        await restoreSignInCompleted()
    }

    /// An unconfirmed nearby sign-in ended: the token, its mark and the documents it fetched go, whatever the
    /// Worker answered to the sign-out. The token goes before its mark.
    func nearbyDropLocal() async {
        if let wipe = signOutHook.current { try? await wipe() } else { try? await core.clearAll() }
    }
}

extension SignInNamespace {
    /// Begin a nearby sign-in on this device (D). Refuses before anything is sent when it cannot run:
    /// `nearby-unsupported` when this runtime cannot browse the network, the typed `service-unavailable` N/A
    /// when the product's discovery names no nearby approval. Then `nearby/start`, then the LAN request (a
    /// failure there leaves the Worker's request to lapse), polling from the start.
    public func startNearby(_ options: NearbySignInOptions = NearbySignInOptions()) async throws
        -> NearbySignInSession
    {
        try await client.startNearbySignIn(options)
    }
}

extension IdentityClient {
    func startNearbySignIn(_ options: NearbySignInOptions) async throws -> NearbySignInSession {
        guard let binding = nearbyBinding.current, let lan = binding.lan?() else {
            // An unsupported runtime never calls a route for it (§15.6.1 rule 10).
            let u = Unsupported(
                feature: Feature.identityNearby, reason: UnsupportedReason.runtime,
                detail: "this runtime cannot look for nearby devices")
            throw PolarisError(
                code: ErrorCode.nearbyUnsupported, message: "Nearby sign-in is not available here.",
                detail: u.detail, unsupported: u)
        }
        let started = try await nearbyStart(deviceName: options.deviceName)
        let label = await core.deviceLabel(options.deviceName)
        let request: any NearbyRequestHandle
        do {
            request = try await lan.request(
                NearbyRequestOptions(request: started.request, label: label, expiresIn: TimeInterval(started.expiresIn))
            )
        } catch let error as NearbyError {
            throw PolarisError(code: error.code, message: "Nearby sign-in could not look for devices.")
        }
        return NearbySignInSession(
            client: self, started: started, request: request, label: label,
            expiresAt: await core.now() + started.expiresIn,
            timer: binding.timer)
    }
}

/// A gate that lets one `wait()` poll at a time.
private actor NearbyWaitGate {
    private var busy = false
    private var queue: [CheckedContinuation<Void, Never>] = []

    func enter() async {
        if !busy {
            busy = true
            return
        }
        await withCheckedContinuation { queue.append($0) }
    }

    func leave() {
        if queue.isEmpty {
            busy = false
        } else {
            queue.removeFirst().resume()
        }
    }
}

public final class NearbySignInSession: Sendable, CustomStringConvertible, CustomReflectable {
    private enum Final {
        case outcome(SignInOutcome)
        case failure(Error)
    }

    private struct State {
        var interval: Int
        var code: String?
        var cancelled = false
        var final: Final?
        var signedIn = false
        var confirmed = false
        var ended = false
        var token: String?
        var subject: String?
        var deadline: (@Sendable () -> Void)?
        var discarding: Task<Void, Never>?
        var lanOpen = true
        var lanDeclined = false
        /// The next poll is not before this (system uptime, seconds): the pacing starts at `start`.
        var notBefore: TimeInterval
        var sleeper: Task<Void, Error>?
        var onEnd: [Int: @Sendable () -> Void] = [:]
        var nextListener = 0
        /// The `KEYRING_WRAP` held until the account is confirmed (zeroed when taken or dropped).
        var wrapRecord: Data?
        var wrapState = NearbyWrapState.none
        var onWrap: [Int: @Sendable (NearbyWrapState) -> Void] = [:]
        var nextWrapListener = 0
        var applying: Task<Void, Never>?
        var removers: [@Sendable () -> Void] = []
    }

    /// The channel this session runs on.
    public let channel = "nearby"
    /// Seconds the request lives, as the Worker said (300).
    public let expiresIn: Int
    /// When the request lapses on THIS client's clock (epoch seconds).
    public let expiresAt: Int
    /// The label D sent, or nil.
    public let deviceName: String?

    private let client: IdentityClient
    private let started: NearbyStarted
    private let request: any NearbyRequestHandle
    private let timer: NearbyTimer
    private let state: LockedValue<State>
    private let gate = NearbyWaitGate()

    init(
        client: IdentityClient, started: NearbyStarted, request: any NearbyRequestHandle, label: String?,
        expiresAt: Int, timer: @escaping NearbyTimer
    ) {
        self.client = client
        self.started = started
        self.request = request
        self.timer = timer
        self.expiresIn = started.expiresIn
        self.expiresAt = expiresAt
        self.deviceName = label
        self.state = LockedValue(
            State(interval: started.interval, notBefore: Self.uptime() + TimeInterval(started.interval)))
        // The engine hands records over only after `confirmAccount()`; a wrap that comes later than the
        // confirmation is taken as it arrives.
        let remove = request.onRecord { [weak self] record in self?.received(record) }
        state.with { $0.removers.append(remove) }
    }

    private func received(_ record: NearbyRecord) {
        guard record.type == nearbyKeyringWrapRecord else { return }
        let apply = state.with { s -> Bool in
            // Dropped sessions keep nothing.
            if s.ended { return false }
            s.wrapRecord = record.body
            return s.confirmed
        }
        if apply { applyWrap() }
    }

    /// What became of the wrap M sent: `.none` until one arrives and is taken (or refused).
    public var wrap: NearbyWrapState { state.with { $0.wrapState } }

    /// Called with the wrap's state when it is settled. Returns the remover.
    @discardableResult
    public func onWrap(_ fn: @escaping @Sendable (NearbyWrapState) -> Void) -> @Sendable () -> Void {
        let id = state.with { s -> Int in
            s.nextWrapListener += 1
            s.onWrap[s.nextWrapListener] = fn
            return s.nextWrapListener
        }
        return { [state] in state.with { _ = $0.onWrap.removeValue(forKey: id) } }
    }

    /// Open the held wrap through the key ring (once), never throwing into the LAN callback.
    private func applyWrap() {
        let taken = state.with { s -> Data? in
            let r = s.wrapRecord
            s.wrapRecord = nil
            return r
        }
        guard let record = taken else { return }
        // No key ring here: the wrap is dropped, and the normal `unlock()` works later.
        guard let ring = client.nearbyBinding.current?.keyring?() else { return }
        state.with { s in
            let previous = s.applying
            s.applying = Task { [self] in
                await previous?.value
                var result = NearbyWrapState.refused
                // The ring refused or the Worker could not be asked: the device stays locked.
                if let unlocked = try? await ring.adoptWrap(record), unlocked { result = .applied }
                let listeners = state.with { s -> [@Sendable (NearbyWrapState) -> Void] in
                    s.wrapState = result
                    return Array(s.onWrap.values)
                }
                for f in listeners { f(result) }
                // Nothing else is expected on the channel once the wrap is in.
                if result == .applied { await closeLan() }
            }
        }
    }

    public var description: String {
        "NearbySignInSession(channel: nearby, chosen: \(code != nil), expiresIn: \(expiresIn))"
    }
    public var customMirror: Mirror {
        Mirror(self, children: ["channel": channel, "expiresIn": expiresIn], displayStyle: .class)
    }

    private static func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    // MARK: The approvers and the code

    /// The minimum seconds between polls; a `slow_down` lengthens it.
    public var interval: Int { state.with { $0.interval } }

    /// The code on screen (`482 913`) once an approver is chosen, else nil.
    public var code: String? { state.with { $0.code } }

    /// The approvers that answered, at most 8, labels cleaned.
    public func approvers() async -> [NearbyApproverEntry] { Self.clean(await request.approvers()) }

    /// Called with the list whenever it changes. Returns the remover.
    @discardableResult
    public func onApprovers(_ fn: @escaping @Sendable ([NearbyApproverEntry]) -> Void) -> @Sendable () -> Void {
        request.onApprovers { fn(Self.clean($0)) }
    }

    /// What `VOUCH_REQ`'s answer said, for display only: the poll is the authority.
    public func result() async -> VouchStatus? { await request.result() }

    @discardableResult
    public func onResult(_ fn: @escaping @Sendable (VouchStatus) -> Void) -> @Sendable () -> Void {
        request.onResult(fn)
    }

    /// The person tapped this approver. Answers the code to show; the request goes out once it is shown.
    public func choose(_ id: String) async throws -> String {
        let over = state.with { $0.final != nil || $0.cancelled }
        if over { throw PolarisError(code: ErrorCode.signInFailed, message: "The sign-in is over.") }
        let code = try await request.choose(id)
        state.with { $0.code = code }
        return code
    }

    private static func clean(_ list: [NearbyApproverInfo]) -> [NearbyApproverEntry] {
        list.map {
            NearbyApproverEntry(
                id: $0.id, label: $0.label.flatMap { PeerDisplay.cleanLabel($0) },
                platform: PeerDisplay.cleanPlatform($0.platform))
        }
    }

    // MARK: The end

    /// True once the sign-in ended unconfirmed (a decline, a cancel, the deadline).
    public var ended: Bool { state.with { $0.ended } }

    /// Called once when the sign-in ends unconfirmed, so a screen can leave; at once when it already ended.
    @discardableResult
    public func onEnd(_ fn: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        let (id, already) = state.with { s -> (Int, Bool) in
            if s.ended { return (0, true) }
            s.nextListener += 1
            s.onEnd[s.nextListener] = fn
            return (s.nextListener, false)
        }
        if already {
            fn()
            return {}
        }
        return { [state] in state.with { _ = $0.onEnd.removeValue(forKey: id) } }
    }

    /// Stop. A running `wait()` answers `.cancelled`; the request simply lapses on the Worker. After `.signedIn`
    /// and before the confirmation it also signs the device out.
    public func cancel() {
        let discard = halt().discard
        Task { await closeLan() }
        if discard { _ = discardOnce() }
    }

    /// The end of this sign-in: no further poll is honoured, the deadline stops and listeners hear of it (once,
    /// and only while unconfirmed). `acted` is false when `onlyUnconfirmed` and the sign-in was already
    /// confirmed or over; `discard` is true when a signed-in, unconfirmed session must now be discarded.
    @discardableResult
    private func halt(onlyUnconfirmed: Bool = false) -> (acted: Bool, discard: Bool) {
        let step = state.with {
            s -> (
                acted: Bool, listeners: [@Sendable () -> Void], deadline: (@Sendable () -> Void)?,
                sleeper: Task<Void, Error>?, discard: Bool
            ) in
            if onlyUnconfirmed && (s.confirmed || s.ended) { return (false, [], nil, nil, false) }
            s.cancelled = true
            let deadline = s.deadline
            s.deadline = nil
            let sleeper = s.sleeper
            if s.ended || s.confirmed { return (true, [], deadline, sleeper, false) }
            s.ended = true
            let l = Array(s.onEnd.values)
            s.onEnd = [:]
            return (true, l, deadline, sleeper, s.signedIn)
        }
        step.deadline?()
        step.sleeper?.cancel()
        for l in step.listeners { l() }
        return (step.acted, step.discard)
    }

    /// The confirm screen's deadline: `expiresIn` seconds from the moment the poll answered, on the timer clock
    /// (monotonic), not on a wall clock the host could move.
    private func armDeadline() {
        let cancel = timer(TimeInterval(expiresIn)) { [weak self] in self?.deadlineFired() }
        let kept = state.with { s -> Bool in
            if s.cancelled || s.confirmed { return false }
            s.deadline = cancel
            return true
        }
        if !kept { cancel() }
    }

    private func deadlineFired() {
        // Decided under the lock `confirmAccount` takes: whichever got here first wins.
        let step = halt(onlyUnconfirmed: true)
        guard step.acted else { return }
        Task { await closeLan() }
        if step.discard { _ = discardOnce() }
    }

    /// The one end path for an unconfirmed sign-in; idempotent and serialized. The LAN request declines and
    /// closes, the Worker is asked to sign out as a best effort, and whatever it answered the credential, its
    /// mark and its documents go. Only this session's own token is touched.
    @discardableResult
    private func discardOnce() -> Task<Void, Never> {
        state.with { s in
            let previous = s.discarding
            let run = Task { [self] in
                await previous?.value
                let declineLan = state.with { s -> Bool in
                    let first = !s.lanDeclined
                    s.lanDeclined = true
                    return first
                }
                if declineLan { await request.declineAccount() }
                // Whatever was held for the key ring goes with the sign-in.
                state.with { $0.wrapRecord = nil }
                await closeLan()
                let token = state.with { s -> String? in
                    let t = s.token
                    s.token = nil
                    return t
                }
                guard let token else { return }
                guard await client.nearbyHolds(token) else {
                    // Another sign-in holds the device now: this session ends without touching it.
                    state.with { $0.signedIn = false }
                    return
                }
                _ = try? await client.signOut()
                await client.nearbyDropLocal()
                state.with { $0.signedIn = false }
            }
            s.discarding = run
            return run
        }
    }

    private func closeLan() async {
        let was = state.with { s -> Bool in
            let w = s.lanOpen
            s.lanOpen = false
            return w
        }
        let removers = state.with { s -> [@Sendable () -> Void] in
            let r = s.removers
            s.removers = []
            return r
        }
        if was {
            // A wrap that is still being opened keeps its subscription's callback; none new arrives.
            for r in removers { r() }
            await request.close()
        }
    }

    // MARK: The wait

    /// Poll until the sign-in settles. The first terminal answer is kept: a later call gets the same one (the
    /// token is handed over once). Throws a `SignInError` (`sign-in-denied`) when M refused, `service-unavailable`
    /// when the routes went away, and `CancellationError` when the calling task is cancelled (the session keeps
    /// going; call `cancel()` to end it).
    public func wait() async throws -> SignInOutcome {
        await gate.enter()
        do {
            let outcome = try await waitLocked()
            await gate.leave()
            return outcome
        } catch {
            await gate.leave()
            throw error
        }
    }

    private func settled(_ f: Final) throws -> SignInOutcome {
        switch f {
        case .outcome(let o): return o
        case .failure(let e): throw e
        }
    }

    private func waitLocked() async throws -> SignInOutcome {
        while true {
            if let f = state.with({ $0.final }) { return try settled(f) }
            if let early = try await pace() { return early }
            try Task.checkCancellation()
            let poll: NearbyPoll
            do {
                poll = try await client.nearbyPoll(started)
            } catch let transient as NearbyTransient {
                // Ride out a transient failure at the current interval, or the Worker's Retry-After.
                state.with { s in
                    s.notBefore = Self.uptime() + TimeInterval(max(s.interval, transient.retryAfterSeconds ?? 0))
                }
                continue
            }
            state.with { s in s.notBefore = Self.uptime() + TimeInterval(s.interval) }
            if case .ready(let ready) = poll {
                // The poll stored the token (unconfirmed). A decline or cancel that got in before this answer
                // discards it at once; nothing is handed to the caller.
                let cancelled = state.with { s -> Bool in
                    s.signedIn = true
                    s.token = ready.token
                    s.subject = ready.subject
                    return s.cancelled
                }
                if cancelled {
                    await discardOnce().value
                    return .cancelled
                }
                armDeadline()
                return await end(
                    .signedIn(
                        SignInReady(
                            identity: ready.identity, subject: ready.subject, scope: ready.scope,
                            licenseId: ready.licenseId)))
            }
            if state.with({ $0.cancelled }) { return .cancelled }
            switch poll {
            case .ready, .pending: continue
            case .timeout: return await end(.expired)
            case .denied:
                throw await fail(SignInError(code: ErrorCode.signInDenied, message: "nearby sign-in was refused."))
            case .unavailable:
                throw await fail(
                    PolarisError(
                        code: ErrorCode.serviceUnavailable,
                        message: "this product no longer serves nearby sign-in."))
            case .slowDown(let next):
                state.with { s in
                    s.interval = max(s.interval, next)
                    s.notBefore = Self.uptime() + TimeInterval(s.interval)
                }
            }
        }
    }

    /// The outcome that ends the session before a poll (cancelled, lapsed), else nil; then the wait.
    private func pace() async throws -> SignInOutcome? {
        if state.with({ $0.cancelled }) { return .cancelled }
        if await client.core.now() >= expiresAt { return await end(.expired) }
        let lead = max(0, state.with { $0.notBefore } - Self.uptime())
        let seconds = min(lead, TimeInterval(expiresIn))
        if seconds > 0 {
            let sleeper = Task { try await client.sleepFor(seconds) }
            state.with { $0.sleeper = sleeper }
            do {
                try await withTaskCancellationHandler {
                    try await sleeper.value
                } onCancel: {
                    sleeper.cancel()
                }
            } catch {
                state.with { $0.sleeper = nil }
                if state.with({ $0.cancelled }) { return .cancelled }
                throw error
            }
            state.with { $0.sleeper = nil }
        }
        if state.with({ $0.cancelled }) { return .cancelled }
        if await client.core.now() >= expiresAt { return await end(.expired) }
        return nil
    }

    /// Keep a terminal outcome; everything but a sign-in closes the LAN half now.
    private func end(_ o: SignInOutcome) async -> SignInOutcome {
        state.with { $0.final = .outcome(o) }
        if case .signedIn = o { return o }
        await closeLan()
        return o
    }

    private func fail(_ e: Error) async -> Error {
        state.with { $0.final = .failure(e) }
        await closeLan()
        return e
    }

    // MARK: The person's decision

    /// The person has seen the signed-in account (`wait()` answered `.signedIn` with the identity) and says it
    /// is theirs (§15.6.1 rule 12). Only now does the engine hand over the records M sent. Throws `sign-in-failed`
    /// when the sign-in ended first, or when the device is not signed in. Decided under one lock with the
    /// deadline, so exactly one of them wins.
    public func confirmAccount() async throws {
        enum Decision {
            case ended, notSignedIn, already
            case go(token: String?, subject: String)
        }
        let decision = state.with { s -> Decision in
            if s.ended { return .ended }
            guard s.signedIn, let subject = s.subject else { return .notSignedIn }
            if s.confirmed { return .already }
            s.confirmed = true
            let deadline = s.deadline
            s.deadline = nil
            deadline?()
            return .go(token: s.token, subject: subject)
        }
        switch decision {
        case .ended:
            throw PolarisError(
                code: ErrorCode.signInFailed, message: "The sign-in ended before it was confirmed.")
        case .notSignedIn:
            throw PolarisError(
                code: ErrorCode.signInFailed, message: "Nothing to confirm: the device is not signed in.")
        case .already:
            return
        case .go(let token, let subject):
            guard let token, await client.nearbyHolds(token) else {
                // A later sign-in replaced this one's token: nothing of it is written, nothing signed out.
                state.with { $0.confirmed = false }
                halt()
                await closeLan()
                _ = discardOnce()
                throw PolarisError(
                    code: ErrorCode.signInFailed, message: "The sign-in ended before it was confirmed.")
            }
            do { try await client.nearbyConfirm(subject: subject) } catch {
                state.with { $0.confirmed = false }
                throw error
            }
            // The chosen session is gone: no records, the server copy is the fallback.
            try? await request.confirmAccount()
            // A wrap the engine just handed over (or one that came before the confirmation) is taken now.
            if state.with({ $0.wrapRecord != nil }) { applyWrap() }
        }
    }

    /// The account is not the person's: every held record is dropped, the LAN half closes and the device signs
    /// out (rule 12). Safe to call more than once.
    public func declineAccount() async {
        halt()
        await discardOnce().value
    }
}
