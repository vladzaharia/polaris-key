// @pkey-feature ui.signin identity.nearby
// NearbyApproval's model (UI-KITS §4.1): the approving device's side of nearby sign-in. It holds the step and
// the asking device and answers the state machine. Bound to an `IdentityClient` it runs the whole flow
// (`client.identity.nearby.onRequest`): the account menu's entry opens the approver, a session that reaches the
// code shows its three codes, the person taps the one the other device shows, and the licence choice (when the
// Worker asks for one) is one tap per licence. Without a client (previews, a host with its own protocol) a host
// calls `show` and the view follows.
//
//   let model = NearbyApprovalModel(identity: client.identity, inputs: inputs)
//   await model.open()           // the "Approve a nearby device" screen is open: the advert stands
//   // ask: three codes -> model.pick(code); "None of these match" -> model.deny()
//   // choose: model.chooseLicense(id) / model.createLicense(); Deny -> model.deny()
//   await model.close()          // leaving the ask or the choose answers Deny, then the advert stops
//
// Rules: leaving the ask or the choose answers Deny on that session (the new device is never left waiting);
// while a call is pending the screen shows progress and takes no second answer; one tap per licence.

import Foundation
import Observation
import PolarisKeyCore
import PolarisKeyIdentity

@MainActor
@Observable
public final class NearbyApprovalModel {
    /// The inputs the screen is drawn from.
    public private(set) var inputs: KitInputs
    /// The codes the asking device could be showing, one of which the person taps. The matching
    /// one is the action; there is no Approve button.
    public var codes: [String]
    /// The licences on offer while the Worker asks for a choice (`choose`).
    public private(set) var choices: KitLicenseChoices?
    /// A call to the Worker is in flight: the screen shows progress and takes no second answer.
    public private(set) var pending = false
    /// The approver screen is open (the advert stands, or is starting).
    public private(set) var presented = false
    /// Told when the person taps a code, or Not now.
    public var onChoose: (@MainActor (String) -> Void)?
    public var onDeny: (@MainActor () -> Void)?
    /// Told when a licence is tapped at the choice, or the offer to create one.
    public var onChooseLicense: (@MainActor (String) -> Void)?
    public var onCreateLicense: (@MainActor () -> Void)?
    /// Told when the account menu's entry is chosen.
    public var onOpen: (@MainActor () -> Void)?
    /// Told when an outcome's one way on is chosen (Done, Manage devices, Sign in, Try again), or Cancel while
    /// waiting for a session.
    public var onPrimary: (@MainActor () -> Void)?

    private let identity: IdentityClient?
    @ObservationIgnored private var approver: NearbyApprover?
    @ObservationIgnored private var ask: NearbyAsk?
    @ObservationIgnored private var choose: NearbyChoose?
    @ObservationIgnored private var removeEnd: (@Sendable () -> Void)?
    @ObservationIgnored private var generation = 0

    public init(inputs: KitInputs = KitInputs(), codes: [String] = []) {
        self.inputs = inputs
        self.codes = codes
        self.choices = inputs.nearbyApproval?.step == .choose ? inputs.choices : nil
        self.identity = nil
    }

    /// A model that runs the flow on `identity`. `inputs` carries the product and look the copy is drawn from.
    public init(identity: IdentityClient, inputs: KitInputs = KitInputs()) {
        self.inputs = inputs
        self.codes = []
        self.identity = identity
        onOpen = { [weak self] in
            guard let self else { return }
            Task { await self.open() }
        }
        onChoose = { [weak self] code in
            guard let self else { return }
            Task { await self.pick(code) }
        }
        onDeny = { [weak self] in
            guard let self else { return }
            Task { await self.deny() }
        }
        onChooseLicense = { [weak self] id in
            guard let self else { return }
            Task { await self.chooseLicense(id) }
        }
        onCreateLicense = { [weak self] in
            guard let self else { return }
            Task { await self.createLicense() }
        }
        onPrimary = { [weak self] in
            guard let self else { return }
            Task { await self.close() }
        }
    }

    public var screen: KitScreen<NearbyApprovalState> { KitStates.nearbyApproval(inputs) }

    /// Moves to `step` for `device`.
    public func show(_ step: KitNearbyApproval.Step, device: String? = nil) {
        inputs.nearbyApproval = KitNearbyApproval(step: step, device: device)
    }

    /// Replaces the look and product the copy is drawn from, keeping the step.
    public func update(inputs next: KitInputs) {
        var merged = next
        merged.nearbyApproval = inputs.nearbyApproval
        inputs = merged
    }

    // MARK: The flow

