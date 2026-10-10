// PolarisKeyUICore: the presentation core of the Polaris Key UI kits for Apple platforms
// (docs/design/UI-KITS.md §1.3 layer c, §5.1 SwiftUI row, §5.2).
//
//   KitInputs      what a screen is drawn from: SDK results, approved views, kit-side values
//   KitStates      one pure state machine per UI-KITS §4.1 component → KitScreen
//   KitScreen      the state, the copy lines (catalog keys and arguments) and the actions
//   KitCopy        the ICU copy catalog in the launch locales, with per-locale overrides
//   KitIdentity    the product identity and the theme's resolution (§1.2, §3.1, §3.4)
//   PolarisKeyPreviewState  named inputs for previews, galleries and tests
//
// It imports no SwiftUI, so a UIKit, AppKit or custom-UI app builds on the same states, copy and
// models the drop-in kit (PolarisKeyUI) draws. conformance/corpus/v2/ui-matrix.json pins every
// state machine for every language; Tests/PolarisKeyUICoreTests runs every row of every family.

import Foundation
import PolarisKeyCore

public enum PolarisKeyUICore {
    /// The `uiMatrixVersion` of conformance/corpus/v2/ui-matrix.json these state machines
    /// implement. The conformance runner refuses a corpus at another version.
    public static let uiMatrixVersion = UI_MATRIX_VERSION
}
