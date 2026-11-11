// @pkey-feature connect.local
// PairedDevices, the SwiftUI kit (CC-29K.2): what this device paired with by a code, one row each.
// The reference is the React kit (packages/sdk-react/src/kit/localPairing.tsx) and ui-core's
// models/local.ts. Rules kept:
//   - the Can connect column shows only with more than 8 paired or one off (`kitShowSwitchColumn`),
//     and every switch is named for its device ("Let {device} connect to this device");
//   - each row has one options menu (Rename, Forget); both work in the row, and Forget asks there;
//   - after an edit focus returns to the row's menu button, after a Forget to the next row or the title;
//   - the list says nothing about what is paired until the first read answers (the loading state);
//   - Pair with a Code is the one primary, drawn unavailable (still pressable) when the device holds 32;
//   - device names are unauthenticated text, isolated and never bold as a heading.

import PolarisKeyUICore
import SwiftUI

private enum PairedFocus: Hashable {
    case title
    case row(String)
    case field
}

public struct PairedDevicesView: View {
    let model: PairedDevicesModel
    @Environment(\.polarisKeyStrings) private var strings
    @AccessibilityFocusState private var focus: PairedFocus?
    @FocusState private var fieldFocus: Bool
    @State private var last: KitScreen<PairedDevicesState>?

    public init(model: PairedDevicesModel) { self.model = model }

    public var body: some View {
        let live = model.screen
        let screen = live.state != nil ? live : (last ?? live)
        if let state = screen.state {
            KitScreenScaffold(header: false, dockActions: false) {
                heading(screen)
            } content: {
                content(screen, state)
            } actions: {
                actions(screen, state)
            }
            .onChange(of: live.stateName, initial: true) { _, _ in
                if live.state != nil { last = live }
            }
            .task { await model.start() }
            .onAppear { focus = .title }
            .onDisappear { model.stop() }
            .onChange(of: model.focus) { _, new in
                switch new {
                case .row(let id): focus = .row(id)
                case .title: focus = .title
                case nil: break
                }
            }
            .onChange(of: model.state.step) { _, step in
                if step == .renaming { fieldFocus = true }
                if step == .forgetting { focus = .title }
            }
            .onChange(of: model.state.notice?.kind) { _, kind in
                if kind != nil, let l = screen.copy.first(where: { $0.key.hasSuffix("Title") }) {
                    announce(strings.string(l))
                }
            }
            .background(escapeCloses(state))
        }
    }

