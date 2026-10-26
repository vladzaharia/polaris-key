// The live licence-choice model (UI-KITS §1.3 layer c; plans/I-04.md §G): an @Observable view of a
// pending sign-in grant as the `KitInputs` the LicenseChoice screen is drawn from, with the actions
// the screen needs. It is fed by the SDK (`client.identity.choice`), not by fixtures. SwiftUI-free:
// the drop-in kit draws it, and a host with its own UI binds to the same properties.
//
//   let model = LicenseChoiceModel(identity: client.identity, pending: pending)  // the first view
//   await model.start()                  // no pending view yet: read the licences (grant only)
//   model.select("lic_pro"); await model.confirm()
//   model.phase == .done                 // the device is signed in; model.completion has the rest
//
// What it fixes: the screen never shows a stale list (a `device_limit` or
// `license_choice_required` refusal swaps in the Worker's fresh view and marks the screen
// `raced`); an `invalid_grant` ends the grant (`grantExpired`, nothing to retry); every refusal is
// kept as `error` and changes nothing else.

import Foundation
import Observation
import PolarisKeyCore
import PolarisKeyIdentity

@MainActor
@Observable
public final class LicenseChoiceModel {
    /// Where the choice stands.
    public enum Phase: Equatable, Sendable {
        /// Reading the licences.
        case loading
        /// The view is drawn and the person picks.
        case choosing
        /// A call (read devices, replace, complete, cancel) is in flight.
        case working
        /// The device is signed in on the chosen licence.
        case done
        /// The person abandoned the grant; nothing was bound.
        case cancelled
        /// The grant lapsed or was consumed: sign in again.
        case grantExpired
    }

    public private(set) var phase: Phase
    /// The licences on offer, in the kit's own shape.
    public private(set) var choices: KitLicenseChoices?
    /// The devices of the licence being replaced into, when the Replace step is open.
    public private(set) var replaceView: KitReplaceView?
    /// The licence id (or `keep`, `create`) the person picked; the preselection until they pick.
    public private(set) var selected: String?
    /// The last refusal, cleared by the next action.
    public private(set) var error: ChoiceError?
    /// A refusal replaced the view with a fresh one (`device_limit`, `license_choice_required`).
    public private(set) var raced = false
    /// The answer of a successful `confirm()` / `useKey(_:)`.
    public private(set) var completion: ChoiceCompletion?

    private let identity: IdentityClient
    private let grant: String
    private var replaceTarget: String?
    private var replaceOpen = false

    /// Draw the view a `signIn` session settled with; `start()` is then not needed.
    public init(identity: IdentityClient, pending: PendingSignIn) {
        self.identity = identity
        self.grant = pending.grant
        self.phase = .choosing
        apply(pending.view)
    }

    /// Start from the grant alone: `start()` reads the licences.
    public init(identity: IdentityClient, grant: String) {
        self.identity = identity
        self.grant = grant
        self.phase = .loading
    }

    /// Read the licences afresh (also the way back after a refusal). Idempotent while choosing.
    public func start() async {
        guard phase == .loading || phase == .choosing else { return }
        await run(keepPhase: phase == .choosing) {
            self.apply(try await self.identity.choice.licenses(grant: self.grant))
        }
    }

    /// Pick a licence row, `keep` or `create`.
    public func select(_ id: String) {
        guard phase == .choosing else { return }
        selected = id
        error = nil
    }

    /// Open Replace for a full licence: list the devices using it.
    public func openReplace(licenseId: String) async {
        guard phase == .choosing else { return }
        await run {
            let view = try await self.identity.choice.devices(grant: self.grant, licenseId: licenseId)
            self.replaceTarget = licenseId
            self.replaceOpen = true
            self.selected = licenseId
            self.replaceView = KitReplaceView(
                licenseId: view.licenseId,
                seats: KitSeats(used: view.seats.used, limit: view.seats.limit ?? view.seats.used),
                devices: view.devices.map {
                    KitReplaceDevice(
                        id: $0.id, label: $0.label, platform: $0.platform ?? "",
                        deviceType: $0.deviceType ?? "", lastSeen: $0.lastSeen,
                        leastRecent: $0.leastRecent, activeNow: $0.activeNow,
                        thisBrowser: $0.thisBrowser)
                },
                replace: KitReplaceAllowance(
                    allowed: view.replace.allowed, retryAfter: view.replace.retryAfter))
        }
    }

