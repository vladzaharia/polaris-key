// @pkey-feature ui.settings ui.update
// The macOS menu commands (UK-08.4, SIGN-IN.md D-71): `PolarisKeyCommands(client)` puts
// Check for Updates… and Manage License… under the app's About item, and Sign Out… after them.
//
//   WindowGroup { … }.commands { PolarisKeyCommands(client) }
//
// * Check for Updates… calls `PolarisKeyUpdateHook.present` (the update window, set by
//   `PolarisKeyUpdateUI`, or Sparkle's own window through the host's handler). With neither it
//   opens Settings on Account and runs Check now there ("You're up to date" under the version).
// * Manage License… opens Settings on Account (`PolarisKeySettingsRoute`).
// * Sign Out… opens Settings on Account and asks first, with §4.9's words, then signs this
//   device out. The kit never draws a system alert (SIGN-IN.md D-80).

#if os(macOS)
    import AppKit
    import PolarisKey
    import PolarisKeyUICore
    import SwiftUI

    public struct PolarisKeyCommands: Commands {
        @State private var model: PolarisKeySettingsModel
        @Environment(\.openSettings) private var openSettings
        private let theme: PolarisKeyTheme
        private let checkForUpdates: (@MainActor () -> Void)?

        /// The commands for `client`. `theme` carries the host's locale and copy for the menu (the
        /// same value the gate gets); `checkForUpdates` replaces `PolarisKeyUpdateHook.present`.
        public init(
            _ client: PolarisKeyClient, theme: PolarisKeyTheme = PolarisKeyTheme(),
            handlers: KitSettingsHandlers = KitSettingsHandlers(),
            checkForUpdates: (@MainActor () -> Void)? = nil
        ) {
            let model = PolarisKeySettingsModel(client: client, handlers: handlers)
            _model = State(initialValue: model)
            self.theme = theme
            self.checkForUpdates = checkForUpdates
            // The menu follows the client: Sign Out… is off while nobody is signed in.
            Task { @MainActor in model.start() }
        }

        /// The commands over a model the host holds (previews and the sample).
        public init(
            model: PolarisKeySettingsModel, theme: PolarisKeyTheme = PolarisKeyTheme(),
            checkForUpdates: (@MainActor () -> Void)? = nil
        ) {
            _model = State(initialValue: model)
            self.theme = theme
            self.checkForUpdates = checkForUpdates
        }

        private var strings: KitStrings {
            KitStrings(
                catalog: KitCopy.bundled.overriding(theme.copy),
                locale: theme.locale ?? Locale.current.identifier)
        }

        public var body: some Commands {
            CommandGroup(after: .appInfo) {
                Button(strings.string("update.checkNow")) { check() }
                Button(strings.string("menu.manageLicense")) { show() }
                Divider()
                Button(strings.string("menu.signOut")) { show(.signOut) }
                    .disabled(!model.account.shows("common.signOut"))
            }
        }

        /// The update window when one is linked; else Check now, answered in the Account pane.
        private func check() {
            if let handler = checkForUpdates ?? PolarisKeyUpdateHook.present {
                handler()
            } else {
                show(.checkNow)
            }
        }

        /// Open Settings on Account, with an action for the pane to take.
        private func show(_ request: PolarisKeySettingsRoute.Request? = nil) {
            let route = PolarisKeySettingsRoute.shared
            route.selection = PolarisKeySettingsPane.tag
            route.request = request
            openSettings()
            NSApp.activate()
        }
    }
#endif
