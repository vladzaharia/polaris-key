// @pkey-feature ui.signin
// NearbyApproval's model (UI-KITS §4.1): the approving device's side of nearby sign-in. It holds
// the step and the asking device and answers the state machine; the nearby protocol that moves the
// steps is CC-15, so a host (or the protocol) calls `show` and the view follows.

import Foundation
import Observation

@MainActor
@Observable
public final class NearbyApprovalModel {
    /// The inputs the screen is drawn from.
    public private(set) var inputs: KitInputs
    /// The codes the asking device could be showing, one of which the person taps. The matching
    /// one is the action; there is no Approve button.
    public var codes: [String]
    /// Told when the person taps a code, or Not now.
    public var onChoose: (@MainActor (String) -> Void)?
    public var onDeny: (@MainActor () -> Void)?
    /// Told when the account menu's entry is chosen.
    public var onOpen: (@MainActor () -> Void)?

    public init(inputs: KitInputs = KitInputs(), codes: [String] = []) {
        self.inputs = inputs
        self.codes = codes
    }

    public var screen: KitScreen<NearbyApprovalState> { KitStates.nearbyApproval(inputs) }

    /// Moves to `step` for `device`.
    public func show(_ step: KitNearbyApproval.Step, device: String? = nil) {
        inputs.nearbyApproval = KitNearbyApproval(step: step, device: device)
    }
}