    /// Close the Replace step without replacing.
    public func closeReplace() {
        replaceOpen = false
        replaceView = nil
        replaceTarget = nil
    }

    /// Replace `deviceId` with this device on the licence Replace was opened for, and sign in.
    public func replace(deviceId: String) async {
        guard let license = replaceTarget else { return }
        await complete(.license(id: license, replaceDeviceId: deviceId))
    }

    /// Finish with the picked row.
    public func confirm() async {
        guard phase == .choosing, let pick = selected else { return }
        switch pick {
        case "keep": await complete(.keep)
        case "create": await complete(.create)
        default: await complete(.license(id: pick))
        }
    }

    /// Finish with a licence key (the no-licence state's "Use a license key instead").
    public func useKey(_ key: String) async {
        guard phase == .choosing else { return }
        await complete(.key(key))
    }

    /// Abandon the grant: nothing is bound.
    public func cancel() async {
        guard phase == .choosing || phase == .loading else { return }
        let before = phase
        phase = .working
        error = nil
        do {
            try await identity.choice.cancel(grant: grant)
            phase = .cancelled
        } catch let e as ChoiceError {
            fail(e, restoring: before)
        } catch {
            phase = before
        }
    }

    /// The LicenseChoice screen's inputs: `base` with the sign-in session, the choices, the
    /// Replace view and the selection filled in from this model.
    public func inputs(base: KitInputs = KitInputs()) -> KitInputs {
        var out = base
        var sign = out.signIn ?? KitSignIn()
        sign.channel = .browser
        sign.outcome = .choose
        if replaceOpen { sign.event = .openReplace }
        if raced {
            sign.raced = true
            if replaceOpen || replaceTarget != nil { sign.event = .confirmReplace }
        }
        if phase == .grantExpired { sign.grantExpired = true }
        out.signIn = sign
        out.loading = phase == .loading ? true : nil
        out.choices = choices
        out.replaceView = replaceView
        out.selected = selected
        out.error = error.map { KitError(code: $0.code) }
        return out
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────

    private func complete(_ choice: LicenseChoiceInput) async {
        guard phase == .choosing else { return }
        await run {
            self.completion = try await self.identity.choice.complete(
                grant: self.grant, choice: choice)
            self.phase = .done
        }
    }

    /// One call: working while it runs, back to the phase it started in unless it set another.
    private func run(keepPhase: Bool = true, _ body: @MainActor () async throws -> Void) async {
        let before = phase
        phase = .working
        error = nil
        raced = false
        do {
            try await body()
            if phase == .working { phase = .choosing }
        } catch let e as ChoiceError {
            fail(e, restoring: keepPhase ? before : .choosing)
        } catch {
            // A call that never got an answer (offline, unsupported) leaves the screen as it was.
            phase = before == .loading ? .loading : .choosing
        }
    }

    private func fail(_ e: ChoiceError, restoring before: Phase) {
        error = e
        switch e.code {
        case ErrorCode.invalidGrant:
            phase = .grantExpired
        case ErrorCode.deviceLimit, ErrorCode.licenseChoiceRequired:
            raced = true
            if let view = e.view { apply(view) }
            replaceOpen = false
            replaceView = nil
            phase = .choosing
        default:
            phase = before == .loading ? .choosing : before
        }
    }

    private func apply(_ view: LicenseChoiceView) {
        choices = KitLicenseChoices(
            state: view.state,
            choices: view.choices.map { row in
                KitLicenseChoice(
                    id: row.id, tierName: row.tierName, name: row.name, origin: row.origin,
                    access: row.access,
                    seats: row.seats.limit.map { KitSeats(used: row.seats.used, limit: $0) },
                    current: row.current, expiresAt: row.expiresAt, state: row.state,
                    replace: row.replace.map {
                        KitReplaceAllowance(allowed: $0.allowed, retryAfter: $0.retryAfter)
                    }, freeDeviceUrl: row.freeDeviceUrl)
            }, keep: view.keep, preselected: view.preselected,
            create: view.create.map { KitLicenseCreateOffer(tierName: $0.tierName, access: $0.access) },
            getLicense: view.getLicense.map {
                KitGetLicense(
                    activateUrl: $0.activateUrl, purchaseUrl: $0.purchaseUrl, keyEntry: $0.keyEntry)
            })
        // The preselection stands until the person picks; a fresh view re-offers it.
        if selected == nil || raced { selected = view.preselected }
    }
}
