// The C-callable surface of the Godot Game Center extension (I-48.6a), the twin of
// PolarisKeyPlatformC's `pkp_*` functions with their own names, so both extensions can live in one
// process:
//
//   char *pkgc_call(const char *json);                  // free the result with pkgc_free
//   void  pkgc_free(char *p);
//   void  pkgc_set_event_callback(void (*cb)(const char *json));   // NULL unregisters
//
// Its own target, linked only by a native host that opted into Game Center (the Godot
// `pkey_gamecenter` extension), so GameKit is never linked by default.

import Foundation
import PolarisKeyPlatform

@_cdecl("pkgc_call")
public func pkgcCall(_ json: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let json else { return strdup(encodePlatformJSON(["ok": false, "error": "bad_json"])) }
    return strdup(GameCenterHost.shared.call(String(cString: json)))
}

@_cdecl("pkgc_free")
public func pkgcFree(_ p: UnsafeMutablePointer<CChar>?) {
    free(p)
}

@_cdecl("pkgc_set_event_callback")
public func pkgcSetEventCallback(_ cb: PlatformEventCallback?) {
    GameCenterHost.shared.sink.setCallback(cb)
}
