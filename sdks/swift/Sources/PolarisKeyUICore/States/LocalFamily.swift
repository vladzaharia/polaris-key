// @pkey-feature connect.local
// Pair with a Code (ui-matrix `local`, CC-29K): LocalPairing, the windows two devices of one app on
// one network pair in by an 8-digit code or a QR with no account, and PairedDevices, the list of
// what they paired. The reference is packages/ui-core/src/models/local.ts, state for state.
// Rules the rows pin:
//   - the code is the largest thing on the show screen; nothing else takes focus first on confirm,
//     so a stray Return never pairs, and Pair on the field's screen is the person's yes: the
//     categories come before it;
//   - a name the other device sent is unauthenticated text: it is isolated and never truncated in
//     the consent title;
//   - Pair is drawn but unavailable (`disabledKeys`) with its reason on screen when the field holds
//     fewer than 8 digits, the code that just failed, or a prefix with no dial left;
//   - after Too many tries the code stays gone for 30 seconds (the cooldown is the model's), and a
//     window that ran out has none;
//   - the Can connect switches show only when more than 8 devices are paired or one is off.

import Foundation

/// The most paired devices that can connect at once (`MAX_LIVE_LOCAL_ADVERTS`).
public let kitMaxConnectable = 8
/// The most paired devices one device holds (`MAX_LOCAL_LINKS`).
public let kitMaxPaired = 32
/// The longest name a person may give a paired device.
public let kitMaxDeviceName = 64
/// Seconds a new code waits after Too many tries (LP1 F9).
public let kitCooldownSeconds = 30

public enum LocalPairingState: String, KitStateID {
    case choose, opening, show, closed, enter, joining, confirm, waiting, paired, failed
    case networkBlocked = "network-blocked"
    case off
    public static let component = KitComponent.localPairing
}

public enum PairedDevicesState: String, KitStateID {
    case loading, list, renaming, forgetting, empty
    case loadFailed = "load-failed"
    case off
    public static let component = KitComponent.pairedDevices
}

/// `m:ss` for a countdown.
public func kitCountdown(_ seconds: Int) -> String {
    let s = max(0, seconds)
    return "\(s / 60):" + String(format: "%02d", s % 60)
}

/// Text the other device chose, set apart from the words around it (first-strong isolate).
public func kitIsolate(_ text: String) -> String { "\u{2068}\(text)\u{2069}" }

/// The Can connect column rule (M8): more than 8 paired, or one off.
public func kitShowSwitchColumn(_ devices: [KitPairedDevice]) -> Bool {
    devices.count > kitMaxConnectable || devices.contains { !$0.reachable }
}

/// True when the eight that can connect are all on and more are paired.
public func kitReachableFull(_ devices: [KitPairedDevice]) -> Bool {
    devices.count > kitMaxConnectable && devices.filter(\.reachable).count >= kitMaxConnectable
}

/// How the show screen lays out for a window size (UI-KITS 4.3, LocalPairing).
public struct KitLocalPairingLayout: Sendable, Equatable {
    /// 2: the QR sits beside the code; 1: under it.
    public let panes: Int
    /// False in a window under 480 tall: it shows its own logo.
    public let logo: Bool
    /// True when the one column is taller than the window: the window scrolls and nothing clips.
    public let scrolls: Bool
    /// True when the notice must come before the QR in a window that scrolls.
    public let noticeBeforeQr: Bool

    /// Two panes from 600 pt of window at the root text size (so 200 % text keeps one column), at
    /// any height, and always on a TV. A window under 480 tall drops the logo. A window both narrow
    /// and short keeps one column that scrolls, with the notice before the QR.
    public static func of(width: Double, height: Double, textScale: Double = 1, tv: Bool = false)
        -> KitLocalPairingLayout
    {
        let scale = textScale > 0 ? textScale : 1
        let panes = tv || width / scale >= 600 ? 2 : 1
        let short = height < 480 && !tv
        return KitLocalPairingLayout(
            panes: panes, logo: !short, scrolls: panes == 1 && short,
            noticeBeforeQr: panes == 1 && short)
    }
}

