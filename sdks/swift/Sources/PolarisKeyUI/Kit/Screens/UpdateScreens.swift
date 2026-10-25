// @pkey-feature ui.update
// UpdatePrompt, UpdateProgress and ReleaseNotes (UI-KITS §4.3). On iOS a non-mandatory update is a
// glass banner floating above the bottom safe area (never over the navigation bar or the large
// title); only a mandatory update owns the screen, with no dismissal. The verb follows the outlet
// ("Update on the App Store"); the copy never says installed before the apply.

import PolarisKeyUICore
import SwiftUI

/// The update offer: a banner, or the mandatory screen.
public struct UpdatePromptView: View {
    let screen: KitScreen<UpdatePromptState>
    /// The download's fraction while `downloading`, from counted bytes.
    var fraction: Double?
    /// The update verb, or nil when the host has no way to update: the verb then does not draw
    /// (UI-KITS decision 7) and the mandatory screen says where to update instead.
    var onUpdate: (() -> Void)?
    var onLater: () -> Void
    /// The offer's own facts (running version, size, notes, changes page), when the host has them.
    var details: KitUpdate?
    @Environment(\.openURL) private var openURL
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<UpdatePromptState>, fraction: Double? = nil,
        details: KitUpdate? = nil, onUpdate: (() -> Void)?, onLater: @escaping () -> Void
    ) {
        self.screen = screen
        self.details = details
        self.fraction = fraction
        self.onUpdate = onUpdate
        self.onLater = onLater
    }

    public var body: some View {
        switch screen.state {
        case .mandatory, .revokedRequiredContent:
            KitScreenScaffold(hero: true, header: false) {
                if let title = screen.line("update.mandatoryTitle")
                    ?? screen.line("core.codes.pack-revoked.title")
                {
                    KitText(title, .title, color: .strong, alignment: .center)
                        .accessibilityAddTraits(.isHeader)
                }
            } content: {
                if let body = screen.line("update.mandatoryBody")
                    ?? screen.line("update.revokedContent")
                {
                    KitText(body, .body, color: .default, alignment: .center)
                }
                mandatoryFacts
            } actions: {
                if let onUpdate {
                    KitButton(line: mandatoryVerb, kind: .primary, action: onUpdate)
                        .keyboardShortcut(.defaultAction)
                }
            }
        case .none, .upToDate, .blocked:
            EmptyView()
        default:
            banner
        }
    }

    /// The verb the outlet allows on the mandatory screen ("Update on the App Store"), else Update now.
    private var mandatoryVerb: CopyLine {
        KitStates.outletVerb(details?.outlet) ?? CopyLine("update.install")
    }

    /// The mandatory screen's facts: the version it asks for, the notes, and where to update when
    /// the kit has no button to press.
    @ViewBuilder private var mandatoryFacts: some View {
        kitStyle { style in
            VStack(spacing: style.space(.xs)) {
                if let version = details?.version, !version.isEmpty {
                    KitText(
                        CopyLine(
                            "update.title",
                            ["product": .text(style.identity.name), "version": .text(version)]),
                        .label, color: .strong, alignment: .center)
                }
                if hasBody { whatsNew }
                if onUpdate == nil {
                    KitText(
                        KitStates.whereToUpdate(
                            outlet: details?.outlet, product: style.identity.name),
                        .body, color: .default, alignment: .center)
                }
            }
        }
    }

    private var showsFacts: Bool { screen.state == .available || screen.state == .mandatory }

    /// "You have 2.4.1 · 61 MB download"; "You have 2.4.1" when the decision carries no size.
    private var currentLine: CopyLine? {
        guard screen.state == .available, let version = details?.currentVersion else { return nil }
        guard let bytes = details?.sizeBytes else {
            return CopyLine("common.updateCurrentNoSize", ["version": .text(version)])
        }
        return CopyLine(
            "update.current", ["version": .text(version), "size": .text(KitFormat.bytes(bytes))])
    }

    /// At most three plain lines of the release's notes (§4.3).
    private var noteLines: [String] {
        guard showsFacts else { return [] }
        return Self.noteLines(details?.notes)
    }

    static func noteLines(_ notes: [String]?) -> [String] {
        Array((notes ?? []).filter { !$0.isEmpty }.prefix(3))
    }

    private var changesLink: URL? {
        guard showsFacts else { return nil }
        return KitLinks.valid(details?.notesUrl)
    }

    /// "About 4 min" or "Less than a minute", with tabular figures (§4.3).
    private var timeLeftLine: CopyLine? {
        guard let seconds = details?.progress?.secondsLeft else {
            return screen.line("update.timeLeft").flatMap { $0.isComplete() ? $0 : nil }
        }
        return KitFormat.timeLeftLine(seconds)
    }

    private var hasBody: Bool { !noteLines.isEmpty || changesLink != nil }

    private var banner: some View {
        KitBanner(
            leading: { ProductIcon(size: 56) },
            text: {
                KitText(
                    screen.line("update.title") ?? screen.line("update.readyTitle")
                        ?? screen.lineOrKey("update.availableTitle"), .label, color: .strong)
                if let current = currentLine { KitText(current, .footnote, color: .muted) }
                if let detail = screen.line("update.readyBody") ?? screen.line("update.critical") {
                    KitText(detail, .footnote, color: .muted)
                }
                if hasBody { whatsNew }
                if screen.state == .downloading {
                    if let line = screen.line("update.downloading"), line.isComplete() {
                        KitText(line, .footnote, color: .muted).monospacedDigit()
                    }
                    if let line = timeLeftLine {
                        KitText(line, .footnote, color: .muted).monospacedDigit()
                    }
                    if let fraction { ProgressBar(fraction: fraction) }
                }
            },
            actions: {
                // One dismissal plus the verb (§4.1), where the state offers one. While a
                // download runs the verb is Restart when ready, never a disabled button.
                if let later = screen.line("update.later") {
                    KitButton(
                        line: later, kind: .secondary, fullWidth: false, compact: true,
                        action: onLater)
                }
                if let onUpdate {
                    KitButton(
                        line: verb, kind: .primary, fullWidth: false, compact: true,
                        action: onUpdate)
                }
            }, stacked: hasBody)
    }

    @ViewBuilder private var whatsNew: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: 2) {
                if !noteLines.isEmpty, let label = screen.line("update.whatsNew") {
                    KitText(label, .footnote, color: .strong)
                        .accessibilityAddTraits(.isHeader)
                        .padding(.top, style.space(.xs))
                    ForEach(noteLines, id: \.self) {
                        Text(verbatim: $0).font(style.font(.footnote))
                            .foregroundStyle(style.palette.textDefault)
                    }
                }
                if let link = changesLink, let all = screen.line("update.allChanges") {
                    Button {
                        openURL(link)
                    } label: {
                        HStack(spacing: 4) {
                            Text(strings.string(all)).font(style.font(.footnote))
                            Image(systemName: "arrow.up.right").font(style.font(.footnote))
                                .accessibilityHidden(true)
                        }
                        .foregroundStyle(style.palette.accentFg)
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// The verb the outlet allows.
    private var verb: CopyLine {
        // While a download runs the primary is Restart when ready (§4.3), Later the secondary.
        let keys = ["update.appStore", "update.testflight", "update.altstore", "update.restartNow"]
        for key in screen.state == .downloading ? keys + ["update.restartWhenReady"] : keys {
            if let line = screen.line(key) { return line }
        }
        return CopyLine("update.install")
    }
}

/// Download and install progress, as one inline row: a determinate bar only for counted bytes.
public struct UpdateProgressView: View {
    let screen: KitScreen<UpdateProgressState>
    let fraction: Double?
    var onRetry: () -> Void
    /// What is downloading ("Tidewater Studio 2.5.0"); nil draws the row untitled.
    var title: CopyLine?

    public init(
        screen: KitScreen<UpdateProgressState>, fraction: Double?, title: CopyLine? = nil,
        onRetry: @escaping () -> Void
    ) {
        self.screen = screen
        self.fraction = fraction
        self.title = title
        self.onRetry = onRetry
    }

    public var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.xs)) {
                if let title { KitText(title, .label, color: .strong) }
                // A line whose counts are unknown is not drawn: never "40% of 100%".
                ForEach(
                    screen.copy.filter {
                        !$0.key.hasPrefix("a11y.") && $0.key != "common.tryAgain"
                            && $0.isComplete()
                    }, id: \.key
                ) {
                    KitText($0, .meta, color: .default)
                }
                if screen.state == .downloading, let fraction {
                    ProgressBar(fraction: fraction)
                }
                if screen.state == .failed {
                    KitButton(
                        line: CopyLine("common.tryAgain"), kind: .secondary, fullWidth: false,
                        action: onRetry)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// The changelog. Notes are plain text: remote markup shows as text and never runs.
public struct ReleaseNotesView: View {
    let screen: KitScreen<ReleaseNotesState>
    let notes: [KitReleaseNote]
    var onRetry: () -> Void

    public init(
        screen: KitScreen<ReleaseNotesState>, notes: [KitReleaseNote], onRetry: @escaping () -> Void
    ) {
        self.screen = screen
        self.notes = notes
        self.onRetry = onRetry
    }

    public var body: some View {
        kitStyle { style in
            List {
                switch screen.state {
                case .loading:
                    LoadingIndicator(CopyLine("common.loading"))
                case .error:
                    KitText(CopyLine("releaseNotes.error"), .body, color: .default)
                    KitButton(line: CopyLine("common.tryAgain"), kind: .secondary, action: onRetry)
                case .empty:
                    KitText(CopyLine("releaseNotes.empty"), .body, color: .default)
                case .list:
                    // The title is a heading in the content, wrapped, rather than a navigation
                    // title the bar would truncate ("What's new in Tidewate…").
                    if let title = screen.line("releaseNotes.title") {
                        KitText(title, .title, color: .strong)
                            .accessibilityAddTraits(.isHeader)
                            .listRowBackground(Color.clear)
                    }
                    ForEach(notes, id: \.version) { note in
                        Section {
                            Text(verbatim: note.notes)
                                .font(style.font(.body))
                                .foregroundStyle(style.palette.textDefault)
                        } header: {
                            HStack {
                                KitText(
                                    CopyLine(
                                        "releaseNotes.version", ["version": .text(note.version)]),
                                    .label, color: .strong)
                                Spacer()
                                KitText(
                                    CopyLine(
                                        "releaseNotes.released",
                                        ["date": .text(KitFormat.day(note.date))]),
                                    .footnote, color: .muted)
                            }
                        }
                    }
                case .none:
                    EmptyView()
                }
            }
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
        }
    }
}

// MARK: - The Mac update window (UK-08.6)

#if os(macOS)
    import Observation

    /// What the Mac update window is showing (UI-KITS §4.3 on macOS; the mockup `desktop-update`).
    public enum UpdateWindowKind: String, Sendable, CaseIterable {
        /// The one-time ask: check for updates automatically? Answered by a button only.
        case permission
        /// A check is running; the offer is not known yet.
        case checking
        /// An update is offered: Skip This Version, Remind Me Later, Install Update (or, when it is
        /// already downloaded, Install on Quit and Install and Relaunch).
        case found
        /// The download runs: real bytes, or an indeterminate bar while the total is unknown.
        case downloading
        /// The download is unpacked and checked: indeterminate.
        case extracting
        /// Ready to install: Install on Quit, Install and Relaunch.
        case ready
        /// The installer runs: indeterminate.
        case installing
        /// The installer waits for the app to quit: Quit and Install.
        case quitToInstall
        /// "You’re up to date".
        case upToDate
        /// The error callout and Try Again (or Done, when trying again cannot help).
        case failed
    }

    /// What an error is, in the kit's own short copy.
    public enum UpdateErrorKind: String, Sendable, CaseIterable {
        /// The update server or the download could not be reached: trying again can help.
        case network
        /// The update needs a different macOS or hardware: trying again cannot help.
        case cannotInstall
        /// The signature or validation failed: trying again cannot help.
        case security
        /// Anything else: Sparkle's own words, trying again can help.
        case other

        /// Whether Try Again is offered.
        public var canRetry: Bool { self == .network || self == .other }
    }

    /// One screen of the update window: the kind, the offer's facts (`update`) and the update
    /// family's kit state for it (`prompt` and `progress`), which the mapping table pins.
    public struct UpdateWindowState: Sendable, Equatable {
        public var kind: UpdateWindowKind
        /// The offer and its download, in the kit's own terms: `action` `binary` (an offer and its
        /// download), `code-ready` (ready), `none` (up to date); `progress` carries the phase.
        public var update: KitUpdate?
        /// The error's own words (failed, `other` only).
        public var detail: String?
        public var errorKind: UpdateErrorKind
        /// False for a critical update: it cannot be skipped.
        public var canSkip: Bool
        /// False for a critical update, or when Sparkle does not check by itself: there is no
        /// later to be reminded at.
        public var canLater: Bool
        /// The update is already downloaded (Sparkle's stage): the primary installs it.
        public var downloaded: Bool
        /// An update with only a web page (the app cannot install it): the primary opens it.
        public var infoOnly: Bool

        public init(
            kind: UpdateWindowKind, update: KitUpdate? = nil, detail: String? = nil,
            errorKind: UpdateErrorKind = .other, canSkip: Bool = true, canLater: Bool = true,
            downloaded: Bool = false, infoOnly: Bool = false
        ) {
            self.kind = kind
            self.update = update
            self.detail = detail
            self.errorKind = errorKind
            self.canSkip = canSkip
            self.canLater = canLater
            self.downloaded = downloaded
            self.infoOnly = infoOnly
        }

        /// The UpdatePrompt state of this screen (found, downloading, ready, up to date).
        public func prompt(in base: KitInputs) -> KitScreen<UpdatePromptState> {
            var inputs = base
            inputs.update = update
            return KitStates.updatePrompt(inputs)
        }

        /// The UpdateProgress state of this screen (extracting and installing are `installing`,
        /// an error is `failed`).
        public func progress(in base: KitInputs) -> KitScreen<UpdateProgressState> {
            var inputs = base
            inputs.update = update
            return KitStates.updateProgress(inputs)
        }
    }

    /// What each control of the window does. The driver wires every one to one Sparkle reply.
    public struct UpdateWindowHandlers {
        public var install: @MainActor () -> Void
        public var later: @MainActor () -> Void
        public var skip: @MainActor () -> Void
        public var cancel: @MainActor () -> Void
        public var tryAgain: @MainActor () -> Void
        public var done: @MainActor () -> Void
        public var allow: @MainActor () -> Void
        public var decline: @MainActor () -> Void
        public var learnMore: @MainActor () -> Void
        public var quitAndInstall: @MainActor () -> Void

        public init(
            install: @escaping @MainActor () -> Void = {},
            later: @escaping @MainActor () -> Void = {},
            skip: @escaping @MainActor () -> Void = {},
            cancel: @escaping @MainActor () -> Void = {},
            tryAgain: @escaping @MainActor () -> Void = {},
            done: @escaping @MainActor () -> Void = {},
            allow: @escaping @MainActor () -> Void = {},
            decline: @escaping @MainActor () -> Void = {},
            learnMore: @escaping @MainActor () -> Void = {},
            quitAndInstall: @escaping @MainActor () -> Void = {}
        ) {
            self.install = install
            self.later = later
            self.skip = skip
            self.cancel = cancel
            self.tryAgain = tryAgain
            self.done = done
            self.allow = allow
            self.decline = decline
            self.learnMore = learnMore
            self.quitAndInstall = quitAndInstall
        }
    }

    /// The window's state, observed by `UpdateWindowView`. `gate` is the identity and style source
    /// (the product's name and icon, the theme), never a gate: nothing here touches the licence.
    @MainActor @Observable
    public final class UpdateWindowModel {
        public var state: UpdateWindowState
        public var handlers: UpdateWindowHandlers
        @ObservationIgnored public let gate: PolarisKeyGateModel

        public init(
            gate: PolarisKeyGateModel, state: UpdateWindowState = UpdateWindowState(kind: .checking),
            handlers: UpdateWindowHandlers = UpdateWindowHandlers()
        ) {
            self.gate = gate
            self.state = state
            self.handlers = handlers
        }

        public var prompt: KitScreen<UpdatePromptState> { state.prompt(in: gate.inputs) }
        public var progress: KitScreen<UpdateProgressState> { state.progress(in: gate.inputs) }
    }

    /// The Mac update window's content: one column, the product icon over the facts, the download
    /// beside its numbers, the actions in a row. Hosted by an `NSWindow` that sizes to it.
    public struct UpdateWindowView: View {
        let model: UpdateWindowModel

        /// The content's width: 480 pt (528 pt with the padding): the mockup's three buttons need more than 432 pt at the kit's Mac button size.
        public static let contentWidth: CGFloat = 480

        public init(model: UpdateWindowModel) { self.model = model }

        public var body: some View {
            PolarisKeyScope(model: model.gate) {
                UpdateWindowContent(model: model)
            }
        }
    }

    /// One button of the window's row.
    private typealias UpdateControl = (key: String, action: @MainActor () -> Void)

    struct UpdateWindowContent: View {
        let model: UpdateWindowModel
        @Environment(\.polarisKeyStrings) private var strings
        @AccessibilityFocusState private var calloutFocused: Bool

        private var state: UpdateWindowState { model.state }
        private var handlers: UpdateWindowHandlers { model.handlers }

        var body: some View {
            kitStyle { style in
                VStack(alignment: .leading, spacing: style.space(.md)) {
                    if state.kind == .failed {
                        callout(style)
                    } else {
                        header(style)
                        facts(style)
                        progressBlock(style)
                        actions
                    }
                }
                // The title bar is transparent over the window's colour (raised in dark, the page
                // in light: the secondary buttons are white): 16 pt under it, as the mockup.
                .padding(.horizontal, style.space(.lg))
                .padding(.top, style.space(.md))
                .padding(.bottom, style.space(.lg))
                .frame(width: UpdateWindowView.contentWidth + 48, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .background((style.dark ? style.palette.raised : style.palette.page).ignoresSafeArea())
                .accessibilityElement(children: .contain)
            }
        }

        // MARK: Header

        private func header(_ style: KitResolvedStyle) -> some View {
            HStack(alignment: .center, spacing: style.space(.md)) {
                ProductIcon(size: 64)
                VStack(alignment: .leading, spacing: style.space(.xxs)) {
                    // 17 pt semibold, the mockup's title (the kit's headline step is 15 on the Mac).
                    Text(strings.string(titleLine(style)))
                        .font(.custom(PolarisKit.fontFamily, size: 17, relativeTo: .title3).weight(.semibold))
                        .foregroundStyle(style.palette.textStrong)
                        .accessibilityAddTraits(.isHeader)
                    if let sub = subtitleLine { KitText(sub, .meta, color: .muted) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }

        private func titleLine(_ style: KitResolvedStyle) -> CopyLine {
            let product = style.identity.name
            let version = state.update?.version ?? ""
            switch state.kind {
            case .permission: return CopyLine("common.updatePermissionTitle")
            case .checking: return CopyLine("common.updateChecking")
            case .quitToInstall:
                return CopyLine("common.updateQuitToInstall", ["product": .text(product)])
            case .ready:
                return CopyLine(
                    "update.readyTitle", ["product": .text(product), "version": .text(version)])
            case .upToDate: return CopyLine("update.upToDate")
            default:
                return version.isEmpty
                    ? CopyLine("update.availableTitle")
                    : CopyLine(
                        "update.title", ["product": .text(product), "version": .text(version)])
            }
        }

        /// "You have 2.4.1 · 61 MB download" while the offer is a download still to make; just
        /// "You have 2.4.1" once it is under way, downloaded or installing, and when up to date.
        private var subtitleLine: CopyLine? {
            guard let current = state.update?.currentVersion else { return nil }
            switch state.kind {
            case .found where !state.downloaded:
                guard let bytes = state.update?.sizeBytes else {
                    return CopyLine("common.updateCurrentNoSize", ["version": .text(current)])
                }
                return CopyLine(
                    "update.current",
                    ["version": .text(current), "size": .text(KitFormat.bytes(bytes))])
            case .found, .downloading, .extracting, .installing, .ready, .upToDate:
                return CopyLine("common.updateCurrentNoSize", ["version": .text(current)])
            default: return nil
            }
        }

        // MARK: Facts: the ask, the notes, the link

        @ViewBuilder private func facts(_ style: KitResolvedStyle) -> some View {
            switch state.kind {
            case .permission:
                KitText(
                    CopyLine("common.updatePermissionBody", ["product": .text(style.identity.name)]),
                    .body, color: .default)
            case .found, .downloading:
                let notes = UpdatePromptView.noteLines(state.update?.notes)
                let link = KitLinks.valid(state.update?.notesUrl)
                VStack(alignment: .leading, spacing: style.space(.xs)) {
                    ForEach(notes, id: \.self) {
                        Text(verbatim: $0).font(style.font(.body))
                            .foregroundStyle(style.palette.textDefault)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let link, !state.infoOnly {
                        // KitLinks.valid above: https, or http to the loopback, only.
                        Link(destination: link) {
                            HStack(spacing: style.space(.xxs)) {
                                // Sentence case, as the mockup: the link is not a button label.
                                Text(
                                    strings.catalog.format(
                                        "update.allChanges", locale: strings.locale,
                                        args: ["version": .text(state.update?.version ?? "")],
                                        variant: nil)
                                )
                                .font(style.font(.body))
                                Image(systemName: "arrow.up.right").font(style.font(.footnote))
                                    .accessibilityHidden(true)
                            }
                            .foregroundStyle(style.palette.accentFg)
                        }
                        .buttonStyle(.plain)
                    }
                }
            default:
                EmptyView()
            }
        }

        // MARK: Progress

        @ViewBuilder private func progressBlock(_ style: KitResolvedStyle) -> some View {
            switch state.kind {
            case .checking:
                indeterminate(style)
            case .downloading:
                VStack(alignment: .leading, spacing: style.space(.xs)) {
                    if let fraction = state.update?.progress?.fraction {
                        ProgressBar(fraction: fraction)
                    } else {
                        indeterminate(style)
                    }
                    HStack(alignment: .firstTextBaseline) {
                        if let line = downloadedLine {
                            KitText(line, .footnote, color: .muted).monospacedDigit()
                        }
                        Spacer(minLength: style.space(.sm))
                        if let line = timeLeftLine {
                            KitText(line, .footnote, color: .muted).monospacedDigit()
                        }
                    }
                }
                .accessibilityElement(children: .combine)
            case .extracting, .installing:
                VStack(alignment: .leading, spacing: style.space(.xs)) {
                    indeterminate(style)
                    KitText(
                        CopyLine(
                            state.kind == .extracting
                                ? "update.verifying" : "updateProgress.installing"),
                        .footnote, color: .muted)
                }
                .accessibilityElement(children: .combine)
            default:
                EmptyView()
            }
        }

        /// A bar with no value: the total is unknown, or the step has no count. No percentage.
        private func indeterminate(_ style: KitResolvedStyle) -> some View {
            ProgressView()
                .progressViewStyle(.linear)
                .tint(style.palette.accentSolid)
                .accessibilityLabel(Text(strings.string("common.updateProgressLabel")))
        }

        /// "Downloading · 38 MB of 61 MB" while both counts are known, "Downloading · 12 MB" while
        /// only the bytes received are.
        private var downloadedLine: CopyLine? {
            guard let p = state.update?.progress, let done = p.bytes, done > 0 else { return nil }
            if let total = p.totalBytes, total > 0 {
                return CopyLine(
                    "update.downloading",
                    ["size": .text(KitFormat.bytes(done)), "total": .text(KitFormat.bytes(total))])
            }
            return CopyLine("common.updateDownloadingBytes", ["size": .text(KitFormat.bytes(done))])
        }

        /// "About 20 seconds left", only while the download estimates it.
        private var timeLeftLine: CopyLine? {
            guard let seconds = state.update?.progress?.secondsLeft else { return nil }
            return CopyLine("update.timeLeft", ["time": .text(Self.duration(seconds))])
        }

        /// "20 seconds" or "4 minutes", in the locale, rounded up to a whole unit.
        static func duration(_ seconds: Double, locale: Locale = .current) -> String {
            var calendar = Calendar.current
            calendar.locale = locale
            let formatter = DateComponentsFormatter()
            formatter.calendar = calendar
            formatter.unitsStyle = .full
            formatter.maximumUnitCount = 1
            if seconds < 60 {
                formatter.allowedUnits = [.second]
                return formatter.string(from: max(1, seconds.rounded(.up))) ?? ""
            }
            formatter.allowedUnits = [.minute]
            return formatter.string(from: (seconds / 60).rounded(.up) * 60) ?? ""
        }

        // MARK: Actions

        /// The row's controls: Skip at the leading edge, then (trailing) the dismissal, which
        /// Escape takes, and the primary, which Return takes.
        struct Controls {
            var leading: (key: String, action: @MainActor () -> Void)?
            var dismissing: (key: String, action: @MainActor () -> Void)?
            var primary: (key: String, action: @MainActor () -> Void)?
        }

        private var controls: Controls {
            switch state.kind {
            case .permission:
                return Controls(
                    dismissing: ("common.updateDeclineChecks", handlers.decline),
                    primary: ("common.updatePermissionAllow", handlers.allow))
            case .checking, .downloading:
                return Controls(dismissing: ("common.cancel", handlers.cancel))
            case .found:
                let skip = state.canSkip && !state.infoOnly ? ("update.skipVersion", handlers.skip) : nil
                if state.infoOnly {
                    return Controls(
                        leading: skip,
                        dismissing: state.canLater ? ("update.later", handlers.later) : nil,
                        primary: ("common.updateLearnMore", handlers.learnMore))
                }
                if state.downloaded {
                    return Controls(
                        leading: skip, dismissing: ("common.updateInstallOnQuit", handlers.later),
                        primary: ("update.install", handlers.install))
                }
                return Controls(
                    leading: skip,
                    dismissing: state.canLater ? ("update.later", handlers.later) : nil,
                    primary: ("common.updateInstallUpdate", handlers.install))
            case .ready:
                return Controls(
                    dismissing: ("common.updateInstallOnQuit", handlers.later),
                    primary: ("update.restartNow", handlers.install))
            case .quitToInstall:
                return Controls(primary: ("common.updateQuitAndInstall", handlers.quitAndInstall))
            case .upToDate:
                return Controls(primary: ("common.done", handlers.done))
            case .extracting, .installing, .failed:
                return Controls()
            }
        }

        /// The buttons in a row; where a translation does not fit the row they stack, the
        /// primary first, so a label never wraps.
        @ViewBuilder private var actions: some View {
            let c = controls
            if c.leading != nil || c.dismissing != nil || c.primary != nil {
                kitStyle { style in
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: style.space(.xs)) {
                        if let leading = c.leading { button(leading, .secondary, dismissing: false) }
                        Spacer(minLength: style.space(.xs))
                        if let d = c.dismissing { button(d, .secondary, dismissing: true) }
                        if let p = c.primary { button(p, .primary, dismissing: false) }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    VStack(spacing: style.space(.xs)) {
                        if let p = c.primary { button(p, .primary, dismissing: false) }
                        if let d = c.dismissing { button(d, .secondary, dismissing: true) }
                        if let leading = c.leading { button(leading, .secondary, dismissing: false) }
                    }
                }
                }
            }
        }

        @ViewBuilder private func button(
            _ item: (key: String, action: @MainActor () -> Void), _ kind: KitButtonKind,
            dismissing: Bool
        ) -> some View {
            let b = KitButton(
                line: CopyLine(item.key), kind: kind, fullWidth: false, compact: false,
                action: item.action)
            // Escape takes the dismissing secondary of every state, never Skip; Return the primary.
            if dismissing { b.keyboardShortcut(.cancelAction) } else { b }
        }

        // MARK: The error callout

        private func callout(_ style: KitResolvedStyle) -> some View {
            VStack(alignment: .leading, spacing: style.space(.sm)) {
                VStack(alignment: .leading, spacing: style.space(.xs)) {
                    KitText(CopyLine("common.updateFailedTitle"), .label, color: .strong)
                    errorBody(style)
                }
                .padding(style.space(.md))
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                        .fill(style.palette.sunken)
                )
                .accessibilityElement(children: .combine)
                .accessibilityFocused($calloutFocused)
                .onAppear { calloutFocused = true }
                HStack {
                    Spacer(minLength: 0)
                    if state.errorKind.canRetry {
                        KitButton(
                            line: CopyLine("common.tryAgain"), kind: .primary, fullWidth: false,
                            compact: false, action: handlers.tryAgain)
                    } else {
                        KitButton(
                            line: CopyLine("common.done"), kind: .primary, fullWidth: false,
                            compact: false, action: handlers.done)
                    }
                }
            }
        }

        @ViewBuilder private func errorBody(_ style: KitResolvedStyle) -> some View {
            switch state.errorKind {
            case .network: KitText(CopyLine("common.updateErrorNetwork"), .meta, color: .default)
            case .cannotInstall:
                KitText(CopyLine("common.updateErrorCannotInstall"), .meta, color: .default)
            case .security: KitText(CopyLine("common.updateErrorSecurity"), .meta, color: .default)
            case .other:
                if let detail = state.detail, !detail.isEmpty {
                    Text(verbatim: detail).font(style.font(.meta))
                        .foregroundStyle(style.palette.textDefault)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
#endif