    @ViewBuilder private func escapeCloses(_ state: PairedDevicesState) -> some View {
        Button("") {
            if model.state.step == .renaming || model.state.step == .forgetting {
                model.cancelEdit()
            } else {
                model.done()
            }
        }
        .keyboardShortcut(.cancelAction)
        .focusable(false)
        .opacity(0).frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    private func heading(_ screen: KitScreen<PairedDevicesState>) -> some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.xs)) {
                KitText(screen.lineOrKey("pairedDevices.title"), .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($focus, equals: .title)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if screen.state != .loading, screen.state != .loadFailed, screen.state != .off,
                    let lede = screen.line("pairedDevices.lede")
                {
                    KitText(lede, .body, color: .muted)
                }
            }
        }
    }

    // MARK: Content

    @ViewBuilder private func content(_ screen: KitScreen<PairedDevicesState>, _ state: PairedDevicesState)
        -> some View
    {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                switch state {
                case .loading:
                    // Nothing is said about what is paired until the read answers.
                    HStack(spacing: style.space(.sm)) {
                        ProgressView().controlSize(.small).accessibilityHidden(true)
                        KitText(screen.lineOrKey("a11y.busy"), .body, color: .muted)
                    }
                    .accessibilityElement(children: .combine)
                case .loadFailed:
                    errorLine(screen.lineOrKey("pairedDevices.loadFailed"), style)
                case .empty:
                    KitText(screen.lineOrKey("pairedDevices.empty"), .body, color: .muted)
                case .off:
                    if let t = screen.line("core.codes.local-pairing-off.title") {
                        banner(t, body: screen.line("pairedDevices.offBody"), style)
                    }
                    rows(screen, style)
                case .list, .renaming, .forgetting:
                    banners(screen, style)
                    rows(screen, style)
                }
            }
        }
    }

    @ViewBuilder private func banners(_ screen: KitScreen<PairedDevicesState>, _ style: KitResolvedStyle)
        -> some View
    {
        if model.state.step == .list {
            if let t = screen.line("pairedDevices.reachableFullTitle") {
                banner(t, body: screen.line("pairedDevices.reachableFullBody"), style)
            }
            if let t = screen.line("core.codes.local-links-full.title") {
                banner(t, body: screen.line("pairedDevices.fullBody"), style)
            }
            if let n = model.inputs.pairedDevices?.notice {
                hostNotice(n, screen, style)
            }
        }
    }

    @ViewBuilder private func hostNotice(
        _ n: KitPairedDevices.Notice, _ screen: KitScreen<PairedDevicesState>, _ style: KitResolvedStyle
    ) -> some View {
        switch n.kind {
        case .notFound:
            banner(
                screen.lineOrKey("pairedDevices.notFoundTitle"),
                body: screen.line("pairedDevices.notFoundBody"), style)
        case .busy:
            banner(screen.lineOrKey("pairedDevices.busyTitle"), body: nil, style) {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Text(strings.string("common.tryAgain")).underline()
                        .font(style.font(.body).weight(.medium))
                        .foregroundStyle(style.palette.accentFg)
                        .frame(minHeight: 44, alignment: .leading)
                }
                .buttonStyle(.plain)
            }
        case .unknown:
            banner(
                screen.lineOrKey("core.codes.link-unknown.title"),
                body: screen.line("core.codes.link-unknown.message"), style)
        }
    }

    private func banner(
        _ title: CopyLine, body: CopyLine?, _ style: KitResolvedStyle,
        @ViewBuilder trailing: () -> some View = { EmptyView() }
    ) -> some View {
        HStack(alignment: .top, spacing: style.space(.sm)) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(style.palette.textMuted).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: style.space(.xxs)) {
                KitText(title, .label, color: .strong)
                if let body { KitText(body, .body) }
                trailing()
            }
            Spacer(minLength: 0)
        }
        .padding(style.space(.md))
        .background(
            RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                .fill(style.palette.raised)
        )
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private func errorLine(_ line: CopyLine, _ style: KitResolvedStyle) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(style.palette.danger).accessibilityHidden(true)
            KitText(line, .body, color: .danger)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Rows

    private func when(_ seconds: Int) -> String {
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: strings.locale)
        f.unitsStyle = .full
        return f.localizedString(for: Date(timeIntervalSince1970: Double(seconds)), relativeTo: Date())
    }

    @ViewBuilder private func rows(_ screen: KitScreen<PairedDevicesState>, _ style: KitResolvedStyle)
        -> some View
    {
        let devices = model.state.devices ?? []
        let switches = kitShowSwitchColumn(devices)
        VStack(spacing: 0) {
            if switches, let head = screen.line("pairedDevices.canConnect") {
                HStack {
                    Spacer()
                    KitText(head, .meta, color: .muted)
                }
                .padding(.bottom, style.space(.xxs))
                .accessibilityHidden(true)
            }
            ForEach(Array(devices.enumerated()), id: \.element.id) { index, device in
                row(device, screen, switches: switches, style)
                if index < devices.count - 1 {
                    Divider().overlay(style.palette.border)
                }
            }
        }
    }

    @ViewBuilder private func row(
        _ d: KitPairedDevice, _ screen: KitScreen<PairedDevicesState>, switches: Bool,
        _ style: KitResolvedStyle
    ) -> some View {
        let editing = model.state.target == d.id
        let renaming = editing && model.state.step == .renaming
        let forgetting = editing && model.state.step == .forgetting
        let name = d.label?.isEmpty == false ? d.label! : strings.string("devices.unnamed")
        VStack(alignment: .leading, spacing: style.space(.xs)) {
            if renaming {
                renameField(d, screen, style)
            } else if forgetting {
                forgetQuestion(d, screen, style)
            } else {
                HStack(spacing: style.space(.sm)) {
                    Image(systemName: glyph(d.platform))
                        .foregroundStyle(style.palette.textMuted)
                        .frame(width: 28).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(kitIsolate(name)).font(style.font(.body))
                            .foregroundStyle(style.palette.textStrong)
                            .lineLimit(2)
                        if let seen = d.lastSeen {
                            KitText(
                                CopyLine("pairedDevices.lastSeen", ["when": .text(when(seen))]),
                                .meta, color: .muted)
                        }
                    }
                    Spacer(minLength: style.space(.xs))
                    if switches {
                        Toggle(
                            "",
                            isOn: Binding(
                                get: { d.reachable },
                                set: { on in Task { await model.setReachable(d.id, on) } })
                        )
                        .labelsHidden()
                        #if os(macOS)
                            .toggleStyle(.switch)
                        #endif
                        .tint(style.palette.accentSolid)
                        .accessibilityLabel(
                            strings.string("a11y.letConnect", ["device": .text(kitIsolate(name))]))
                    }
                    menu(d, name)
                }
                .frame(minHeight: 56)
            }
        }
        .padding(.vertical, style.space(.xs))
        .background(editing ? style.palette.accentSubtle.opacity(0.5) : .clear)
    }

    private func glyph(_ platform: String?) -> String {
        switch platform {
        case "ios", "ipados": return "iphone"
        case "android": return "smartphone"
        case "macos": return "laptopcomputer"
        case "windows", "linux": return "desktopcomputer"
        default: return "circle.dashed"
        }
    }

    private func menu(_ d: KitPairedDevice, _ name: String) -> some View {
        Menu {
            Button(strings.string("devices.rename")) { model.startRename(d.id) }
            Button(strings.string("pairedDevices.forget"), role: .destructive) { model.askForget(d.id) }
        } label: {
            Image(systemName: "ellipsis")
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        #if os(macOS)
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        #endif
        .accessibilityLabel(
            strings.string("a11y.deviceOptions", ["device": .text(kitIsolate(name))])
        )
        .accessibilityFocused($focus, equals: .row(d.id))
    }

    private func renameField(
        _ d: KitPairedDevice, _ screen: KitScreen<PairedDevicesState>, _ style: KitResolvedStyle
    ) -> some View {
        let e = model.state.renameError
        let message: CopyLine? =
            e == .long
            ? screen.line("pairedDevices.renameLong")
            : e == .empty
                ? screen.line("pairedDevices.renameEmpty")
                : e == .failed ? screen.line("devices.renameFailed") : nil
        return VStack(alignment: .leading, spacing: style.space(.xs)) {
            TextField(
                strings.string("devices.renameLabel"),
                text: Binding(get: { model.draft }, set: { model.setDraft($0) })
            )
            .textFieldStyle(.roundedBorder)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .focused($fieldFocus)
            .onSubmit { Task { await model.saveRename() } }
            .frame(minHeight: 44)
            .accessibilityValue(message.map { Text(strings.string($0)) } ?? Text(""))
            if let message {
                errorLine(message, style)
            } else if let hint = screen.line("localPairing.nameHint") {
                KitText(hint, .meta, color: .muted)
            }
            HStack {
                Button {
                    model.cancelEdit()
                } label: {
                    Text(strings.string("common.cancel")).frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                Spacer()
                Button {
                    Task { await model.saveRename() }
                } label: {
                    Text(strings.string("common.save")).fontWeight(.semibold)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
            }
            .buttonStyle(.borderless)
            .tint(style.palette.accentFg)
        }
    }

    private func forgetQuestion(
        _ d: KitPairedDevice, _ screen: KitScreen<PairedDevicesState>, _ style: KitResolvedStyle
    ) -> some View {
        VStack(alignment: .leading, spacing: style.space(.xs)) {
            KitText(screen.lineOrKey("pairedDevices.forgetConfirm"), .label, color: .strong)
            if let body = screen.line("pairedDevices.forgetBody") { KitText(body, .body) }
            if model.state.forgetError == true, let failed = screen.line("pairedDevices.forgetFailed") {
                errorLine(failed, style)
            }
            HStack {
                Button {
                    model.cancelEdit()
                } label: {
                    Text(strings.string("common.cancel")).frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                Spacer()
                Button(role: .destructive) {
                    Task { await model.confirmForget() }
                } label: {
                    Text(strings.string("pairedDevices.forget")).fontWeight(.semibold)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
            }
            .buttonStyle(.borderless)
        }
    }

    // MARK: Actions

    @ViewBuilder private func actions(_ screen: KitScreen<PairedDevicesState>, _ state: PairedDevicesState)
        -> some View
    {
        let full = screen.disabledKeys.contains("pairedDevices.pair")
        KitActionStack {
            switch state {
            case .loading, .off:
                KitButton(line: CopyLine("common.done"), kind: .primary) { model.done() }
            case .loadFailed:
                KitButton(line: CopyLine("common.tryAgain"), kind: .primary) {
                    Task { await model.refresh() }
                }
                KitButton(line: CopyLine("common.done"), kind: .quiet) { model.done() }
            case .empty:
                KitButton(line: screen.lineOrKey("pairedDevices.pair"), kind: .primary) {
                    model.requestPair()
                }
                KitButton(line: CopyLine("common.done"), kind: .quiet) { model.done() }
            case .list:
                KitButton(line: screen.lineOrKey("pairedDevices.pair"), kind: .primary) {
                    if !full { model.requestPair() }
                }
                .opacity(full ? 0.5 : 1)
                KitButton(line: CopyLine("common.done"), kind: .quiet) { model.done() }
            case .renaming, .forgetting:
                // The row being edited owns the filled control; Done waits for the edit to end.
                KitButton(line: CopyLine("common.done"), kind: .quiet) { model.done() }
            }
        }
    }
}
