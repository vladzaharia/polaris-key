// @pkey-feature connect.local
// `LocalPairingModel` (CC-29K): the state machine behind Pair with a Code, over `LocalLinksDriver`.
// The reference is packages/ui-core/src/localPairingModel.ts; the rules are the same:
//
//   choose -> show (closed) | enter (joining, waiting) -> confirm -> paired | failed
//
//   - show: the window runs from `expiresAt`; a wrong guess changes the code (the changed digits are
//     lit, the new code announced); an end of `too-many-tries` closes it and a new code waits 30 s
//     (the SDK enforces the same floor and rejects `cooldown`, which waits out the rest); a window
//     that ran out waits for nothing;
//   - the second `too-many-tries` in a row, or 5 wrong codes over renewed windows with no pairing,
//     warns that someone nearby may be guessing codes (D4);
//   - enter: Pair is unavailable with fewer than 8 digits, a prefix with no dial left, or the very
//     code that just failed; pressing it answers its reason under the field. After `wrong` the first
//     two digits stay and the rest clears; after `spent` the field is empty and editable. The failed
//     code is held only while the screen is up and never shown or logged;
//   - Pair is the joiner's consent: the other device's prompt is confirmed at once and the screen
//     waits for the other person; Cancel stops the join at any point.
//
// The clock and the timer are injected, so a test drives them.

import Foundation
import Observation
import PolarisKeyCore

@MainActor
@Observable
public final class LocalPairingModel {
    /// The inputs the screen is drawn from: the base with the step on top.
    public var inputs: KitInputs {
        var copy = base
        copy.localPairing = state
        return copy
    }
    public private(set) var base: KitInputs
    public private(set) var state: KitLocalPairing
    /// show: the digit positions (0-8, the space counted) that changed in the last rotation.
    public private(set) var changed: [Int] = []
    /// show: bumps with each new code, so a renderer can restart its highlight and announce it.
    public private(set) var rotation = 0
    /// show: this code replaced one the person was looking at (a wrong guess, a Not now, Show a new code).
    public private(set) var replaced = false
    /// paired: the name field's text; Done renames when it changed.
    public private(set) var name = ""
    /// paired: the pairing's id.
    public private(set) var pairedID: String?
    /// show: the text the QR encodes.
    public var qr: String? { state.qr }
    /// The person left (Cancel on choose, Close, Done): the host closes the screen.
    public private(set) var left = false
    /// Told once when the person leaves.
    @ObservationIgnored public var onClose: (@MainActor () -> Void)?

    @ObservationIgnored private let driver: LocalLinksDriver
    @ObservationIgnored private let categories: [String]
    @ObservationIgnored private let label: String?
    @ObservationIgnored private let prePrompt: Bool
    @ObservationIgnored private let canOpenSettings: Bool
    @ObservationIgnored private let now: @MainActor () -> Double
    @ObservationIgnored private let timer: @MainActor (Double, @escaping @MainActor () -> Void) -> () -> Void
    @ObservationIgnored private var shower: KitLocalWindow?
    @ObservationIgnored private var offer: KitLocalOffer?
    @ObservationIgnored private var joinTask: Task<KitLocalPaired, Error>?
    @ObservationIgnored private var stopTick: (() -> Void)?
    @ObservationIgnored private var expiresAt = 0.0
    @ObservationIgnored private var cooldownUntil = 0.0
    @ObservationIgnored private var tooMany = 0
    @ObservationIgnored private var wrong = 0
    @ObservationIgnored private var failedCode: String?
    @ObservationIgnored private var lastDevice: String?
    /// Bumped when a screen's session ends, so a late callback from an old one is dropped.
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private var typed = ""
    @ObservationIgnored private var blocked: (where: String, entry: String)?

    private static let tooManyWrong = 5

