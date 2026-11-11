// The wire of the Swift live-peer driver: JSON lines on stdout and stdin (tools/live-peer/README.md).
// stdout is the protocol: nothing else writes to it (logs go to stderr).

import CryptoKit
import Foundation

typealias JSON = [String: Any]

private let outLock = NSLock()

func send(_ m: JSON) {
    guard let data = try? JSONSerialization.data(withJSONObject: m, options: [.sortedKeys]) else { return }
    outLock.withLock {
        FileHandle.standardOutput.write(data + Data([0x0A]))
    }
}

func log(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

/// A refused command: the answer is `ok: false` with this error, and `extra` fields beside it.
struct Refusal: Error {
    var error: JSON
    var extra: JSON = [:]
}

func errorJSON(code: String? = nil, reason: String? = nil, cap: String? = nil, message: String) -> JSON {
    [
        "code": code ?? NSNull(), "reason": reason ?? NSNull(), "cap": cap ?? NSNull(), "message": message,
    ]
}

func sha256Hex(_ d: Data) -> String {
    SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined()
}

/// The content the harness hashes: the sender builds it, so a wrong pattern shows as a hash mismatch.
func pattern(_ n: Int) -> Data {
    Data((0..<n).map { UInt8(truncatingIfNeeded: $0 &* 7 &+ 13) })
}

func string(_ m: JSON, _ k: String) -> String? { m[k] as? String }
