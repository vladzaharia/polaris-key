// @pkey-feature ui.devicelimit ui.devices
// The deviceLimit and devices families of ui-matrix.json: DeviceLimit (Replace a device on the key
// path) and Devices (the license's device list).

import Foundation

public enum DeviceLimitState: String, KitStateID {
    case `default`, busy, removed, failed
    case browserMode = "browser-mode"
    public static let component = KitComponent.deviceLimit
}

public enum DevicesState: String, KitStateID {
    case loading, list, renaming, confirming, empty
    case browserMode = "browser-mode"
    case error
    public static let component = KitComponent.devices
}

extension KitStates {
    /// Replace a device (PORTAL §4.25; SIGN-IN.md §3.7). With the device list in hand it is the
    /// in-app radio list; otherwise the browser mode opens `manageUrl` (a QR on TV). Replacing
    /// another device never deletes anything here (the Must not).
    public static func deviceLimit(_ i: KitInputs) -> KitScreen<DeviceLimitState> {
        let c = Ctx(i)
        guard i.isOn(.license) else { return .hidden }
        let devices = i.devices ?? []
        let target = c.leastRecentDevice
        let device = CopyArgument.text(i.replacement?.device ?? target?.name ?? "")
        if let replacement = i.replacement {
            if replacement.outcome == "done" {
                return KitScreen(
                    .removed,
                    [c.line("deviceLimit.removed", ["device": device, "product": c.product])])
            }
            return KitScreen(
                .failed,
                [c.line("deviceLimit.failed", ["device": device]), c.line("common.tryAgain")])
        }
        if i.pending == .replace {
            return KitScreen(
                .busy,
                [c.line("deviceLimit.primary"), c.line("common.working"), c.line("a11y.busy")])
        }
        let used = i.activation?.deviceCount ?? devices.count
        let limit = i.activation?.limit ?? devices.count
        let seats: [String: CopyArgument] = ["used": .number(used), "limit": .number(limit)]
        if !devices.isEmpty {
            var lines = [
                c.line("deviceLimit.title"), c.line("deviceLimit.heading", seats),
                c.line("deviceLimit.lede", ["formFactor": c.formFactor]),
            ]
            if i.activation?.limit != nil, i.activation?.deviceCount != nil {
                lines += [c.line("part.seatMeter.caption", seats), c.line("a11y.seatMeter", seats)]
            }
            lines += [
                c.line("signin.replace.meta", ["platform": "", "when": ""]),
                c.line("signin.replace.leastRecent"),
                c.line("a11y.formFactor", ["formFactor": c.formFactor]),
                c.line("deviceLimit.confirmTitle", ["device": device]),
                c.line(
                    "deviceLimit.consequence",
                    ["device": device, "product": c.product, "thisDevice": c.thisDevice]),
                c.line("deviceLimit.primary"), c.line("common.back"),
            ]
            return KitScreen(.default, lines)
        }
        var lines = [
            c.line("deviceLimit.title"), c.line("deviceLimit.browser", c.productArg),
        ]
        if KitLinks.valid(i.activation?.manageUrl) != nil {
            if i.platform.isTV {
                lines += [c.line("deviceLimit.scan"), c.line("a11y.qr")]
            } else {
                lines += [c.line("deviceLimit.openBrowser"), c.line("a11y.externalLink")]
            }
        }
        return KitScreen(.browserMode, lines)
    }

    /// The license's devices. "This device" appears only for a row the runtime knows is this
    /// device (the Must not).
    public static func devices(_ i: KitInputs) -> KitScreen<DevicesState> {
        let c = Ctx(i)
        guard i.isOn(.license) else { return .hidden }
        let title = c.line("devices.title")
        if i.loading == true {
            return KitScreen(.loading, c.delayed([title, c.line("common.loading")]))
        }
        let device = CopyArgument.text(i.edit?.device ?? "")
        if let error = i.error {
            let key: String
            switch error.code {
            case "device_rename_failed": key = "devices.renameFailed"
            case "device_deauthorize_failed": key = "devices.removeFailed"
            case "device_list_failed": key = "devices.loadFailed"
            default:
                switch i.edit?.kind {
                case "rename": key = "devices.renameFailed"
                case "remove": key = "devices.removeFailed"
                default: key = "devices.loadFailed"
                }
            }
            return KitScreen(.error, [c.line(key, ["device": device]), c.line("common.tryAgain")])
        }
        if i.browserMode == true {
            return KitScreen(
                .browserMode,
                [c.line("devices.browser"), c.line("devices.manage"), c.line("a11y.externalLink")])
        }
        if let edit = i.edit {
            if edit.kind == "rename" {
                return KitScreen(
                    .renaming,
                    [c.line("devices.renameLabel"), c.line("common.save"), c.line("common.cancel")])
            }
            if edit.kind == "remove" {
                return KitScreen(
                    .confirming,
                    [
                        c.line("devices.removeConfirm", ["device": device, "product": c.product]),
                        c.line("devices.remove"), c.line("common.cancel"),
                    ])
            }
        }
        guard let devices = i.devices else {
            return KitScreen(.loading, [title, c.line("common.loading")])
        }
        if devices.isEmpty { return KitScreen(.empty, [c.line("devices.empty")]) }
        var lines = [
            title, c.line("devices.lede"),
            c.line("devices.count", ["count": .number(devices.count)]),
            c.line("devices.meta", ["platform": "", "when": ""]),
        ]
        if let current = devices.first(where: \.current) {
            lines.append(
                c.line("part.thisDeviceTitle", ["formFactor": .text(current.formFactor.rawValue)]))
        }
        if devices.contains(where: { KitIdentity.nonEmpty($0.name) == nil }) {
            lines.append(c.line("devices.unnamed"))
        }
        lines += [
            c.line("devices.rename"), c.line("devices.remove"),
            c.line("a11y.renameDevice", ["device": ""]),
            c.line("a11y.removeDevice", ["device": ""]),
            c.line("a11y.formFactor", ["formFactor": ""]),
        ]
        return KitScreen(.list, lines)
    }
}

extension Ctx {
    /// The device a Replace preselects: the one seen longest ago.
    var leastRecentDevice: KitDevice? {
        (i.devices ?? []).filter { !$0.current }.max { $0.lastSeenDays < $1.lastSeenDays }
    }
}
