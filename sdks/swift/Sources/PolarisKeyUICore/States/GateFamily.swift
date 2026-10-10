// @pkey-feature ui.gate
// The gate family of ui-matrix.json: PolarisKeyGate, Boot, StatusScreen, GraceBanner and Toast.

import Foundation

public enum GateState: String, KitStateID {
    case booting
    case needsActivation = "needs-activation"
    case licensed, grace, blocked, error
    public static let component = KitComponent.gate
}

public enum BootScreenState: String, KitStateID {
    case progress, consent, fetching, offline, blocked, declined
    case rolledBack = "rolled-back"
    case error
    public static let component = KitComponent.boot
}

public enum StatusScreenState: String, KitStateID {
    case revoked, expired
    case versionTooOld = "version-too-old"
    case versionTooNew = "version-too-new"
    case channelNotEntitled = "channel-not-entitled"
    public static let component = KitComponent.statusScreen
}

public enum GraceBannerState: String, KitStateID {
    case daysLeft = "days-left"
    case lastDay = "last-day"
    case expired
    public static let component = KitComponent.graceBanner
}

public enum ToastState: String, KitStateID {
    case info, success, warning, error
    case withProgress = "with-progress"
    public static let component = KitComponent.toast
}

extension KitStates {
    /// The drop-in root. Never shows activation while a cached license is re-checked (the Must not):
    /// `checking` holds `booting` until the status is known.
    public static func gate(_ i: KitInputs) -> KitScreen<GateState> {
        let c = Ctx(i)
        if !i.isOn(.license) { return KitScreen(.licensed, []) }
        if let stage = i.stage, stage.outcome == "error" {
            return KitScreen(
                .error,
                [c.line("gate.error.title", c.productArg), c.line("common.tryAgain")])
        }
        guard let status = i.gate?.status, i.gate?.checking != true else {
            return KitScreen(.booting, c.delayed([c.line("gate.checking")]))
        }
        switch status {
        case .ok, .notApplicable:
            return KitScreen(.licensed, [])
        case .needsActivation:
            return KitScreen(
                .needsActivation,
                [
                    c.line("core.gate.needs-activation.title"),
                    c.line("core.gate.needs-activation.message", c.productArg),
                ])
        case .grace:
            return KitScreen(
                .grace,
                [
                    c.line("core.gate.grace.title"),
                    c.line("core.gate.grace.message", c.productArg),
                    c.line("common.reconnect"),
                ])
        case .revoked, .expired, .versionTooOld, .versionTooNew, .channelNotEntitled:
            return KitScreen(.blocked, [c.line("part.status.blocked")])
        }
    }

    /// First paint while the stage machine runs. Progress is never invented: the counted line and
    /// its meter appear only once the fetch reports bytes.
    public static func boot(_ i: KitInputs) -> KitScreen<BootScreenState> {
        let c = Ctx(i)
        guard let stage = i.stage else {
            return KitScreen(.progress, [c.line("boot.starting"), c.line("a11y.busy")])
        }
        let emit = stage.emit
        if emit?.type == "boot_rolled_back" {
            return KitScreen(.rolledBack, [c.line("boot.rolledBack")])
        }
        switch stage.outcome {
        case "error":
            return KitScreen(
                .error,
                [
                    c.line("gate.error.title", c.productArg),
                    c.line(
                        "boot.error.body",
                        ["product": c.product, "code": .text(emit?.code ?? "error")]),
                    c.line("common.tryAgain"),
                ])
        case "offline":
            if emit?.canPlayOffline == true {
                return KitScreen(
                    .offline,
                    [
                        c.line("boot.offline.title"), c.line("boot.offline.playable"),
                        c.line("boot.continueOffline"), c.line("common.tryAgain"),
                    ])
            }
            return KitScreen(
                .offline,
                [
                    c.line("boot.offline.title"), c.line("boot.offline.body"),
                    c.line("common.tryAgain"),
                ])
        case "blocked":
            if emit?.reason == "content-declined" {
                return KitScreen(
                    .declined,
                    [
                        c.line("boot.declined.title"), c.line("boot.declined.body", c.productArg),
                        c.line("common.tryAgain"),
                    ])
            }
            return KitScreen(
                .blocked,
                [
                    c.line("core.gate.version-too-old.title"),
                    c.line("core.gate.version-too-old.message", c.productArg),
                    c.line("status.update"),
                ])
        case "waiting" where emit?.type == "consent_needed":
            let size = CopyArgument.text(KitFormat.bytes(emit?.bytes ?? 0))
            return KitScreen(
                .consent,
                [
                    c.line("boot.consent.title"),
                    c.line(
                        emit?.metered == true ? "boot.consent.bodyMetered" : "boot.consent.body",
                        ["product": c.product, "size": size]),
                    c.line("boot.consent.download"), c.line("common.notNow"),
                ])
        case "ready":
            return KitScreen(.progress, [c.line("boot.ready")])
        default:
            break
        }
        if stage.stage == "fetch" {
            if emit?.type == "fetch_progress", let done = emit?.done, let total = emit?.total {
                let args: [String: CopyArgument] = [
                    "size": .text(KitFormat.bytes(done)), "total": .text(KitFormat.bytes(total)),
                ]
                return KitScreen(
                    .fetching,
                    [c.line("boot.fetchingProgress", args), c.line("a11y.progress", args)])
            }
            return KitScreen(.fetching, [c.line("boot.fetching")])
        }
        let label: String
        switch stage.stage {
        case "sync": label = "boot.syncing"
        case "gate": label = "gate.checking"
        case "decide": label = "boot.deciding"
        case "mount": label = "common.loading"
        default: label = "boot.starting"
        }
        return KitScreen(.progress, [c.line(label), c.line("a11y.busy")])
    }