    public init(
        driver: LocalLinksDriver, categories: [String], label: String? = nil,
        prePrompt: Bool = false, canOpenSettings: Bool = false, inputs: KitInputs = KitInputs(),
        now: @escaping @MainActor () -> Double = { Date().timeIntervalSince1970 },
        timer: (@MainActor (Double, @escaping @MainActor () -> Void) -> () -> Void)? = nil
    ) {
        self.driver = driver
        self.categories = categories
        self.label = label
        self.prePrompt = prePrompt
        self.canOpenSettings = canOpenSettings
        self.base = inputs
        self.now = now
        self.timer =
            timer ?? { seconds, fn in
                let task = Task { @MainActor in
                    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                    if !Task.isCancelled { fn() }
                }
                return { task.cancel() }
            }
        var first = KitLocalPairing(step: .choose)
        first.categories = categories
        first.max = kitMaxConnectable
        first.prePrompt = prePrompt ? true : nil
        self.state = first
    }

    /// A model with no driver that shows `inputs.localPairing` as it is (previews, snapshots).
    public convenience init(inputs: KitInputs) {
        let never = LocalLinksDriver(
            localPairing: { true }, list: { [] }, rename: { _, _ in }, remove: { _ in },
            setReachable: { _, _ in }, onChange: { _ in {} }, dialsLeft: { _ in nil },
            pair: { _, _, _ in throw KitLocalError(code: "unknown") },
            join: { _, _, _, _ in throw KitLocalError(code: "unknown") })
        self.init(driver: never, categories: inputs.localPairing?.categories ?? [], inputs: inputs)
        if let shown = inputs.localPairing {
            state = shown
            // A paired still starts with the name the other device sent, as the live screen does.
            if shown.step == .paired { name = shown.device ?? "" }
        }
    }

    public var screen: KitScreen<LocalPairingState> { KitStates.localPairing(inputs) }

    /// Replaces the look and product the copy is drawn from, keeping the step.
    public func update(inputs next: KitInputs) {
        var merged = next
        merged.localPairing = nil
        base = merged
    }

    // MARK: Start

    /// Read the gate and the cap: the entry screen says so before either button.
    public func start() async {
        await close()
        guard driver.localPairing() else {
            go(KitLocalPairing(step: .off))
            return
        }
        var full = false
        if let rows = try? await driver.list() { full = rows.count >= kitMaxPaired }
        var entry = entryStep()
        if full { entry.full = true }
        go(entry)
    }

    // MARK: Show

    /// This device shows the code.
    public func show() async {
        if state.full == true { return }
        await openWindow()
    }

    /// Show a new code: closes the window and opens one with new first two digits. Waits out the 30
    /// seconds after Too many tries.
    public func showNew() async {
        if cooldownLeft() > 0 { return }
        await openWindow(renew: true)
    }

    private func openWindow(renew: Bool = false) async {
        let renewing = renew && shower != nil
        if !renewing { epoch += 1 }
        let mine = epoch
        let live: @MainActor () -> Bool = { [weak self] in self?.epoch == mine }
        if renewing {
            if state.busy != nil { return }
            state.busy = .newCode
        } else {
            go(KitLocalPairing(step: .opening))
        }
        do {
            if renewing, let shower {
                let next = try await shower.renew()
                if live() { rotate(next) }
                return
            }
            await close(bump: false)
            // `close` would have bumped the epoch; any other change meant Cancel (or a newer press) came first.
            if epoch != mine { return }
            let events = KitLocalEvents(
                onCode: { [weak self] c in Task { @MainActor in if live() { self?.rotate(c) } } },
                onConfirm: { [weak self] o in Task { @MainActor in if live() { self?.confirmPrompt(o) } } },
                onLinked: { [weak self] l in Task { @MainActor in if live() { self?.linked(l) } } },
                onInterrupted: { [weak self] n in
                    Task { @MainActor in
                        if live(), n >= 3, self?.state.step == .show { self?.state.notice = .blocked }
                    }
                },
                onEnd: { [weak self] r in Task { @MainActor in if live() { self?.ended(r) } } })
            let window = try await driver.pair(categories, label, events)
            if live() { shower = window } else { await window.stop() }
        } catch {
            if live() { fail(error, where: "show") }
        }
    }

