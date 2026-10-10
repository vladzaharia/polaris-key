// @pkey-feature ui.settings ui.paywall
// The settings and paywall families of ui-matrix.json: AccountAndLicense, Settings, Paywall and
// EntitlementGate.

import Foundation

public enum AccountState: String, KitStateID {
    case loading
    case signedIn = "signed-in"
    case keyOnly = "key-only"
    case offline
    public static let component = KitComponent.accountAndLicense
}

public enum SettingsState: String, KitStateID {
    case loading, list, dirty, saving, locked, error
    public static let component = KitComponent.settings
}

public enum PaywallState: String, KitStateID {
    case loading, offers, purchasing, purchased, restore
    case notAvailable = "not-available"
    public static let component = KitComponent.paywall
}

public enum EntitlementGateState: String, KitStateID {
    case entitled
    case notEntitled = "not-entitled"
    case loading
    public static let component = KitComponent.entitlementGate
}

extension KitStates {
    /// The settings pane's account and license. A floating license is never silently attached to
    /// an account (the Must not): with no one signed in it is `key-only`, with no holder line.
    public static func accountAndLicense(_ i: KitInputs) -> KitScreen<AccountState> {
        let c = Ctx(i)
        let on = i.closedServices
        let title = c.line("account.title")
        if i.loading == true { return KitScreen(.loading, [title, c.line("common.loading")]) }
        if i.gate?.status == .grace {
            return KitScreen(.offline, [c.line("account.offline"), c.line("part.status.grace")])
        }
        let tier = c.line("account.tier", ["tier": ""])
        let signedIn = on.contains(.identity) && (i.account?.signedIn ?? false)
        if !signedIn {
            var lines = [title]
            if on.contains(.license) { lines.append(tier) }
            lines.append(c.line("account.keyOnly"))
            if on.contains(.update) { lines.append(c.line("account.updates")) }
            lines.append(c.line("common.signOut"))
            return KitScreen(.keyOnly, lines)
        }
        var lines = [title]
        if on.contains(.license) { lines.append(tier) }
        if i.account?.holder == "account" {
            lines.append(c.line("account.holder", ["name": ""]))
        }
        lines += [c.line("common.manage"), c.line("a11y.externalLink")]
        if on.contains(.license) { lines.append(c.line("account.devices")) }
        if on.contains(.sync) { lines.append(c.line("account.cloudSync")) }
        if on.contains(.update) {
            lines += [
                c.line("account.updates"), c.line("account.autoUpdate"), c.line("account.channel"),
                c.line("update.checkNow"),
            ]
        }
        lines.append(c.line("account.version", ["version": ""]))
        if on.contains(.config) { lines.append(c.line("account.managedSettings")) }
        lines.append(c.line("common.signOut"))
        if i.integrator?.poweredBy != nil { lines.append(c.line("part.poweredBy")) }
        return KitScreen(.signedIn, lines)
    }