    /// A blocking state with its own fix; the five refusals stay five states.
    public static func statusScreen(_ i: KitInputs) -> KitScreen<StatusScreenState> {
        let c = Ctx(i)
        guard i.isOn(.license), let status = i.gate?.status else { return .hidden }
        let allowed = i.gate?.allowed
        func allowedLine() -> [CopyLine] {
            switch (allowed?.min, allowed?.max) {
            case (let min?, let max?):
                return [c.line("status.allowedRange", ["min": .text(min), "max": .text(max)])]
            case (let min?, nil):
                return [c.line("status.allowedMin", ["min": .text(min)])]
            case (nil, let max?):
                return [c.line("status.allowedMax", ["max": .text(max)])]
            default:
                return []
            }
        }
        switch status {
        case .revoked:
            return KitScreen(
                .revoked,
                [
                    c.line("core.gate.revoked.title"),
                    c.line("core.gate.revoked.message", c.productArg),
                    c.line("signin.key.differentKey"), c.line("common.signOut"),
                ])
        case .expired:
            return KitScreen(
                .expired,
                [
                    c.line("core.gate.expired.title"),
                    c.line("core.gate.expired.message", c.productArg),
                    c.line("status.renew"), c.line("status.useAnotherLicense"),
                ])
        case .versionTooOld:
            return KitScreen(
                .versionTooOld,
                [
                    c.line("core.gate.version-too-old.title"),
                    c.line("core.gate.version-too-old.message", c.productArg),
                ] + allowedLine() + [c.line("status.update")])
        case .versionTooNew:
            return KitScreen(
                .versionTooNew,
                [
                    c.line("core.gate.version-too-new.title"),
                    c.line("core.gate.version-too-new.message", c.productArg),
                ] + allowedLine())
        case .channelNotEntitled:
            var lines = [
                c.line("core.gate.channel-not-entitled.title"),
                c.line("core.gate.channel-not-entitled.message", c.productArg),
                c.line("status.switchChannel"),
            ]
            // "Contact <Developer>" only when a source names the developer: never a placeholder.
            if let developer = c.identity.developer {
                lines.append(c.line("status.contact", ["developer": .text(developer)]))
            }
            return KitScreen(.channelNotEntitled, lines)
        case .ok, .grace, .needsActivation, .notApplicable:
            return .hidden
        }
    }

    /// Offline grace. The last day never reads as days left (the Must not).
    public static func graceBanner(_ i: KitInputs) -> KitScreen<GraceBannerState> {
        let c = Ctx(i)
        guard i.isOn(.license), let status = i.gate?.status else { return .hidden }
        switch status {
        case .grace:
            let days = i.gate?.graceDaysLeft ?? 0
            if days <= 1 {
                return KitScreen(
                    .lastDay, [c.line("grace.lastDay", c.productArg), c.line("common.reconnect")])
            }
            return KitScreen(
                .daysLeft,
                [
                    c.line("grace.daysLeft", ["days": .number(days)]),
                    c.line("grace.deadline", ["date": .text(KitFormat.dayAfter(days))]),
                    c.line("common.reconnect"), c.line("common.dismiss"),
                ])
        case .expired:
            return KitScreen(
                .expired,
                [
                    c.line("core.gate.expired.title"),
                    c.line("core.gate.expired.message", c.productArg),
                ])
        default:
            return .hidden
        }
    }

    /// A toast. An error toast never times out (it is not the only record of the error).
    public static func toast(_ i: KitInputs) -> KitScreen<ToastState> {
        let c = Ctx(i)
        switch i.toast?.kind {
        case "update":
            guard i.closedServices.contains(.update) else { return .hidden }
            return KitScreen(
                .info,
                [
                    c.line(
                        "toast.updateAvailable",
                        ["product": c.product, "version": .text(i.update?.version ?? "")]),
                    c.line("common.dismiss"), c.line("a11y.toastTimer"),
                ])
        case "copied":
            return KitScreen(.success, [c.line("common.copied")])
        case "warning":
            return KitScreen(.warning, [c.line("common.dismiss")])
        case "error":
            return KitScreen(.error, c.codeLines(i.error?.code) + [c.line("common.dismiss")])
        case "progress":
            return KitScreen(
                .withProgress,
                [c.line("updateProgress.downloading", c.progressArgs), c.line("toast.undo")])
        default:
            return .hidden
        }
    }
}
