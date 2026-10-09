// Copy for the kit's components beyond the gate (notes/SDK-PARITY-PASS.md §3.18). Every string a
// component renders is here, so a product can localise or brand all of it from one place
// (`theme.copy.kit.signInTitle = …`). Error lines come from `ErrorCopy` by code (core.copy, the
// generated tables), and a string whose key the generated copy has reads it from there.
//
// Button and link labels follow the platform's convention: title case on macOS, sentence case on
// iOS (`KitButtonCase.button`). The values match the Mac variants in the bundled String Catalog;
// wiring these defaults to `String(localized:)` is UK-07's work.

import Foundation
import PolarisKeyCore

/// Casing for a kit button or link label: title case on macOS, as the platform expects, and the
/// sentence-case original on iOS. The same rule the String Catalog's `device` variations encode.
public enum KitButtonCase {
    /// The platform-cased form of a sentence-case label.
    public static func button(_ sentence: String) -> String {
        #if os(macOS)
            return titleCased(sentence)
        #else
            return sentence
        #endif
    }

    /// Words kept lower-case in a title unless they open or close it.
    static let minorWords: Set<String> = [
        "a", "an", "and", "the", "to", "of", "for", "in", "on", "or", "with", "from", "as", "at",
        "by", "but", "nor",
    ]

    static func titleCased(_ s: String) -> String {
        let words = s.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        return words.enumerated().map { index, word -> String in
            let lower = word.lowercased()
            let isEdge = index == 0 || index == words.count - 1
            if !isEdge && minorWords.contains(trimPunctuation(lower)) { return lower }
            return capitalizeFirst(word)
        }.joined(separator: " ")
    }

    private static func trimPunctuation(_ s: String) -> String {
        s.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    }

    private static func capitalizeFirst(_ word: String) -> String {
        guard let first = word.first else { return word }
        return String(first).uppercased() + word.dropFirst()
    }
}

public struct PolarisKitCopy: Sendable, Equatable {
    // Gate additions.
    public var continueFreeButton = KitButtonCase.button("Continue free")
    public var activateOfflineLink = KitButtonCase.button("Activate offline")
    public var manageDevicesButton = KitButtonCase.button("Manage devices")

    // Sign-in (device code). The code view's strings are the catalog's `signin.handoff.*` keys
    // (SIGN-IN.md §3.17).
    public var signInTitle = "Sign in"
    /// The TV code view's subtitle, where the QR code shows (no QR on phones, tablets or Macs:
    /// SIGN-IN.md D-67).
    public var signInSubtitle = "Scan the code or open the link, then enter this code."
    /// `signin.handoff.codeTitle`.
    public var signInCodeTitle = "Sign in with a code"
    /// `signin.handoff.codeBody`; `%@` is the verification page, shown without its scheme.
    public var signInCodeBody = "On any phone or computer, go to %@ and enter this code."
    /// `signin.handoff.check`.
    public var signInCodeCheck = "Check the code there matches this one."
    /// `part.code.label`: what VoiceOver calls the user code.
    public var codeLabel = "Sign-in code"
    /// `a11y.copyCode`: the labelled copy control for the user code.
    public var copyCodeLabel = "Copy code"
    public var openBrowserButton = KitButtonCase.button("Open browser")
    public var copyLinkButton = KitButtonCase.button("Copy link")
    public var cancelButton = "Cancel"
    public var tryAgainButton = KitButtonCase.button("Try again")
    public var codeExpiresIn = "Code expires in"
    public var signInQRLabel = "QR code for the sign-in page"
    public var confirmTitle = "Is this you?"
    public var confirmContinue = "Continue"
    public var attachFreeLicense = "Move this device's free license to this account"
    public var signedInAs = "Signed in as"
    public var startingSignIn = "Starting sign-in…"
    /// `signin.expired.title` / `signin.expired.body`: the device code has run out.
    public var signInExpiredTitle = "That code or link has expired"
    public var signInExpiredBody = "Codes and links work once, for 10 minutes."

    // Offline activation.
    /// `offlineActivation.title`.
    public var offlineTitle = "Offline activation"
    /// `offlineActivation.request` + `offlineActivation.loadHint`.
    public var offlineRequest = "Send this request code to whoever gave you your license."
    public var offlineLoadHint = "Then load the activation file you get back, or paste its text."
    /// `offlineActivation.product`; `%@` is the product name.
    public var offlineProductLabel = "Product: %@"
    public var requestCodeLabel = "Request code"
    public var copyButton = "Copy"
    public var copiedLabel = "Copied"
    /// `offlineActivation.loadFile`.
    public var importFileButton = KitButtonCase.button("Load file…")
    public var pasteButton = "Paste"
    /// `offlineActivation.dropHint`.
    public var dropHint = "You can also drop the file onto this window."
    /// `offlineActivation.empty`.
    public var offlineEmpty = "Load or paste an activation file first."
    /// `offlineActivation.done`.
    public var importedMessage = "Activated from the offline file."