extension KitStates {
    private static func shares(_ categories: [String]?) -> String {
        (categories ?? []).isEmpty ? "linkPairing.sharesNone" : "linkPairing.shares"
    }

    private static func lines(_ c: Ctx, _ keys: [String?], _ args: [String: CopyArgument])
        -> [CopyLine]
    {
        var seen = Set<String>()
        return keys.compactMap { $0 }.filter { seen.insert($0).inserted }.map { c.line($0, args) }
    }

    /// The pairing screens, by state.
    public static func localPairing(_ i: KitInputs) -> KitScreen<LocalPairingState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.connect), let p = i.localPairing else { return .hidden }
        let device = p.device.flatMap {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0
        }
        func screen(
            _ state: LocalPairingState, _ keys: [String?], _ args: [String: CopyArgument] = [:],
            disabled: [String?] = []
        ) -> KitScreen<LocalPairingState> {
            KitScreen(state, lines(c, keys, args), disabled: disabled.compactMap { $0 })
        }
        switch p.step {
        case .choose:
            let app = c.identity.inlineName
            let full = p.full == true
            return screen(
                .choose,
                [
                    "localPairing.title", "localPairing.chooseBody", "localPairing.show",
                    "localPairing.enter",
                    p.prePrompt == true && !full ? "localPairing.prePrompt" : nil,
                    full ? "core.codes.local-links-full.title" : nil,
                    full ? "core.codes.local-links-full.message" : nil,
                    full ? "localPairing.pairedDevices" : nil, "common.cancel",
                ], app.isEmpty ? [:] : ["app": .text(app)],
                disabled: full ? ["localPairing.show", "localPairing.enter"] : [])
        case .opening:
            return screen(
                .opening,
                [
                    "localPairing.title", "localPairing.showBody", "a11y.busy",
                    "localPairing.toEnter", "common.cancel",
                ])
        case .show:
            let n = p.notice
            let renewing = p.busy == .newCode
            var args: [String: CopyArgument] = ["time": .text(kitCountdown(p.secondsLeft ?? 0))]
            if let code = p.code { args["code"] = .text(code.map(String.init).joined(separator: " ")) }
            if let device { args["device"] = .text(kitIsolate(device)) }
            return screen(
                .show,
                [
                    "localPairing.title", "localPairing.showBody",
                    p.code != nil ? "a11y.linkCode" : nil, "a11y.qrPairing",
                    "localPairing.expires", "localPairing.waitingDevice", "localPairing.toEnter",
                    "common.cancel",
                    n == .rotated || n == .guessing ? "localPairing.rotatedTitle" : nil,
                    n == .rotated ? "localPairing.rotatedBody" : nil,
                    n == .declined ? "localPairing.rotatedBody" : nil,
                    n == .declined ? "localPairing.notPairedWith" : nil,
                    n == .rotated || n == .declined || n == .guessing ? "a11y.newCode" : nil,
                    n == .blocked ? "localPairing.blockedTitle" : nil,
                    n == .blocked ? "localPairing.blockedBody" : nil,
                    n == .guessing ? "localPairing.tooManyAgainBody" : nil,
                    n != nil && n != .blocked ? "localPairing.showNew" : nil,
                    renewing ? "a11y.busy" : nil,
                ], args, disabled: [renewing ? "localPairing.showNew" : nil])
        case .closed:
            let cooling = (p.cooldownLeft ?? 0) > 0
            let shown = cooling ? "localPairing.showNewIn" : "localPairing.showNew"
            return screen(
                .closed,
                [
                    "linkPairing.failedTitle",
                    p.closedBy == .tooManyTries
                        ? "localPairing.failedTooMany" : "localPairing.failedExpired",
                    p.warn == true ? "localPairing.tooManyAgainTitle" : nil,
                    p.warn == true ? "localPairing.tooManyAgainBody" : nil, shown, "common.close",
                ], ["time": .text(kitCountdown(p.cooldownLeft ?? 0))],
                disabled: [cooling ? "localPairing.showNewIn" : nil])
        case .enter, .joining:
            let busy = p.step == .joining
            let e = p.error
            let spent = !busy && p.triesLeft == 0 && e == nil
            var args: [String: CopyArgument] = [:]
            if let left = p.triesLeft { args["left"] = .number(left) }
            return screen(
                p.step == .joining ? .joining : .enter,
                [
                    "localPairing.title", "localPairing.enterBody", "localPairing.codeLabel",
                    !busy && (p.entry ?? "").isEmpty ? "localPairing.codePlaceholder" : nil,
                    shares(p.categories), "localPairing.pair",
                    busy ? "a11y.busy" : "localPairing.toShow",
                    busy ? "common.cancel" : "common.back",
                    !busy && e == .wrong ? "localPairing.wrongCode" : nil,
                    !busy && (e == .wrong || e == nil) && p.triesLeft == 1
                        ? "localPairing.triesLeft" : nil,
                    !busy && (e == .spent || spent) ? "localPairing.spentCode" : nil,
                    !busy && e == .tooMany ? "localPairing.cooldownTitle" : nil,
                    !busy && e == .tooMany ? "localPairing.cooldownBody" : nil,
                    !busy && e == .notFound ? "localPairing.notFoundTitle" : nil,
                    !busy && e == .notFound ? "localPairing.notFoundBody" : nil,
                    !busy && e == .notACode ? "localPairing.notACode" : nil,
                ], args,
                disabled: [busy || p.pairDisabled == true ? "localPairing.pair" : nil])
        case .confirm:
            let args: [String: CopyArgument] = device.map { ["device": .text(kitIsolate($0))] } ?? [:]
            let busy = p.busy != nil
            return screen(
                .confirm,
                [
                    device != nil ? "localPairing.confirmTitle" : "localPairing.confirmUnnamed",
                    "localPairing.confirmBody", shares(p.categories), "localPairing.pair",
                    "common.notNow", busy ? "a11y.busy" : nil,
                ], args, disabled: busy ? ["localPairing.pair", "common.notNow"] : [])
        case .waiting:
            return screen(
                .waiting,
                [
                    "linkPairing.waiting", device != nil ? "localPairing.waitingWith" : nil,
                    shares(p.categories), "common.cancel",
                ], device.map { ["device": .text(kitIsolate($0))] } ?? [:])
        case .paired:
            var args: [String: CopyArgument] = ["max": .number(p.max ?? kitMaxConnectable)]
            args["device"] = .text(kitIsolate(device ?? ""))
            let cant = p.cantConnect == true
            return screen(
                .paired,
                [
                    "localPairing.pairedTitle", "localPairing.pairedBody", "localPairing.nameLabel",
                    "localPairing.nameHint", cant ? "localPairing.cantConnectTitle" : nil,
                    cant ? "localPairing.cantConnectBody" : nil,
                    cant ? "localPairing.pairedDevices" : nil,
                    p.nameError != nil ? "devices.renameFailed" : nil, "common.done",
                ], args)
        case .failed:
            let body: String
            switch p.reason ?? .closed {
            case .declined: body = "linkPairing.failedDeclined"
            case .timeout: body = "linkPairing.failedTimeout"
            case .full: body = "localPairing.failedFull"
            case .closed: body = "linkPairing.failedClosed"
            }
            return screen(.failed, ["linkPairing.failedTitle", body, "common.tryAgain", "common.close"])
        case .networkBlocked:
            return screen(
                .networkBlocked,
                [
                    "core.codes.nearby-permission-denied.title",
                    "core.codes.nearby-permission-denied.message",
                    p.canOpenSettings == true ? "localPairing.openSettings" : nil,
                    "common.tryAgain", "common.close",
                ])
        case .off:
            return screen(
                .off,
                [
                    "core.codes.local-pairing-off.title", "core.codes.local-pairing-off.message",
                    "common.close",
                ])
        }
    }

    /// The paired devices and what the person is doing to one row.
    public static func pairedDevices(_ i: KitInputs) -> KitScreen<PairedDevicesState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.connect), let p = i.pairedDevices else { return .hidden }
        let devices = p.devices ?? []
        func screen(
            _ state: PairedDevicesState, _ keys: [String?], _ args: [String: CopyArgument] = [:],
            disabled: [String?] = []
        ) -> KitScreen<PairedDevicesState> {
            KitScreen(state, lines(c, keys, args), disabled: disabled.compactMap { $0 })
        }
        let seen = devices.contains { $0.lastSeen != nil }
        switch p.step {
        case .loading:
            return screen(.loading, ["pairedDevices.title", "a11y.busy", "common.done"])
        case .loadFailed:
            return screen(
                .loadFailed,
                ["pairedDevices.title", "pairedDevices.loadFailed", "common.tryAgain", "common.done"])
        case .off:
            return screen(
                .off,
                [
                    "pairedDevices.title", "core.codes.local-pairing-off.title",
                    "pairedDevices.offBody", seen ? "pairedDevices.lastSeen" : nil,
                    devices.isEmpty ? nil : "a11y.deviceOptions",
                    devices.isEmpty ? nil : "devices.rename",
                    devices.isEmpty ? nil : "pairedDevices.forget", "common.done",
                ], devices.first?.label.map { ["device": .text(kitIsolate($0))] } ?? [:])
        case .list, .renaming, .forgetting:
            break
        }
        if devices.isEmpty {
            return screen(
                .empty,
                ["pairedDevices.title", "pairedDevices.empty", "pairedDevices.pair", "common.done"])
        }
        let full = devices.count >= kitMaxPaired
        let switches = kitShowSwitchColumn(devices)
        let state: PairedDevicesState =
            p.step == .renaming ? .renaming : p.step == .forgetting ? .forgetting : .list
        let waits = state == .list && kitReachableFull(devices)
        var notice: [String] = []
        if state == .list, let n = p.notice {
            switch n.kind {
            case .notFound: notice = ["pairedDevices.notFoundTitle", "pairedDevices.notFoundBody"]
            case .busy: notice = ["pairedDevices.busyTitle", "common.tryAgain"]
            case .unknown: notice = ["core.codes.link-unknown.title", "core.codes.link-unknown.message"]
            }
        }
        let target = devices.first { $0.id == p.target }
        let name: String
        if let l = target?.label, !l.trimmingCharacters(in: .whitespaces).isEmpty {
            name = l
        } else {
            name = devices.first?.label ?? ""
        }
        let renaming = state == .renaming
        let forgetting = state == .forgetting
        let keys: [String?] =
            [
                "pairedDevices.title", "pairedDevices.lede",
                seen ? "pairedDevices.lastSeen" : nil, "a11y.deviceOptions", "devices.rename",
                "pairedDevices.forget", switches ? "pairedDevices.canConnect" : nil,
                switches ? "a11y.letConnect" : nil,
                waits ? "pairedDevices.reachableFullTitle" : nil,
                waits ? "pairedDevices.reachableFullBody" : nil,
                state == .list && full ? "core.codes.local-links-full.title" : nil,
                state == .list && full ? "pairedDevices.fullBody" : nil,
            ] + notice.map { Optional($0) } + [
                renaming ? "devices.renameLabel" : nil, renaming ? "localPairing.nameHint" : nil,
                renaming ? "common.save" : nil, renaming ? "common.cancel" : nil,
                renaming && p.renameError == .long ? "pairedDevices.renameLong" : nil,
                renaming && p.renameError == .empty ? "pairedDevices.renameEmpty" : nil,
                renaming && p.renameError == .failed ? "devices.renameFailed" : nil,
                forgetting ? "pairedDevices.forgetConfirm" : nil,
                forgetting ? "pairedDevices.forgetBody" : nil,
                forgetting && p.forgetError == true ? "pairedDevices.forgetFailed" : nil,
                forgetting ? "common.cancel" : nil, "pairedDevices.pair", "common.done",
            ]
        let args: [String: CopyArgument] = [
            "device": .text(kitIsolate(p.notice?.device ?? name)),
            "max": .number(p.renameError == .long ? kitMaxDeviceName : kitMaxConnectable),
        ]
        return screen(state, keys, args, disabled: [full ? "pairedDevices.pair" : nil])
    }
}
