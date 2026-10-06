// Copy for the kit's components beyond the gate (notes/SDK-PARITY-PASS.md §3.18). Every string a
// component renders is here, so a product can localise or brand all of it from one place
// (`theme.copy.kit.signInTitle = …`). Error lines come from `ErrorCopy` by code.

import PolarisKeyCore

public struct PolarisKitCopy: Sendable, Equatable {
    // Gate additions.
    public var continueFreeButton = "Continue free"
    public var activateOfflineLink = "Activate offline"
    public var manageDevicesButton = "Manage devices"

    // Sign-in (device code).
    public var signInTitle = "Sign in"
    public var signInSubtitle = "Scan the code or open the link, then enter this code."
    public var openBrowserButton = "Open browser"
    public var cancelButton = "Cancel"
    public var tryAgainButton = "Try again"
    public var codeExpiresIn = "Code expires in"
    public var signInQRLabel = "QR code for the sign-in page"
    public var confirmTitle = "Is this you?"
    public var confirmContinue = "Continue"
    public var attachFreeLicense = "Move this device's free license to this account"
    public var signedInAs = "Signed in as"
    public var startingSignIn = "Starting sign-in…"

    // Offline activation.
    public var offlineTitle = "Activate offline"
    public var offlineSubtitle =
        "Send this request code to the product's support, then import the activation file you receive."
    public var requestCodeLabel = "Request code"
    public var copyButton = "Copy"
    public var copiedLabel = "Copied"
    public var importFileButton = "Import file…"
    public var pasteButton = "Paste"
    public var dropHint = "Or drop the activation file here."
    public var importedMessage = "Activated. You're all set."

    // Settings.
    public var settingsTitle = "Settings"
    public var managedLabel = "Managed by your administrator"
    public var resetButton = "Reset to default"
    public var noSettings = "There are no settings to change."

    // Devices.
    public var devicesTitle = "Devices"
    public var thisDevice = "This device"
    public var renameButton = "Rename"
    public var removeButton = "Remove"
    public var removeConfirm = "Remove this device? It will need to be activated again."
    public var signOutThisDevice = "Sign out of this device"
    public var noDevices = "No devices yet."
    public var lastSeen = "Last seen"

    // Account.
    public var accountTitle = "Account"
    public var licenseLabel = "License"
    public var tierLabel = "Plan"
    public var seatsLabel = "Devices"
    public var signOutButton = "Sign out"
    public var deactivateButton = "Deactivate this device"
    public var notSignedIn = "Not activated"

    // Entitled.
    public var notIncludedTitle = "Not included in your plan"
    public var notIncludedSubtitle = "Upgrade to use this feature."

    // Updates.
    public var updateAvailableTitle = "Update available"
    public var updateRequiredTitle = "Update required"
    public var updateButton = "Update"
    public var laterButton = "Later"
    public var restartToFinish = "Restart to finish"
    public var downloading = "Downloading…"
    public var whatsNewTitle = "What's new"
    public var noReleaseNotes = "No release notes yet."

    // Packs.
    public var packsTitle = "Downloading content"
    public var packsConsentTitle = "Download additional content?"
    public var downloadButton = "Download"
    public var notNowButton = "Not now"
    public var meteredWarning = "You're on a cellular or metered connection."
    public var packsReady = "Content ready"

    // Channels.
    public var channelTitle = "Release channel"
    public var channelLocked = "This build's channel is set by where you installed it."

    // Purchase.
    public var buyButton = "Buy"
    public var restoreButton = "Restore purchases"
    public var purchasedLabel = "Purchased"
    public var purchasePending = "Waiting for approval…"

    // Boot.
    public var bootChecking = "Checking your license…"
    public var bootUpdating = "Checking for updates…"
    public var bootContent = "Preparing content…"
    public var bootOffline = "You're offline"
    public var bootOfflineSubtitle = "Connect to the internet to continue."
    public var playOffline = "Play offline"
    public var retryButton = "Retry"

    // Dev menu.
    public var devMenuTitle = "Diagnostics"
    public var copyDiagnostics = "Copy diagnostics"
    public var forceCheck = "Check now"

    public init() {}
}

extension PolarisCopy {
    /// The sentence for a registry `code` (`ErrorCopy`), for components that surface errors.
    public func errorMessage(_ code: String) -> String {
        activationMessages[code] ?? ErrorCopy.message(code)
    }
}