    // Key field (gate).
    /// `part.keyField.label`: the visible label above the license-key field.
    public var keyFieldLabel = "License key"
    /// `part.keyField.placeholder`: the field's prompt.
    public var keyFieldPlaceholder = "Paste your key"

    // Common.
    /// `common.working`.
    public var workingLabel = "Working…"
    /// `activate.busy`.
    public var activatingLabel = "Activating…"

    // Settings.
    public var settingsTitle = "Settings"
    public var managedLabel = "Managed by your administrator"
    public var resetButton = KitButtonCase.button("Reset to default")
    public var noSettings = "There are no settings to change."

    // Devices.
    public var devicesTitle = "Devices"
    public var thisDevice = "This device"
    public var renameButton = KitButtonCase.button("Rename")
    public var removeButton = KitButtonCase.button("Remove")
    public var removeConfirm = "Remove this device? It will need to be activated again."
    public var signOutThisDevice = "Sign out of this device"
    public var noDevices = "No devices yet."
    public var lastSeen = "Last seen"

    // Account.
    public var accountTitle = "Account"
    public var licenseLabel = "License"
    public var tierLabel = "Plan"
    public var seatsLabel = "Devices"
    public var signOutButton = KitButtonCase.button("Sign out")
    public var deactivateButton = KitButtonCase.button("Deactivate this device")
    public var notSignedIn = "Not activated"

    // Entitled.
    public var notIncludedTitle = "Not included in your plan"
    public var notIncludedSubtitle = "Upgrade to use this feature."

    // Updates.
    public var updateAvailableTitle = "Update available"
    public var updateRequiredTitle = ErrorCopy.title(LicenseStatus.versionTooOld.rawValue)
    public var updateButton = KitButtonCase.button("Update")
    public var laterButton = KitButtonCase.button("Later")
    public var restartToFinish = "Restart to finish"
    public var downloading = "Downloading…"
    public var whatsNewTitle = "What's new"
    public var noReleaseNotes = "No release notes yet."

    // Packs.
    public var packsTitle = "Downloading content"
    public var packsConsentTitle = "Download additional content?"
    public var downloadButton = KitButtonCase.button("Download")
    public var notNowButton = KitButtonCase.button("Not now")
    public var meteredWarning = "You're on a cellular or metered connection."
    public var packsReady = "Content ready"

    // Channels.
    public var channelTitle = "Release channel"
    public var channelLocked = "This build's channel is set by where you installed it."

    // Purchase.
    public var buyButton = KitButtonCase.button("Buy")
    public var restoreButton = KitButtonCase.button("Restore purchases")
    public var purchasedLabel = "Purchased"
    public var purchasePending = "Waiting for approval…"

    // Boot.
    public var bootChecking = "Checking your license…"
    public var bootUpdating = "Checking for updates…"
    public var bootContent = "Preparing content…"
    public var bootOffline = "You're offline"
    public var bootOfflineSubtitle = "Connect to the internet to continue."
    public var playOffline = KitButtonCase.button("Play offline")
    public var retryButton = KitButtonCase.button("Try again")

    // Dev menu.
    public var devMenuTitle = "Diagnostics"
    public var copyDiagnosticsButton = KitButtonCase.button("Copy diagnostics")
    public var forceCheckButton = KitButtonCase.button("Check now")

    public init() {}

    /// Every button and link label, for the title-case parity test.
    public var buttonLabels: [String] {
        [
            continueFreeButton, activateOfflineLink, manageDevicesButton, openBrowserButton,
            copyLinkButton, cancelButton, tryAgainButton, confirmContinue, importFileButton,
            pasteButton, resetButton, renameButton, removeButton, signOutButton, deactivateButton,
            updateButton, laterButton, downloadButton, notNowButton, buyButton, restoreButton,
            playOffline, retryButton, copyDiagnosticsButton, forceCheckButton, copyButton,
        ]
    }
}

extension PolarisCopy {
    /// The sentence for a registry `code`, for components that surface errors: the product's
    /// override, else `ErrorCopy.message` (the generated tables, fallback naming the code).
    public func errorMessage(_ code: String) -> String {
        activationMessages[code] ?? ErrorCopy.message(code)
    }
}
