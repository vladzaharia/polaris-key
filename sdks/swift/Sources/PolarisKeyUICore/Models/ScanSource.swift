// @pkey-feature connect.local
// What Scan a code reads from (CC-29K.3): the camera on iOS and iPadOS (AVFoundation, in
// PolarisKeyUI), a fake in a test. The model never sees AVFoundation: it asks the source for the
// camera's state and for the texts of the QR codes it reads. The text goes to
// `LocalLinksDriver.join` unchanged, as the SDK defines (a QR is never limited by the dial budget).

import Foundation

/// The camera's permission, as the person last answered it.
public enum KitCameraStatus: String, Sendable, Equatable {
    /// The system has not asked yet: the kit shows its own pre-prompt first.
    case notDetermined
    case authorized
    /// Denied or restricted: the screen says so and links to Settings.
    case denied
    /// No camera on this device (a Mac, a simulator): there is no Scan a code.
    case unavailable
}

@MainActor
public protocol KitScanSource: AnyObject {
    var status: KitCameraStatus { get }
    /// Raises the system's camera prompt; true when the person allowed it.
    func requestAccess() async -> Bool
    /// The texts of the QR codes read while the stream is iterated. The capture starts with the
    /// iteration and stops when it ends or the task is cancelled.
    func codes() -> AsyncStream<String>
}
