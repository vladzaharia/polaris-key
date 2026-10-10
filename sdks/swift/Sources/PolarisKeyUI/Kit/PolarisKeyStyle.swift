// Restyle hooks beyond the theme (UI-KITS §3.2 SwiftUI row): a `PolarisKeyStyle` replaces or wraps
// one component's body the way a `ButtonStyle` replaces a button's, with the component's state,
// copy and actions in its configuration, so a host restyles a screen without re-deriving its
// state machine.
//
//   ContentView()
//       .polarisKeyGate(client)
//       .welcomeStyle(MyWelcome())        // or .polarisKeyStyle(MyWelcome(), for: .welcome)

import PolarisKeyUICore
import SwiftUI

/// A component's look, over its state.
@MainActor
public protocol PolarisKeyStyle {
    associatedtype Body: View
    @ViewBuilder func makeBody(configuration: PolarisKeyStyleConfiguration) -> Body
}

/// What a style draws from.
public struct PolarisKeyStyleConfiguration {
    public let component: KitComponent
    /// The `components.json` state.
    public let state: String
    /// The lines the state shows (catalog keys and arguments).
    public let copy: [CopyLine]
    public let actions: [KitAction]
    /// The resolved colours, fonts and measures.
    public let style: KitResolvedStyle
    public let strings: KitStrings
    /// The kit's own rendering of the component, to wrap or to replace.
    public let content: AnyView

    /// A line of the state, formatted in the active locale.
    public func text(_ line: CopyLine) -> String { strings.string(line) }

    /// The state's line for `key`, formatted, or nil when the state does not show it.
    public func text(_ key: String) -> String? {
        copy.first { $0.key == key }.map(strings.string)
    }
}

struct AnyPolarisKeyStyle {
    let make: @MainActor (PolarisKeyStyleConfiguration) -> AnyView

    @MainActor init<S: PolarisKeyStyle>(_ style: S) {
        make = { AnyView(style.makeBody(configuration: $0)) }
    }
}

private struct PolarisKeyStylesKey: EnvironmentKey {
    nonisolated(unsafe) static let defaultValue: [KitComponent: AnyPolarisKeyStyle] = [:]
}

extension EnvironmentValues {
    var polarisKeyStyles: [KitComponent: AnyPolarisKeyStyle] {
        get { self[PolarisKeyStylesKey.self] }
        set { self[PolarisKeyStylesKey.self] = newValue }
    }
}

@MainActor
extension View {
    /// Restyle `component` in this subtree.
    public func polarisKeyStyle<S: PolarisKeyStyle>(_ style: S, for component: KitComponent)
        -> some View
    {
        transformEnvironment(\.polarisKeyStyles) { $0[component] = AnyPolarisKeyStyle(style) }
    }

    public func welcomeStyle<S: PolarisKeyStyle>(_ style: S) -> some View {
        polarisKeyStyle(style, for: .welcome)
    }

    public func activateStyle<S: PolarisKeyStyle>(_ style: S) -> some View {
        polarisKeyStyle(style, for: .activate)
    }

    public func signInStyle<S: PolarisKeyStyle>(_ style: S) -> some View {
        polarisKeyStyle(style, for: .signIn)
    }

    public func statusScreenStyle<S: PolarisKeyStyle>(_ style: S) -> some View {
        polarisKeyStyle(style, for: .statusScreen)
    }

    public func deviceLimitStyle<S: PolarisKeyStyle>(_ style: S) -> some View {
        polarisKeyStyle(style, for: .deviceLimit)
    }

    public func bootStyle<S: PolarisKeyStyle>(_ style: S) -> some View {
        polarisKeyStyle(style, for: .boot)
    }

    public func graceBannerStyle<S: PolarisKeyStyle>(_ style: S) -> some View {
        polarisKeyStyle(style, for: .graceBanner)
    }
}

/// Applies the host's style for a component, or draws the kit's.
struct KitStyled<State: KitStateID, Content: View>: View {
    let screen: KitScreen<State>
    @ViewBuilder let content: () -> Content

    @Environment(\.polarisKeyStyles) private var styles
    @Environment(\.polarisKeyStrings) private var strings

    var body: some View {
        if let custom = styles[State.component] {
            kitStyle { style in
                custom.make(
                    PolarisKeyStyleConfiguration(
                        component: State.component, state: screen.stateName, copy: screen.copy,
                        actions: screen.actions, style: style, strings: strings,
                        content: AnyView(content())))
            }
        } else {
            content()
        }
    }
}