    private func rotate(_ c: KitLocalCode) {
        let prev = state
        expiresAt = Double(c.expiresAt)
        let opened = c.reason == "opened"
        let wrongCode = c.reason == "wrong-code"
        // A changed code ends the session that was at the prompt: whatever the reason, its offer is
        // over, or the next device would be refused as "one at a time" by a prompt that is gone.
        if prev.step == .confirm || (!opened && !wrongCode) { offer = nil }
        if wrongCode { wrong += 1 }
        var diff: [Int] = []
        if !opened, let old = prev.code {
            let a = Array(c.code)
            let b = Array(old)
            for i in a.indices where i >= b.count || a[i] != b[i] { diff.append(i) }
        }
        var next = KitLocalPairing(step: .show)
        next.code = c.code
        next.qr = c.qr
        next.secondsLeft = max(0, Int((expiresAt - now()).rounded(.up)))
        if !opened {
            next.notice = wrongCode ? (wrong >= Self.tooManyWrong ? .guessing : .rotated) : .declined
            if !wrongCode, let d = lastDevice { next.device = d }
        }
        rotation += 1
        replaced = prev.step == .show || prev.step == .confirm
        go(next, changed: diff)
        tick()
    }

    private func ended(_ reason: String) {
        offer = nil
        shower = nil
        cancelTick()
        switch reason {
        case "too-many-tries":
            tooMany += 1
            cooldownUntil = now() + Double(kitCooldownSeconds)
            var next = KitLocalPairing(step: .closed)
            next.closedBy = .tooManyTries
            next.cooldownLeft = kitCooldownSeconds
            if tooMany >= 2 { next.warn = true }
            go(next)
            tick()
        case "expired":
            var next = KitLocalPairing(step: .closed)
            next.closedBy = .expired
            if tooMany >= 2 { next.warn = true }
            go(next)
        case "off":
            go(KitLocalPairing(step: .off))
        case "stored":
            break  // `onLinked` took the screen to paired
        default:
            go(entryStep())  // the person's own stop: back to the entry, nothing kept
        }
    }

    // MARK: Confirm

    private func confirmPrompt(_ o: KitLocalOffer) {
        if offer != nil {
            // One device at a time: the next one is declined, not left waiting.
            Task { await o.decline() }
            return
        }
        offer = o
        lastDevice = o.label
        var next = KitLocalPairing(step: .confirm)
        next.categories = o.categories
        if let l = o.label { next.device = l }
        go(next)
    }

    private func idleOffer() -> KitLocalOffer? {
        offer != nil && state.step == .confirm && state.busy == nil ? offer : nil
    }

    /// Pair, at the prompt: the person's yes. The link exists once the other person agrees too.
    public func confirm() async {
        guard let o = idleOffer() else { return }
        state.busy = .pair
        await o.confirm()
    }

    /// Not now: nothing is stored; the shower stays on its changed code.
    public func notNow() async {
        guard let o = idleOffer() else { return }
        state.busy = .notNow
        await o.decline()
    }

    private func linked(_ link: KitLocalPaired) {
        shower = nil
        cancelTick()
        stored(link)
    }

    private func stored(_ link: KitLocalPaired) {
        offer = nil
        joinTask = nil
        tooMany = 0
        wrong = 0
        failedCode = nil
        lastDevice = nil
        var next = KitLocalPairing(step: .paired)
        if let l = link.label { next.device = l }
        go(next)
        name = link.label ?? ""
        pairedID = link.id
        Task { await checkReachable(link.id) }
    }

    /// A pairing kept with Can connect off because 8 already are says so.
    private func checkReachable(_ id: String) async {
        let mine = epoch
        if let mineRow = try? await driver.list().first(where: { $0.id == id }), !mineRow.reachable,
            mine == epoch
        {
            state.cantConnect = true
        }
    }

    /// The name field of the paired screen.
    public func setName(_ text: String) {
        guard state.step == .paired else { return }
        name = text
        state.nameError = nil
    }

    /// Done: a changed name is saved on this device, then the screen is left.
    public func done() async {
        if state.step == .paired, let id = pairedID {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, name != state.device {
                do { try await driver.rename(id, trimmed) } catch {
                    // The name was not kept: the screen stays and says so.
                    state.nameError = "failed"
                    return
                }
            }
        }
        leave()
    }

    // MARK: Enter

    /// This device types the code.
    public func enter() async {
        if state.full == true { return }
        await close()
        failedCode = nil
        var next = KitLocalPairing(step: .enter)
        next.entry = ""
        go(next)
        refreshEntry()
    }