    /// Catalog-driven settings. A theme never reveals a hidden value (the Must not): rows come only
    /// from `config.list`, and the theme feeds no row.
    public static func settings(_ i: KitInputs) -> KitScreen<SettingsState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.config) else { return .hidden }
        let title = c.line("settings.title")
        if i.loading == true { return KitScreen(.loading, [title, c.line("common.loading")]) }
        if i.error != nil {
            if i.config == nil {
                return KitScreen(
                    .error, [c.line("settings.loadFailed"), c.line("common.tryAgain")])
            }
            return KitScreen(.error, [c.line("settings.error"), c.line("common.tryAgain")])
        }
        if i.pending == .save { return KitScreen(.saving, [c.line("settings.saving")]) }
        if i.saved == true { return KitScreen(.saving, [c.line("settings.saved")]) }
        guard let rows = i.config else {
            return KitScreen(.loading, [title, c.line("common.loading")])
        }
        if i.edit?.kind == "value" {
            return KitScreen(.dirty, [c.line("settings.unsaved"), c.line("common.save")])
        }
        if let locked = rows.first(where: \.locked) {
            if let org = KitIdentity.nonEmpty(locked.org) {
                return KitScreen(
                    .locked, [c.line("settings.setBy", ["org": .text(org)]), c.line("a11y.locked")])
            }
            // A host may name the lock's reason; with no organization, the guardian line.
            return KitScreen(.locked, [c.line("settings.setByGuardian"), c.line("a11y.locked")])
        }
        if rows.isEmpty { return KitScreen(.list, [title, c.line("settings.empty")]) }
        var lines = [title]
        if rows.count > 12 { lines.append(c.line("settings.search")) }
        if rows.contains(where: { $0.source == "default" }) {
            lines.append(c.line("settings.fromDeveloper", c.developerArg))
        }
        for source in ["local", "env", "default"]
        where rows.contains(where: { $0.source == source }) {
            lines.append(c.line("settings.source.\(source)"))
        }
        if rows.contains(where: { $0.source == "local" }) { lines.append(c.line("settings.reset")) }
        if rows.contains(where: { $0.type == "number" && $0.min != nil && $0.max != nil }) {
            lines.append(c.line("settings.range", ["min": "", "max": ""]))
        }
        if rows.contains(where: { $0.value == .bool(true) }) { lines.append(c.line("settings.on")) }
        if rows.contains(where: { $0.value == .bool(false) }) {
            lines.append(c.line("settings.off"))
        }
        if rows.contains(where: { $0.advanced == true }) {
            lines.append(c.line("settings.advanced"))
        }
        return KitScreen(.list, lines)
    }

    /// The upsell. It never invents checkout (the Must not): with no offers it says so; on a
    /// platform without in-app purchase it hands off to the browser.
    public static func paywall(_ i: KitInputs) -> KitScreen<PaywallState> {
        let c = Ctx(i)
        guard i.isOn(.license) else { return .hidden }
        if i.loading == true { return KitScreen(.loading, [c.line("common.loading")]) }
        let tierName = i.offers?.tier
        let tier: [String: CopyArgument] = ["product": c.product, "tier": .text(tierName ?? "")]
        if i.pending == .purchase {
            return KitScreen(.purchasing, [c.line("paywall.purchasing"), c.line("a11y.busy")])
        }
        if i.pending == .restore { return KitScreen(.restore, [c.line("paywall.restore")]) }
        if i.offers?.purchased == true {
            return KitScreen(
                .purchased, [c.line("paywall.purchased", tier), c.line("common.done")])
        }
        guard let offers = i.offers else { return KitScreen(.loading, [c.line("common.loading")]) }
        if !offers.available {
            return KitScreen(.notAvailable, [c.line("paywall.notAvailable", c.productArg)])
        }
        // "{tier} includes" only introduces a list: without the tier and its features the line
        // carries no tier, so it is incomplete and not drawn.
        let includes: [String: CopyArgument] =
            tierName != nil && !(offers.features ?? []).isEmpty ? tier : [:]
        var lines = [c.line("paywall.title", tier), c.line("paywall.includes", includes)]
        lines.append(
            i.capabilities.purchase
                ? c.line("paywall.upgrade", tier) : c.line("paywall.portal"))
        lines.append(c.line("paywall.redeem"))
        return KitScreen(.offers, lines)
    }

    /// Renders children only when an entitlement holds. A style override is never authorization
    /// (the Must not): only the entitlement decides.
    public static func entitlementGate(_ i: KitInputs) -> KitScreen<EntitlementGateState> {
        let c = Ctx(i)
        if i.loading == true { return KitScreen(.loading, [c.line("common.loading")]) }
        let tier: [String: CopyArgument] = i.entitlement?.tier.map { ["tier": .text($0)] } ?? [:]
        // With License off there is no license document, so no entitlement holds, and the Paywall
        // that Unlock opens is hidden.
        guard i.isOn(.license) else {
            return KitScreen(.notEntitled, [c.line("entitlement.locked", tier)])
        }
        if i.entitlement?.entitled == true { return KitScreen(.entitled, []) }
        return KitScreen(
            .notEntitled, [c.line("entitlement.locked", tier), c.line("entitlement.unlock")])
    }
}
