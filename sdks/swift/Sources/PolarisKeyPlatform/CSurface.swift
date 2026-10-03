// The C-callable surface every host binds (the Godot GDExtension in sdks/godot/native/ios/, and
// later Unity, MAUI and Tauri). Three functions and nothing else:
//
//   char *pkp_call(const char *json);              // a JSON result; free it with pkp_free
//   void  pkp_free(char *p);
//   void  pkp_set_event_callback(void (*cb)(const char *json));   // NULL unregisters
//
// `pkp_call` is synchronous and safe from any thread; asynchronous ops answer
// {"ok":true,"req":N} and deliver their result later through the callback, on an arbitrary
// thread. `@_cdecl` (not Swift 6.2's `@c`) keeps the surface compilable with Xcode 16.4.

import Foundation

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