    /// The "Approve a nearby device" screen is open: advertise, and show the first session that reaches the
    /// code. Refusals are steps: signed out is `account-required`; a product or runtime that offers no nearby
    /// approval is `not-nearby`.
    public func open() async {
        guard let identity, approver == nil, !presented else { return }
        generation += 1
        let mine = generation
        presented = true
        pending = true
        defer { if mine == generation { pending = false } }
        do {
            let handle = try await identity.nearby.onRequest(NearbyApproverOptions(prompt: true)) { [weak self] ask in
                Task { @MainActor in self?.received(ask) }
            }
            guard mine == generation else {
                await handle.stop()
                return
            }
            approver = handle
            show(.entry)
        } catch let error as PolarisError {
            guard mine == generation else { return }
            show(error.code == ErrorCode.accountRequired ? .accountRequired : .notNearby)
        } catch {
            guard mine == generation else { return }
            show(.notNearby)
        }
    }

    private func received(_ next: NearbyAsk) {
        // One session at a time: a second ask while one is on screen is answered "none of these" at once.
        guard presented, ask == nil, choose == nil, inputs.nearbyApproval?.step == .entry else {
            Task { await next.deny() }
            return
        }
        ask = next
        codes = next.codes
        show(.ask, device: next.device)
        removeEnd = next.onEnd { [weak self] in
            Task { @MainActor in self?.sessionEnded(next) }
        }
    }

    /// The session ended on its own (it expired, or the other device left): the screen says so.
    private func sessionEnded(_ ended: NearbyAsk) {
        guard ask === ended, !pending, inputs.nearbyApproval?.step == .ask else { return }
        forgetSession()
        show(.expired)
    }

    private func forgetSession() {
        removeEnd?()
        removeEnd = nil
        ask = nil
        choose = nil
        choices = nil
        codes = []
    }

    /// The person tapped a code. The right one asks the Worker; a wrong one ends the session.
    public func pick(_ code: String) async {
        guard let ask, !pending, inputs.nearbyApproval?.step == .ask else { return }
        let device = ask.device
        pending = true
        defer { pending = false }
        do {
            apply(try await ask.pick(code), device: device)
        } catch {
            forgetSession()
            show(.expired)
        }
    }

    /// Deny. At the ask, "none of these match" (no route is called); at the choice, the Worker records a denial
    /// and the other device is told.
    public func deny() async {
        guard !pending else { return }
        if let choose, inputs.nearbyApproval?.step == .choose {
            let device = inputs.nearbyApproval?.device
            pending = true
            defer { pending = false }
            do { apply(try await choose.cancel(), device: device) } catch {
                forgetSession()
                show(.expired)
            }
        } else if let ask, inputs.nearbyApproval?.step == .ask {
            await ask.deny()
            forgetSession()
            show(.entry)
        }
    }

    /// The person tapped a licence at the choice: one tap, no second confirmation.
    public func chooseLicense(_ id: String) async {
        await answer(.license(id))
    }

    /// The person took the offer to create a licence for the new device.
    public func createLicense() async {
        await answer(.create)
    }

    private func answer(_ choice: NearbyChoice) async {
        guard let choose, !pending, inputs.nearbyApproval?.step == .choose else { return }
        let device = inputs.nearbyApproval?.device
        pending = true
        defer { pending = false }
        do { apply(try await choose.choose(choice), device: device) } catch {
            forgetSession()
            show(.expired)
        }
    }

    private func apply(_ step: NearbyApprovalStep, device: String?) {
        switch step {
        case .choose(let next):
            choose = next
            choices = LicenseChoiceModel.choices(from: next.choices)
            codes = []
            show(.choose, device: device)
            return
        case .approved: show(.approved, device: device)
        case .mismatch: show(.mismatch, device: device)
        case .notNearby: show(.notNearby, device: device)
        case .denied: show(.denied, device: device)
        case .expired: show(.expired, device: device)
        case .deviceLimit: show(.deviceLimit, device: device)
        case .accountRequired: show(.accountRequired, device: device)
        case .rateLimited: show(.rateLimited, device: device)
        }
        // An outcome ends the session.
        forgetSession()
    }

    /// Leave the screen. Leaving the ask or the choose answers Deny on that session first; then the advert stops.
    public func close() async {
        generation += 1
        if let choose, inputs.nearbyApproval?.step == .choose {
            _ = try? await choose.cancel()
        } else if let ask, inputs.nearbyApproval?.step == .ask {
            await ask.deny()
        }
        forgetSession()
        let handle = approver
        approver = nil
        pending = false
        presented = false
        show(.entry)
        await handle?.stop()
    }
}
