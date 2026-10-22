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
    var onUpdate: () -> Void
    var onLater: () -> Void
    /// The offer's own facts (running version, size, notes, changes page), when the host has them.
    var details: KitUpdate?
    @Environment(\.openURL) private var openURL
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<UpdatePromptState>, fraction: Double? = nil,
        details: KitUpdate? = nil, onUpdate: @escaping () -> Void, onLater: @escaping () -> Void
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
            } actions: {
                KitButton(line: CopyLine("update.install"), kind: .primary, action: onUpdate)
                    .keyboardShortcut(.defaultAction)
            }
        case .none, .upToDate, .blocked:
            EmptyView()
        default:
            banner
        }
    }

    /// "You have 2.4.1 · 61 MB download", only once both facts are known.
    private var currentLine: CopyLine? {
        guard screen.state == .available, let version = details?.currentVersion,
            let bytes = details?.sizeBytes
        else { return nil }
        return CopyLine(
            "update.current", ["version": .text(version), "size": .text(KitFormat.bytes(bytes))])
    }

    /// At most three plain lines of the release's notes (§4.3).
    private var noteLines: [String] {
        guard screen.state == .available else { return [] }
        return Self.noteLines(details?.notes)
    }

    static func noteLines(_ notes: [String]?) -> [String] {
        Array((notes ?? []).filter { !$0.isEmpty }.prefix(3))
    }

    private var changesLink: URL? {
        guard screen.state == .available else { return nil }
        return KitLinks.valid(details?.notesUrl)
    }

    /// "About 20 seconds left", in words with tabular figures (§4.3).
    private var timeLeftLine: CopyLine? {
        guard let seconds = details?.progress?.secondsLeft else {
            return screen.line("update.timeLeft").flatMap { $0.isComplete() ? $0 : nil }
        }
        return CopyLine("update.timeLeft", ["time": .text(KitFormat.timeLeft(seconds))])
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
                KitButton(
                    line: verb, kind: .primary, fullWidth: false, compact: true, action: onUpdate)
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
        for key in ["update.appStore", "update.testflight", "update.altstore", "update.restartNow"]
        {
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

    public init(
        screen: KitScreen<UpdateProgressState>, fraction: Double?, onRetry: @escaping () -> Void
    ) {
        self.screen = screen
        self.fraction = fraction
        self.onRetry = onRetry
    }

    public var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.xs)) {
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
