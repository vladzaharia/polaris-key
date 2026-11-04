// @pkey-feature ui.kit.holders
// The holders' steps wired to a live client (UK-43.6), headless: the Done step after a key activates
// (the key held in memory until Start using), the account step it leads to, the manage QR a TV shows,
// and the same account step from Settings. The views (PolarisKeyUI/Kit/Screens/HolderFlowViews.swift)
// draw whatever `stage` names; every decision is here, so it is tested without a window.
//
//   done  ActivateDone. Start using ends the flow and forgets the key. Add opens the account step
//         (`addIn: app`), or the product page when Identity is off (`addIn: portal`), opened with
//         `#key=` only where it is safe (never on a TV, never off the product's own origins).
//   qr    The TV's manage QR, with no key in it.
//   add   AddToAccount over `AddToAccountModel` and the SDK driver. Cancel from it returns to Done
//         with focus on Add (`returned`); from Settings it leaves.
//
// Rules: Cancel is never a decline and never cancels work it does not own; problems stay on their
// screen; a missing page link is said, never an empty button.

import Foundation
import Observation
import PolarisKey
import PolarisKeyCore
import PolarisKeyIdentity
import PolarisKeyLicense

/// The license key just activated, held in memory until Start using closes the Done step (it is
/// never stored or logged: the description redacts it).
public final class PolarisKeyDone: @unchecked Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let key: String
    /// The entries of the key just activated, for the line the product shows after Done.
    public let entries: KeyEntries?

    public init(key: String, entries: KeyEntries? = nil) {
        self.key = key
        self.entries = entries
    }

    public var description: String { "PolarisKeyDone(key: [redacted])" }
    public var debugDescription: String { description }
}

/// What the holders' screens are drawn from for a live client: the views' input (services, the
/// license holder, the Done line) and the pages the portal actions open.
public struct HolderFacts: Sendable, Equatable {
    /// `services`, `licenseHolder`, `activateDone` and the product's identity, ready for the models.
    public var base: KitInputs
    /// The product's page in the customer portal (never with a key), or nil when there is none.
    public var portal: String?
    /// The account page "Verify" opens, or nil.
    public var account: String?
    /// The origin the SDK talks to, for the `#key=` rule.
    public var apiOrigin: String
    /// Identity is on: the account steps can run in the app.
    public var identity: Bool
    public var addIn: KitAddIn
    /// The email the license waits for (unmasked, for a sign-in hint), or nil while it floats.
    public var holderEmail: String?
    /// The license is held by its key alone: a holder is known, with no email and no account.
    public var floating: Bool
    /// The noun the Done line uses for this device ("iPhone", "Mac").
    public var deviceKind: String

    public init(
        base: KitInputs, portal: String?, account: String?, apiOrigin: String, identity: Bool,
        addIn: KitAddIn, holderEmail: String?, floating: Bool, deviceKind: String
    ) {
        self.base = base
        self.portal = portal
        self.account = account
        self.apiOrigin = apiOrigin
        self.identity = identity
        self.addIn = addIn
        self.holderEmail = holderEmail
        self.floating = floating
        self.deviceKind = deviceKind
    }

    /// Add opens the portal: Identity is off, or the kit has no in-app channel.
    public var portalOnly: Bool { !identity || addIn == .portal }
    /// A TV opens nothing: it shows the manage QR instead.
    public var tv: Bool { base.platform.isTV }

    /// `iPhone`, `iPad`, `Mac`, `TV`, else `device`: this device's noun.
    public static func deviceKind(for platform: KitPlatform) -> String {
        switch platform.formFactor {
        case .iphone: return "iPhone"
        case .ipad: return "iPad"
        case .mac: return "Mac"
        case .tv: return "TV"
        case .phone: return "phone"
        case .tablet: return "tablet"
        case .computer: return "computer"
        case .other: return "device"
        }
    }

    /// `addIn` for a platform: the app where there is an in-app channel (iPhone, iPad, Mac),
    /// the portal on a TV (UK-43 D5).
    public static func addIn(for platform: KitPlatform) -> KitAddIn { platform.isTV ? .portal : .app }

    /// The link to open for `key`: `#key=` rides it only on a phone, tablet or desktop, and only
    /// on the SDK's own origin or the customer site. Anything else opens the link as it is.
    public func portalTarget(key: String?) -> String? {
        guard let link = portal else { return nil }
        guard let key, !key.isEmpty, !tv, Self.sameOrigin(link, [apiOrigin, CUSTOMER_ORIGIN_DEFAULT]) else {
            return link
        }
        return ManageLink.withKey(link, key)
    }

    static func sameOrigin(_ link: String, _ origins: [String]) -> Bool {
        func origin(_ raw: String) -> String? {
            guard let c = URLComponents(string: raw), let scheme = c.scheme?.lowercased(),
                let host = c.host?.lowercased()
            else { return nil }
            return "\(scheme)://\(host)" + (c.port.map { ":\($0)" } ?? "")
        }
        guard let mine = origin(link) else { return false }
        return origins.contains { origin($0) == mine }
    }

