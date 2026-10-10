// @pkey-feature ui.update
// The update family of ui-matrix.json: UpdatePrompt, UpdateProgress and ReleaseNotes.

import Foundation

public enum UpdatePromptState: String, KitStateID {
    case available, downloading, ready, mandatory, blocked, store, platform
    case revokedRequiredContent = "revoked-required-content"
    case upToDate = "up-to-date"
    public static let component = KitComponent.updatePrompt
}

public enum UpdateProgressState: String, KitStateID {
    case queued, downloading, installing, paused, failed, done
    public static let component = KitComponent.updateProgress
}

public enum ReleaseNotesState: String, KitStateID {
    case loading, list, empty, error
    public static let component = KitComponent.releaseNotes
}

extension KitStates {
    /// The update prompt with the verb the outlet allows. The web never offers a restart it cannot
    /// perform (the Must not): its outlet's decision is `platform`, drawn as Reload the page.
    public static func updatePrompt(_ i: KitInputs) -> KitScreen<UpdatePromptState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.update), let u = i.update else { return .hidden }
        let version = CopyArgument.text(u.version ?? "")
        let named: [String: CopyArgument] = ["product": c.product, "version": version]
        switch u.action {
        case "none":
            return KitScreen(.upToDate, [c.line("update.upToDate"), c.line("update.checkNow")])
        case "blocked":
            if u.reason == "revoked-content" {
                return KitScreen(
                    .revokedRequiredContent,
                    [
                        c.line("core.codes.pack-revoked.title"),
                        c.line("update.revokedContent", c.productArg), c.line("update.install"),
                    ])
            }
            return KitScreen(
                .blocked,
                [c.line("update.blockedTitle"), c.line("update.blockedBody", c.productArg)])
        case "store":
            return KitScreen(.store, [storeLine(u.outlet, c)])
        case "platform":
            return KitScreen(
                .platform, [c.line("update.availableTitle"), platformLine(u.outlet, c)])
        case "code-ready":
            return KitScreen(
                .ready,
                [
                    c.line("update.readyTitle", named), c.line("update.readyBody", c.productArg),
                    c.line("update.restartNow"), c.line("update.later"),
                ])
        case "binary":
            if u.mandatory == true {
                return KitScreen(
                    .mandatory,
                    [
                        c.line("update.mandatoryTitle", c.productArg),
                        c.line("update.mandatoryBody", c.productArg), c.line("update.install"),
                    ])
            }
            if let phase = u.progress?.phase, phase != "queued" {
                return KitScreen(
                    .downloading,
                    [
                        c.line("update.downloading", c.progressArgs),
                        c.line("update.timeLeft", ["time": ""]),
                        c.line("a11y.progress", c.progressArgs), c.line("update.later"),
                        c.line("update.restartWhenReady"),
                    ])
            }
            var lines: [CopyLine]
            if u.version != nil {
                lines = [
                    c.line("update.title", named),
                    c.line("update.current", ["version": "", "size": ""]),
                ]
                if u.critical == true { lines.append(c.line("update.critical")) }
                lines += [
                    c.line("update.whatsNew"), c.line("update.allChanges", ["version": version]),
                ]
            } else {
                lines = [c.line("update.availableTitle")]
            }
            lines += [
                c.line("update.install"), c.line("update.restartWhenReady"),
                c.line("update.later"), c.line("update.skipVersion"),
            ]
            return KitScreen(.available, lines)
        default:
            return .hidden
        }
    }

    /// The verb a store outlet allows.
    static func storeLine(_ outlet: String?, _ c: Ctx) -> CopyLine {
        switch outlet {
        case "app-store": return c.line("update.appStore")
        case "play", "play-testing": return c.line("update.googlePlay")
        case "testflight": return c.line("update.testflight")
        case "altstore", "altstore-pal": return c.line("update.altstore")
        case "steam": return c.line("update.steam")
        case "ms-store": return c.line("update.openStore", ["store": "Microsoft Store"])
        default: return c.line("update.openStore", ["store": ""])
        }
    }

    /// Who installs the update when the platform does it.
    static func platformLine(_ outlet: String?, _ c: Ctx) -> CopyLine {
        switch outlet {
        case "steam": return c.line("update.platform.steam")
        case "itch": return c.line("update.platform.itch")
        case "flathub", "snap": return c.line("update.platform.store")
        case "app-installer": return c.line("update.platform.appInstaller", c.productArg)
        case "winget": return c.line("update.platform.command", ["command": "winget upgrade"])
        case "fdroid-repo": return c.line("update.platform.package")
        case "web": return c.line("update.platform.web")
        default: return c.line("update.platform.generic", c.productArg)
        }
    }

    /// Download and install progress for an app update or content. Verifying is still
    /// downloading: the copy never says installed before the apply (the Must not).
    public static func updateProgress(_ i: KitInputs) -> KitScreen<UpdateProgressState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.update), let u = i.update, let p = u.progress else {
            return .hidden
        }
        switch p.phase {
        case "queued":
            var lines = [c.line("updateProgress.queued")]
            if u.action == "packs" { lines.insert(c.line("updateProgress.contentTitle"), at: 0) }
            return KitScreen(.queued, lines)
        case "download", "verify":
            return KitScreen(
                .downloading,
                [
                    c.line("updateProgress.downloading", c.progressArgs),
                    c.line("a11y.progress", c.progressArgs),
                ])
        case "install":
            return KitScreen(.installing, [c.line("updateProgress.installing")])
        case "paused":
            return KitScreen(
                .paused, [c.line("updateProgress.paused"), c.line("updateProgress.resume")])
        case "failed":
            return KitScreen(.failed, [c.line("updateProgress.failed"), c.line("common.tryAgain")])
        case "done":
            return KitScreen(.done, [c.line("updateProgress.done")])
        default:
            return .hidden
        }
    }

    /// The changelog. Notes are plain text: remote markup is shown, never run (the Must not).
    public static func releaseNotes(_ i: KitInputs) -> KitScreen<ReleaseNotesState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.release) else { return .hidden }
        if i.loading == true {
            return KitScreen(
                .loading, [c.line("releaseNotes.title", c.productArg), c.line("common.loading")])
        }
        if i.error != nil {
            return KitScreen(.error, [c.line("releaseNotes.error"), c.line("common.tryAgain")])
        }
        guard let notes = i.releaseNotes else {
            return KitScreen(
                .loading, [c.line("releaseNotes.title", c.productArg), c.line("common.loading")])
        }
        if notes.isEmpty { return KitScreen(.empty, [c.line("releaseNotes.empty")]) }
        return KitScreen(
            .list,
            [
                c.line("releaseNotes.title", c.productArg),
                c.line("releaseNotes.version", ["version": ""]),
                c.line("releaseNotes.released", ["date": ""]),
            ])
    }
}
