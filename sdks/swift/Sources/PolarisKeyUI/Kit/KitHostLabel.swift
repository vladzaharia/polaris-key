// The window's content group gets a name (macOS). SwiftUI draws a window's content inside one
// unnamed accessibility group, which the accessibility audit reports ("Element has no
// description") on every screen. The kit names it after the product, only where the host has not
// named it itself.

#if os(macOS)
    import AppKit
    import SwiftUI

    struct KitHostLabel: NSViewRepresentable {
        let name: String

        final class Probe: NSView {
            var name = ""

            override func viewDidMoveToWindow() {
                super.viewDidMoveToWindow()
                apply()
            }

            func apply() {
                // After the hosting view is in place.
                DispatchQueue.main.async { [weak self] in
                    guard let self, let host = self.window?.contentView else { return }
                    let current = host.accessibilityLabel() ?? ""
                    if current.isEmpty || current == self.applied {
                        host.setAccessibilityLabel(self.name)
                        self.applied = self.name
                    }
                }
            }

            private var applied: String?
        }

        func makeNSView(context: Context) -> Probe {
            let probe = Probe()
            probe.name = name
            return probe
        }

        func updateNSView(_ probe: Probe, context: Context) {
            probe.name = name
            probe.apply()
        }
    }
#endif
