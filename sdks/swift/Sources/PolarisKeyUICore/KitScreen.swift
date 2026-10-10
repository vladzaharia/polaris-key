// What the presentation core answers (UI-KITS §1.3 layer c, §5.2): for one component, its state,
// the copy lines it shows (catalog keys with their arguments) and the actions those controls take.
// `ui-matrix.json` pins every answer: the runner compares the component, the state, the sorted copy
// keys and the sorted actions.

import Foundation

/// The UI-KITS §4.1 components the core models.
public enum KitComponent: String, Sendable, CaseIterable, Codable {
    case gate = "PolarisKeyGate"
    case boot = "Boot"
    case welcome = "Welcome"
    case signIn = "SignIn"
    case signInHandoff = "SignInHandoff"
    case activate = "Activate"
    case offlineActivation = "OfflineActivation"
    case deviceLimit = "DeviceLimit"
    case licenseChoice = "LicenseChoice"
    case devices = "Devices"
    case updatePrompt = "UpdatePrompt"
    case updateProgress = "UpdateProgress"
    case releaseNotes = "ReleaseNotes"
    case statusScreen = "StatusScreen"
    case graceBanner = "GraceBanner"
    case accountAndLicense = "AccountAndLicense"
    case settings = "Settings"
    case paywall = "Paywall"
    case entitlementGate = "EntitlementGate"
    case toast = "Toast"
}

/// What a control does, in the matrix's closed vocabulary (`vocabulary.actions`).
public enum KitAction: String, Sendable, CaseIterable, Codable, Comparable {
    /// Start the sign-in on the hosted card in the browser.
    case openCard = "open-card"
    /// Open the sign-in already in flight again; never a second request.
    case openBrowser = "open-browser"
    /// Replace a device on the card, for a form set to `replace: browser`.
    case replaceInBrowser = "replace-in-browser"
    /// Open the refusal's `manageUrl` or the account's device page.
    case openManageURL = "open-manage-url"
    /// Copy the sign-in link or the address.
    case copyLink = "copy-link"
    /// Repeat the step that failed or lapsed.
    case retry
    /// Leave the step or the flow.
    case cancel

    public static func < (a: KitAction, b: KitAction) -> Bool { a.rawValue < b.rawValue }

    /// The action a control with this copy key takes (`vocabulary.actionKeys`), or nil.
    public static func forCopyKey(_ key: String) -> KitAction? { byKey[key] }

    private static let byKey: [String: KitAction] = [
        "signin.desktop.continue": .openCard,
        "signin.email.continue": .openCard,
        "signin.handoff.again": .openBrowser,
        "signin.handoff.openBrowser": .openBrowser,
        "deviceLimit.openBrowser": .openManageURL,
        "devices.manage": .openManageURL,
        "signin.handoff.copyLink": .copyLink,
        "a11y.copyAddress": .copyLink,
        "common.tryAgain": .retry,
        "common.reconnect": .retry,
        "signin.again": .retry,
        "signInHandoff.newCode": .retry,
        "common.cancel": .cancel,
    ]
}

/// A component's states, as `components.json` names them.
public protocol KitStateID: RawRepresentable, CaseIterable, Sendable, Hashable
where RawValue == String {
    static var component: KitComponent { get }
}

/// One component's answer for one set of inputs.
public struct KitScreen<State: KitStateID>: Sendable, Equatable {
    /// nil when the component is hidden: the service it needs is off, so the drop-in renders
    /// nothing and a styled part renders empty.
    public let state: State?
    /// The lines the state shows, in reading order.
    public let copy: [CopyLine]
    /// The actions the lines' controls take, plus `replace-in-browser` where the form hands
    /// Replace to the card.
    public let actions: [KitAction]

    public init(_ state: State?, _ copy: [CopyLine], extraActions: [KitAction] = []) {
        self.state = state
        self.copy = state == nil ? [] : copy
        var actions = Set(self.copy.compactMap { KitAction.forCopyKey($0.key) })
        if state != nil { actions.formUnion(extraActions) }
        self.actions = actions.sorted()
    }

    /// The hidden answer.
    public static var hidden: KitScreen { KitScreen(nil, []) }

    public var component: KitComponent { State.component }
    public var isHidden: Bool { state == nil }
    /// The state's name, or `hidden`.
    public var stateName: String { state?.rawValue ?? "hidden" }
    /// The copy keys, sorted (the matrix's comparison).
    public var copyKeys: [String] { copy.map(\.key).sorted() }

    /// Whether the state shows `key`.
    public func shows(_ key: String) -> Bool { copy.contains { $0.key == key } }
    /// The line for `key`, if the state shows it.
    public func line(_ key: String) -> CopyLine? { copy.first { $0.key == key } }
    /// Whether a control takes `action`.
    public func offers(_ action: KitAction) -> Bool { actions.contains(action) }

    /// The type-erased answer (the conformance runner's comparison).
    public var erased: AnyKitScreen {
        AnyKitScreen(
            component: component, state: stateName, copy: copy, actions: actions)
    }
}

/// A component's answer with its state as a string.
public struct AnyKitScreen: Sendable, Equatable {
    public let component: KitComponent
    public let state: String
    public let copy: [CopyLine]
    public let actions: [KitAction]

    public var copyKeys: [String] { copy.map(\.key).sorted() }
}
