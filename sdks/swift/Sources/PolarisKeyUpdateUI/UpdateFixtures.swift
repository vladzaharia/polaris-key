// The update window's fixture states (UK-08.6): the screens of the `desktop-update` mockup, drawn
// by the driver itself through the same Sparkle calls a real session makes, with no updater, no
// network and no reply anyone waits for. The sample's `-pkeyUpdate <state>` and the render tests
// use them; a host can too, for a preview.

#if os(macOS)
    import Foundation
    import PolarisKeyUICore
    import Sparkle

    /// A state of the update window.
    public enum UpdateFixture: String, Sendable, CaseIterable {
        case permission, checking, found
        /// 38 MB of 61 MB, about 20 seconds left.
        case downloading
        /// Bytes arriving, the total not known: an indeterminate bar.
        case downloadingUnknownTotal = "downloading-unknown"
        case extracting, ready, installing
        /// Already downloaded: Install on Quit and Install and Relaunch.
        case downloaded
        /// The app did not quit by itself: Quit and Install.
        case quitToInstall = "quit-to-install"
        case upToDate = "up-to-date"
        case error
        /// An error trying again cannot fix: Done.
        case errorCannotInstall = "error-cannot-install"
    }

    extension PolarisSparkleUserDriver {
        /// Show `fixture`: Tidewater Studio 2.5.0 over 2.4.1, the mockup's notes.
        public func present(fixture: UpdateFixture) {
            let offer = Offer(
                version: "2.5.0", currentVersion: "2.4.1", size: 61_000_000,
                notes: [
                    "Stem export in one click, with loudness matching",
                    "Track freeze now works with every plug-in",
                    "Fixes a crash when unplugging an audio interface",
                ],
                notesURL: URL(string: "https://tidewater.example/changes/2.5"))
            switch fixture {
            case .permission:
                show(SPUUpdatePermissionRequest(systemProfile: [])) { _ in }
            case .checking:
                showUserInitiatedUpdateCheck {}
            case .found:
                showFound(offer) { _ in }
            case .downloading, .downloadingUnknownTotal:
                showFound(offer) { _ in }
                showDownloadInitiated {}
                if fixture == .downloading {
                    showDownloadDidReceiveExpectedContentLength(61_000_000)
                    // 38 MB in 33 s leaves 23 MB at the same rate: about 20 seconds.
                    rewindDownloadClock(by: 33.04)
                    showDownloadDidReceiveData(ofLength: 38_000_000)
                } else {
                    rewindDownloadClock(by: 4)
                    showDownloadDidReceiveData(ofLength: 12_000_000)
                }
            case .extracting:
                showFound(offer) { _ in }
                showDownloadDidStartExtractingUpdate()
            case .ready:
                showFound(offer) { _ in }
                showReady(toInstallAndRelaunch: { _ in })
            case .installing:
                showFound(offer) { _ in }
                showInstallingUpdate(withApplicationTerminated: true, retryTerminatingApplication: {})
            case .downloaded:
                showFound(offer, downloaded: true) { _ in }
            case .quitToInstall:
                showFound(offer) { _ in }
                showInstallingUpdate(withApplicationTerminated: false, retryTerminatingApplication: {})
            case .errorCannotInstall:
                showUpdateNotFoundWithError(
                    NSError(
                        domain: "SUSparkleErrorDomain", code: 1001,
                        userInfo: [SPUNoUpdateFoundReasonKey: NSNumber(value: 3)]),
                    acknowledgement: {})
            case .upToDate:
                showUpdateNotFoundWithError(
                    NSError(
                        domain: "SUSparkleErrorDomain", code: 1001,
                        userInfo: [SPUNoUpdateFoundReasonKey: NSNumber(value: 1)]),
                    acknowledgement: {})
            case .error:
                showUpdaterError(
                    NSError(
                        domain: "SUSparkleErrorDomain", code: 4005,
                        userInfo: [
                            NSLocalizedDescriptionKey:
                                "An error occurred while installing the update. Please try again later."
                        ]),
                    acknowledgement: {})
            }
        }
    }
#endif
