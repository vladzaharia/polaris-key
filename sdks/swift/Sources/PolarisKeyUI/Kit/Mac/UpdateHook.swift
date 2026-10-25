// @pkey-feature ui.update
// The seam between the Mac kit and the update window (UK-08.4, UK-08.6). `PolarisKeyUI` links no
// Sparkle, so "Check for Updates…" cannot open an update window it does not know about. A module
// that owns one (`PolarisKeyUpdateUI`) sets `PolarisKeyUpdateHook.present` once at launch; the
// Settings pane and the app menu call it. With no handler (the host has no updater linked) they
// run Check now on the client and say "You're up to date" or what failed.
//
//   PolarisKeyUpdateHook.present = { sparkle.checkForUpdates() }

#if os(macOS)
    /// Where a user-initiated "Check for Updates…" goes.
    @MainActor
    public enum PolarisKeyUpdateHook {
        /// Starts a user-initiated check and shows its window (Sparkle's, or the kit's own).
        public static var present: (@MainActor () -> Void)?
    }
#endif
