// Probe only, simulator only: start a StoreKit Testing session inside the Godot process so the
// real purchase path can run without Xcode's scheme option or an Apple account. Never shipped.
import Foundation
import StoreKitTest
import os

private let held = OSAllocatedUnfairLock<SKTestSession?>(initialState: nil)

@_cdecl("pkp_probe_start_sk_session")
public func pkp_probe_start_sk_session(_ path: UnsafePointer<CChar>) -> Int32 {
    do {
        let s = try SKTestSession(contentsOf: URL(fileURLWithPath: String(cString: path)))
        s.disableDialogs = true
        s.clearTransactions()
        held.withLock { $0 = s }
        return 0
    } catch {
        return 1
    }
}

@_cdecl("pkp_probe_refund")
public func pkp_probe_refund(_ id: UInt64) -> Int32 {
    guard let s = held.withLock({ $0 }) else { return 2 }
    do { try s.refundTransaction(identifier: UInt(id)); return 0 } catch { return 1 }
}
