// The C-callable surface every host binds (the Godot GDExtension in sdks/godot/native/ios/, and
// later Unity, MAUI and Tauri). Three functions and nothing else:
//
//   char *pkp_call(const char *json);              // a JSON result; free it with pkp_free
//   void  pkp_free(char *p);
//   void  pkp_set_event_callback(void (*cb)(const char *json));   // NULL unregisters
//
// and the binary entry (CC-14b.2, D-13), for keys and payloads that must not become JSON or a
// String:
//
//   uint8_t *pkp_call_bin(const char *op, const uint8_t *in, size_t n, size_t *out_n);
//   void     pkp_free_bin(uint8_t *p);
//   void     pkp_set_bin_event_callback(void (*cb)(const char *kind, const uint8_t *p, size_t n));
//
// `pkp_call_bin` answers NULL with *out_n = 0 for an unknown op, a NULL op or out_n, an input over
// 16 MiB, a NULL input with n > 0, or an empty result. The result is malloc'd: free it with
// pkp_free_bin (NULL is fine), and zero it first when it held key material. The input is not
// retained. The result buffer is zeroed here before the Swift copy is released.
//
// `pkp_call` is synchronous and safe from any thread; asynchronous ops answer
// {"ok":true,"req":N} and deliver their result later through the callback, on an arbitrary
// thread. `@_cdecl` (not Swift 6.2's `@c`) keeps the surface compilable with Xcode 16.4.
//
// It is its own target, PolarisKeyPlatformC, so a Swift consumer of PolarisKeyPlatform (the
// SDK's PolarisKeyUpdate, an app) does not export `pkp_*` symbols that would clash with another
// host's copy in the same process. Only a native host links it (the Godot xcframework build
// compiles it as a second module over PolarisKeyPlatform).

import Foundation
import PolarisKeyPlatform

@_cdecl("pkp_call")
public func pkp_call(_ json: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    let out = json.map { PlatformHost.shared.call(String(cString: $0)) }
        ?? encodePlatformJSON(["ok": false, "error": "bad_json"])
    return strdup(out)
}

@_cdecl("pkp_free")
public func pkp_free(_ p: UnsafeMutablePointer<CChar>?) {
    free(p)
}

@_cdecl("pkp_set_event_callback")
public func pkp_set_event_callback(_ cb: PlatformEventCallback?) {
    PlatformHost.shared.sink.setCallback(cb)
}

@_cdecl("pkp_call_bin")
public func pkp_call_bin(
    _ op: UnsafePointer<CChar>?, _ input: UnsafePointer<UInt8>?, _ n: Int, _ outN: UnsafeMutablePointer<Int>?
) -> UnsafeMutablePointer<UInt8>? {
    guard let outN else { return nil }
    outN.pointee = 0
    guard let op, n >= 0, n <= PlatformHost.maxBinaryBytes, input != nil || n == 0 else { return nil }
    let name = String(cString: op)
    var out: [UInt8]
    if let input, n > 0 {
        out = PlatformHost.shared.callBinary(name, UnsafeBufferPointer(start: input, count: n))
    } else {
        out = PlatformHost.shared.callBinary(name, UnsafeBufferPointer(start: nil, count: 0))
    }
    defer { out.withUnsafeMutableBytes { if let b = $0.baseAddress { _ = memset_s(b, $0.count, 0, $0.count) } } }
    guard !out.isEmpty, out.count <= PlatformHost.maxBinaryBytes, let buf = malloc(out.count) else { return nil }
    out.withUnsafeBytes { buf.copyMemory(from: $0.baseAddress!, byteCount: out.count) }
    outN.pointee = out.count
    return buf.assumingMemoryBound(to: UInt8.self)
}

@_cdecl("pkp_free_bin")
public func pkp_free_bin(_ p: UnsafeMutablePointer<UInt8>?) {
    free(p)
}

@_cdecl("pkp_set_bin_event_callback")
public func pkp_set_bin_event_callback(_ cb: PlatformEventSink.BinaryCallback?) {
    PlatformHost.shared.sink.setBinaryCallback(cb)
}
