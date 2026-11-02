// The binary ops behind `pkp_call_bin` (CC-14b.2, D-13). The table is empty in a normal process:
// an unknown op answers empty. The crypto ops (CC-14b.3, CryptoOps.swift) and the Cloud Sync bulk ops (U-41.5b, SyncBulkOps.swift) are added here.
//
// Two ops exist only when the process was started with PKEY_APPLE_SELFTEST=1, so the Godot suite
// can drive the real glue end to end: `selftest_echo` answers its input, `selftest_event` queues
// one binary event ("selftest", input) and answers empty. Neither touches a key.

import Foundation

public enum PlatformBinaryOps {
    /// The ops this process serves. `sink` receives binary events.
    public static func system(
        sink: PlatformEventSink, environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> [String: PlatformBinaryOp] {
        var ops: [String: PlatformBinaryOp] = [:]
        CryptoOps.register(into: &ops)
        SyncBulkOps(
            sink: sink, registry: SyncBulkRegistry.shared, allowLoopbackHttp: environment["PKEY_APPLE_SELFTEST"] == "1"
        ).register(into: &ops)
        WebAuthHost(sink: sink).register(into: &ops)
        #if canImport(Network)
            BonjourHost(sink: sink).register(into: &ops)
        #endif
        if environment["PKEY_APPLE_SELFTEST"] == "1" {
            ops["selftest_echo"] = { Array($0) }
            ops["selftest_event"] = { input in
                sink.emitBinary("selftest", Array(input))
                return []
            }
        }
        return ops
    }
}
