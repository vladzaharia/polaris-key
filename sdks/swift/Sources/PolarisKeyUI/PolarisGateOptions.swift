// @pkey-feature ui.kit
// What a host decides about the drop-in gate beyond its look (`PolarisTheme` is the look):
// whether the key field shows, whether offline activation is offered, the free tier, where the
// portal sends the person back, a renewal page for an expired licence, and a slot for the host's
// own action on a blocking state.
//
//   WindowGroup { Root().polarisKey(client, theme: theme, options: GateOptions(returnURL: "myapp://done")) }

import PolarisKeyCore
import SwiftUI

public struct GateOptions: Sendable {
    /// Whether the licence-key field shows. False where the outlet forbids key entry (App Store
    /// review guideline 3.1.1); the gate then offers sign-in and the host's own actions.
    public var showsKeyEntry: Bool
    /// Whether "Activate offline" is offered. Off by default on iOS, where a phone has a network
    /// or a store account; on by default on macOS and visionOS.
    public var offersOfflineActivation: Bool
    /// "Continue free" (keyless enrolment). Hidden for good once the server answers
    /// `enroll_disabled`.
    public var offersFreeTier: Bool
    /// Where the portal sends the person back once a seat is free (a declared return target of
    /// the product). The device-limit refusal's "Replace a device" link carries it.
    public var returnURL: String?
    /// A page where the licence is renewed or managed (the host's store or account page). When
    /// set, an expired licence offers "Renew or manage" as its one filled action; without it the
    /// expired gate offers "Try again" first. Opened only behind a tap.
    public var renewURL: URL?
    /// The host's own action on a blocking state (an expired, revoked or version-blocked gate):
    /// a "Contact support" link, an "Update" button. Drawn under the gate's own actions.
    public var blockedAction: (@MainActor @Sendable (LicenseStatus) -> AnyView?)?

    /// `offersOfflineActivation`'s default on this platform.
    public static var defaultOffersOfflineActivation: Bool {
        #if os(iOS)
            return false
        #else
            return true
        #endif
    }

    public init(
        showsKeyEntry: Bool = true,
        offersOfflineActivation: Bool = GateOptions.defaultOffersOfflineActivation,
        offersFreeTier: Bool = false,
        returnURL: String? = nil,
        renewURL: URL? = nil,
        blockedAction: (@MainActor @Sendable (LicenseStatus) -> AnyView?)? = nil
    ) {
        self.showsKeyEntry = showsKeyEntry
        self.offersOfflineActivation = offersOfflineActivation
        self.offersFreeTier = offersFreeTier
        self.returnURL = returnURL
        self.renewURL = renewURL
        self.blockedAction = blockedAction
    }
}