    /// The field changed. Spaces and hyphens in a paste are dropped; at most 8 digits are kept.
    public func setEntry(_ text: String) {
        guard state.step == .enter else { return }
        let d = Self.digits(text)
        let prev = Self.digits(state.entry ?? "")
        // A wrong code's line stays until the person types past the two digits the shower proved.
        let keepWrong = state.error == .wrong && d.count <= 2
        state.entry = Self.grouped(d)
        state.error = keepWrong ? .wrong : nil
        if d != prev { refreshEntry() }
    }

    private func refreshEntry() {
        guard state.step == .enter else { return }
        let d = Self.digits(state.entry ?? "")
        let left = driver.dialsLeft(d)
        let stale = failedCode != nil && d == failedCode
        state.triesLeft = left
        state.pairDisabled = d.count < 8 || left == 0 || stale
    }

    /// Pair. Unavailable, it answers its reason under the field and sends nothing.
    public func pair() async {
        guard state.step == .enter else { return }
        let d = Self.digits(state.entry ?? "")
        if state.pairDisabled == true {
            state.error =
                failedCode != nil && d == failedCode ? .wrong : state.triesLeft == 0 ? .spent : .notACode
            return
        }
        typed = Self.grouped(d)
        epoch += 1
        let mine = epoch
        let live: @MainActor () -> Bool = { [weak self] in self?.epoch == mine }
        state.step = .joining
        state.error = nil
        let cats = categories
        let lbl = label
        let drv = driver
        let task = Task<KitLocalPaired, Error> { [weak self] in
            try await drv.join(d, cats, lbl) { offer in
                Task { @MainActor in
                    guard let self, live() else { return }
                    self.offer = offer
                    // Pair was the yes: confirm at once and wait for the other person.
                    self.state.step = .waiting
                    self.state.categories = offer.categories
                    if let l = offer.label { self.state.device = l }
                    Task { await offer.confirm() }
                }
            }
        }
        joinTask = task
        do {
            let link = try await task.value
            if live() { stored(link) }
        } catch {
            if live() { joinFailed(error, code: d) }
        }
    }

    private func joinFailed(_ e: Error, code: String) {
        joinTask = nil
        offer = nil
        let d = Self.detail(e)
        if d.code == ErrorCode.pairingCodeFailed {
            if d.reason == PairingCodeFailedReason.spent {
                // B2: the field is empty and editable; Pair waits for first two digits that differ.
                failedCode = nil
                back(entry: "", error: .tooMany)
            } else if d.reason == PairingCodeFailedReason.invalid {
                back(entry: Self.grouped(code), error: .notACode)
            } else {
                // B1: `wrong` and another app's QR read alike. The first two digits stay.
                failedCode = code
                back(entry: String(code.prefix(2)), error: .wrong)
            }
            return
        }
        if d.code == ErrorCode.pairingNotFound {
            back(entry: Self.grouped(code), error: .notFound)
            return
        }
        if d.code == ErrorCode.peerClosed {
            if d.reason == "cancelled" {
                back(entry: Self.grouped(code), error: nil)
                return
            }
            var next = KitLocalPairing(step: .failed)
            next.reason = d.reason == "declined" ? .declined : d.reason == "timeout" ? .timeout : .closed
            go(next)
            return
        }
        fail(e, where: "enter", entry: Self.grouped(code))
    }

    private func back(entry: String, error: KitLocalPairing.EntryError?) {
        var next = KitLocalPairing(step: .enter)
        next.entry = entry
        next.error = error
        go(next)
        refreshEntry()
    }

    /// Show a code instead, from the field.
    public func toShow() async { await openWindow() }

    /// Enter a code instead, from a shown code: the window is withdrawn at once.
    public func toEnter() async { await enter() }

    // MARK: Leaving

    /// Cancel: withdraws the code, stops a join or declines a prompt, and returns one step.
    public func cancel() async {
        switch state.step {
        case .joining, .waiting:
            let o = offer
            joinTask?.cancel()
            epoch += 1
            joinTask = nil
            offer = nil
            if let o { await o.decline() }
            // Cancel stops the join, not the typing: the code is still in the field.
            failedCode = nil
            var next = KitLocalPairing(step: .enter)
            next.entry = typed
            go(next)
            refreshEntry()
        case .opening, .show, .confirm:
            await close()
            go(entryStep())
        default:
            leave()
        }
    }

