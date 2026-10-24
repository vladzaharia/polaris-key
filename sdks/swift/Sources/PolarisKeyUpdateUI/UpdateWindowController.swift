// The utility window of the macOS update flow (UK-08.6): one `NSWindow` hosting the SwiftUI view,
// a single column sized to its content (the hosting controller reports the content's size and the
// window follows it as the screens change), with minimise and zoom disabled.

#if os(macOS)
    import AppKit
    import PolarisKeyUI
    import SwiftUI

    @MainActor
    final class UpdateWindowController: NSObject, NSWindowDelegate {
        let window: NSWindow
        /// The close button or Command-W: the person closed the window.
        var onUserClose: (() -> Void)?
        private var placed = false
        /// False while the window must be answered by a button (the permission ask).
        var closable = true {
            didSet { window.standardWindowButton(.closeButton)?.isHidden = !closable }
        }

        init(model: UpdateWindowModel, options: PolarisSparkleUserDriver.Options) {
            let hosting = NSHostingController(
                rootView: UpdateWindowView(model: model).polarisKeyTheme(options.theme))
            hosting.sizingOptions = [.preferredContentSize]
            let window = NSWindow(contentViewController: hosting)
            // Closable only: no resize edge, so the window is exactly its content.
            window.styleMask = [.titled, .closable, .fullSizeContentView]
            // The mockup's window has the traffic lights over the page and no title text; the
            // title stays as the window's accessibility name.
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.isReleasedWhenClosed = false
            window.standardWindowButton(.miniaturizeButton)?.isEnabled = false
            window.standardWindowButton(.zoomButton)?.isEnabled = false
            window.collectionBehavior = [.fullScreenNone]
            self.window = window
            super.init()
            window.delegate = self
        }

        func show(title: String, activate: Bool) {
            window.title = title
            if !placed {
                placed = true
                window.center()
            }
            window.makeKeyAndOrderFront(nil)
            if activate { NSApp.activate() }
        }

        func bringForward() {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate()
        }

        /// Close for Sparkle's `dismissUpdateInstallation`: no reply is answered by it.
        func close() {
            window.close()
        }

        func windowShouldClose(_ sender: NSWindow) -> Bool {
            guard closable else { return false }
            onUserClose?()
            return true
        }
    }
#endif