    /// Read the facts for `client`. `base` carries the product's identity (presentation, bundle,
    /// platform); `activated` adds the Done line's facts.
    public static func read(client: PolarisKeyClient, base: KitInputs, activated: Bool) async -> HolderFacts {
        var on: Set<KitService> = []
        for service in KitService.allCases {
            if let slug = ServiceSlug(rawValue: service.rawValue), await client.core.enabled(slug) {
                on.insert(service)
            }
        }
        if await client.core.licenseGateEnabled() { on.insert(.license) } else { on.remove(.license) }
        let profile = await client.license.getProfile()
        let info = await client.licenseInfo()
        let doc = await client.core.discoveryDocument
        let platform = base.platform
        let kind = deviceKind(for: platform)
        let email = profile?.email.trimmingCharacters(in: .whitespaces)
        let holderEmail = (email?.isEmpty ?? true) ? nil : email
        let addIn = addIn(for: platform)
        var i = base
        i.services = on
        i.licenseHolder = KitLicenseHolder(email: holderEmail ?? "", addIn: addIn)
        if activated {
            var done = KitActivateDone(
                tier: info?.tierLabel ?? info?.tier, deviceKind: kind,
                limit: info?.deviceLimit)
            done.position = await rosterPosition(client)
            i.activateDone = done
        }
        let baseUrl = client.core.endpoints.baseUrl
        let portal = PortalLink.link(
            served: nil, portal: nil, baseUrl: baseUrl, product: client.core.endpoints.product)
        return HolderFacts(
            base: i, portal: portal, account: doc?.identity?.accountPortal ?? portal,
            apiOrigin: baseUrl, identity: on.contains(.identity), addIn: addIn,
            holderEmail: holderEmail,
            floating: profile != nil && holderEmail == nil && profile?.user == nil, deviceKind: kind)
    }

    /// This device's place among the license's devices (the roster's size), or nil when the roster
    /// was not reached in time (this device alone, offline, is not a count).
    private static func rosterPosition(_ client: PolarisKeyClient) async -> Int? {
        let roster = await withTaskGroup(of: [DeviceInfo]?.self) { group -> [DeviceInfo]? in
            group.addTask { await client.listDevices() }
            group.addTask {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        guard let roster, !roster.isEmpty, roster.allSatisfy({ $0.platform != nil }) else { return nil }
        return roster.count
    }
}

extension KitInputs {
    /// The members the holders' screens share, from the gate's (or settings') inputs.
    public var holderBase: KitInputs {
        KitInputs(
            integrator: integrator, presentation: presentation, bundle: bundle, platform: platform,
            services: services, registration: registration, capabilities: capabilities)
    }
}

/// Which step of the flow the person is on.
public enum HolderStage: Sendable, Equatable {
    case done, qr, add
}

@MainActor
@Observable
public final class HolderFlowModel {
    public private(set) var stage: HolderStage
    public let facts: HolderFacts
    /// The account step's model; it owns the form's fields and the sign-in it runs.
    public let add: AddToAccountModel
    /// Account sign-ins started from Done ("Sign in as ...").
    public let doneHost: HolderHostState
    /// The person came back from the account step (Cancel): focus returns to Add.
    public private(set) var returned = false
    /// The Done step is over (Start using, or an account sign-in that finished): the host drops the flow.
    public private(set) var finished = false
    public let fromSettings: Bool

    // The activated key, in memory only until `finish()`.
    private var key: String?
    private let onFinish: @MainActor () -> Void

    /// `key` is the license key just activated (nil from Settings, which starts at the account step,
    /// or the QR on a TV). `onFinish` runs once, when the flow ends.
    public init(
        facts: HolderFacts, driver: any AddToAccountDriver, key: String? = nil,
        onFinish: @escaping @MainActor () -> Void = {}
    ) {
        self.facts = facts
        self.key = key
        self.fromSettings = key == nil
        self.onFinish = onFinish
        self.add = AddToAccountModel(
            driver: driver, base: facts.base, deviceKind: facts.deviceKind, fromSettings: key == nil)
        self.doneHost = HolderHostState(driver: driver)
        if key != nil {
            stage = .done
        } else {
            stage = facts.portalOnly ? .qr : .add
        }
    }

    /// A flow over a live client, for the gate (`key` set) or Settings (nil).
    public static func live(
        client: PolarisKeyClient, facts: HolderFacts, key: String?,
        native: NativeRedirectOptions = NativeRedirectOptions(),
        onFinish: @escaping @MainActor () -> Void = {}
    ) -> HolderFlowModel {
        HolderFlowModel(
            facts: facts, driver: IdentityAddToAccountDriver(identity: client.identity, native: native),
            key: key, onFinish: onFinish)
    }

    // MARK: What the views read

    /// ActivateDone's inputs: the facts, and whether the person came back from the account step.
    public var doneInputs: KitInputs {
        var i = facts.base
        if returned { i.activateDone?.returned = true }
        return i
    }

    /// The page ActivateDone's portal action opens: with `#key=` only where that is safe.
    public var doneLink: String? { facts.portalTarget(key: key) }

    /// The page the TV's QR carries: never with a key.
    public var qrLink: String? { facts.portalTarget(key: nil) }

    /// Verify's page, or nil when there is none (the action is left out).
    public var verifyLink: String? { facts.account }

    // MARK: Actions

    /// Add, from Done: the account step, or the manage QR where there is no in-app channel. (Where
    /// the view opens the portal itself it never calls this.)
    public func openAdd() {
        returned = false
        stage = facts.portalOnly ? .qr : .add
    }

    /// Cancel from the account step: Done again with focus on Add (nothing in flight survives it);
    /// from Settings, the flow leaves.
    public func cancelAdd() {
        add.cancel()
        doneHost.cancel()
        leave()
    }

    /// Back from the QR, or from an idle account form.
    public func leave() {
        if key != nil {
            returned = true
            stage = .done
        } else {
            finish()
        }
    }

    /// Start using (or an account sign-in finished, or Added closed): the flow ends and the key is forgotten.
    public func finish() {
        key = nil
        guard !finished else { return }
        finished = true
        doneHost.cancel()
        onFinish()
    }
}
