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
    var onUpdate: () -> Void
    var onLater: () -> Void

    public init(
        screen: KitScreen<UpdatePromptState>, onUpdate: @escaping () -> Void,
        onLater: @escaping () -> Void
    ) {
        self.screen = screen
        self.onUpdate = onUpdate
        self.onLater = onLater
    }

    public var body: some View {
        switch screen.state {
        case .mandatory, .revokedRequiredContent:
            KitScreenScaffold(hero: true, header: false) {
                if let title = screen.line("update.mandatoryTitle") ?? screen.line("core.codes.pack-revoked.title") {
                    KitText(title, .title, color: .strong, alignment: .center)
                        .accessibilityAddTraits(.isHeader)
                }
            } content: {
                if let body = screen.line("update.mandatoryBody") ?? screen.line("update.revokedContent") {
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

    private var banner: some View {
        kitStyle { style in
            HStack(spacing: style.space(.sm)) {
                ProductIcon(size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    KitText(
                        screen.line("update.title") ?? screen.line("update.readyTitle")
                            ?? screen.lineOrKey("update.availableTitle"), .label, color: .strong)
                    if let detail = screen.line("update.downloading") ?? screen.line("update.readyBody")
                        ?? screen.line("update.critical")
                    {
                        KitText(detail, .footnote, color: .muted)
                    }
                }
                Spacer(minLength: 0)
                KitButton(line: verb, kind: .primary, fullWidth: false, action: onUpdate)
                    .fixedSize()
            }
            .padding(style.space(.sm))
            .modifier(KitFloatingSurface(style: style))
            .padding(.horizontal, style.space(.md))
            .accessibilityElement(children: .contain)
        }
    }

    /// The verb the outlet allows.
    private var verb: CopyLine {
        for key in ["update.appStore", "update.testflight", "update.altstore", "update.restartNow"] {
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
                ForEach(screen.copy.filter { !$0.key.hasPrefix("a11y.") && $0.key != "common.tryAgain" }, id: \.key) {
                    KitText($0, .meta, color: .default)
                }
                if screen.state == .downloading, let fraction {
                    ProgressBar(fraction: fraction)
                }
                if screen.state == .failed {
                    KitButton(line: CopyLine("common.tryAgain"), kind: .secondary, fullWidth: false, action: onRetry)
                }
            }
        }
    }
}

/// The changelog. Notes are plain text: remote markup shows as text and never runs.
public struct ReleaseNotesView: View {
    let screen: KitScreen<ReleaseNotesState>
    let notes: [KitReleaseNote]
    var onRetry: () -> Void
    @Environment(\.polarisKeyStrings) private var strings

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
                    ForEach(notes, id: \.version) { note in
                        Section {
                            Text(verbatim: note.notes)
                                .font(style.font(.body))
                                .foregroundStyle(style.palette.textDefault)
                        } header: {
                            HStack {
                                KitText(CopyLine("releaseNotes.version", ["version": .text(note.version)]), .label, color: .strong)
                                Spacer()
                                KitText(CopyLine("releaseNotes.released", ["date": .text(note.date)]), .footnote, color: .muted)
                            }
                        }
                    }
                case .none:
                    EmptyView()
                }
            }
            .navigationTitle(screen.line("releaseNotes.title").map(strings.string) ?? "")
        }
    }
}