    /// Back, from the field: to the entry.
    public func backToChoose() async {
        await close()
        go(entryStep())
    }

    /// Close, Done or Cancel on the entry: the host closes the screen.
    public func closeScreen() async {
        await close()
        leave()
    }

    private func close(bump: Bool = true) async {
        if bump { epoch += 1 }
        cancelTick()
        let o = offer
        let w = shower
        let j = joinTask
        offer = nil
        shower = nil
        joinTask = nil
        j?.cancel()
        if let o { await o.decline() }
        if let w { await w.stop() }
    }

    /// Try again, from a failed pairing, or from the network answer: back to the step it came from,
    /// with the field kept.
    public func retry() async {
        guard state.step == .networkBlocked else {
            await enter()
            return
        }
        let from = blocked
        blocked = nil
        if from?.where == "enter" {
            await enter()
            setEntry(from?.entry ?? "")
            return
        }
        await openWindow()
    }

    private func leave() {
        Task { await close() }
        left = true
        onClose?()
    }

    // MARK: Time

    private func cooldownLeft() -> Int { max(0, Int((cooldownUntil - now()).rounded(.up))) }

    /// One second passed: the ring and the wait follow the clock. Public so a test drives it.
    public func tick() {
        cancelTick()
        if state.step == .show {
            state.secondsLeft = max(0, Int((expiresAt - now()).rounded(.up)))
        } else if state.step == .closed, (state.cooldownLeft ?? 0) > 0 {
            let left = cooldownLeft()
            state.cooldownLeft = left
            if left == 0 { return }
        } else {
            return
        }
        stopTick = timer(1) { [weak self] in self?.tick() }
    }

    private func cancelTick() {
        stopTick?()
        stopTick = nil
    }

    // MARK: Errors

    /// A rejection no screen of the flow names: the gate, the cap, the network, or the shower.
    private func fail(_ e: Error, where place: String, entry: String = "") {
        let d = Self.detail(e)
        if d.code == ErrorCode.localPairingOff {
            go(KitLocalPairing(step: .off))
        } else if d.code == ErrorCode.nearbyPermissionDenied {
            blocked = (place, entry)
            var next = KitLocalPairing(step: .networkBlocked)
            if canOpenSettings { next.canOpenSettings = true }
            go(next)
        } else if d.code == ErrorCode.localLinksFull && d.cap == LocalLinksCap.stored {
            var next = KitLocalPairing(step: place == "show" ? .choose : .failed)
            next.full = true
            next.reason = .full
            go(next)
        } else if d.code == ErrorCode.peerClosed && d.reason == "cooldown" {
            // The SDK's floor is on: wait out the rest of the 30 s on the closed screen.
            cooldownUntil = max(cooldownUntil, now() + Double(kitCooldownSeconds))
            var next = KitLocalPairing(step: .closed)
            next.closedBy = .tooManyTries
            next.cooldownLeft = cooldownLeft()
            go(next)
            tick()
        } else {
            var next = KitLocalPairing(step: .failed)
            next.reason = .closed
            go(next)
        }
    }

    // MARK: Plumbing

    private func entryStep() -> KitLocalPairing {
        var next = KitLocalPairing(step: .choose)
        if prePrompt { next.prePrompt = true }
        return next
    }

    /// Replace the screen: only what is named survives, with the categories and the cap kept.
    private func go(_ next: KitLocalPairing, changed diff: [Int] = []) {
        var s = next
        if s.categories == nil { s.categories = categories }
        s.max = state.max
        state = s
        changed = diff
        if s.step != .paired {
            name = ""
            pairedID = nil
        }
    }

    static func digits(_ text: String) -> String { String(text.filter(\.isASCIIDigit).prefix(8)) }
    static func grouped(_ d: String) -> String {
        d.count > 4 ? "\(d.prefix(4)) \(d.dropFirst(4))" : d
    }

    static func detail(_ e: Error) -> (code: String?, reason: String?, cap: String?) {
        if let k = e as? KitLocalError { return (k.code, k.reason, k.cap) }
        if e is CancellationError { return ("cancelled", nil, nil) }
        return (nil, nil, nil)
    }
}

extension Character {
    fileprivate var isASCIIDigit: Bool { ("0"..."9").contains(self) }
}
