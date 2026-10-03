// PKeyWinSparkleNative: WinSparkle from a Godot Windows export (P5-07; notes/S-11 §4.3, §8 step
// 4). The GDScript facade is addons/polaris_key/native/pkey_winsparkle.gd.
//
// WinSparkle.dll is loaded at RUN TIME from beside the executable, so without it the extension
// still loads and load() answers "dependency". The functions are declared here, not through
// winsparkle.h, whose `#pragma comment(lib, "WinSparkle.lib")` would import-link the DLL.
//
//   load(path)        LoadLibraryExW + GetProcAddress
//   start(...)        appcast URL, EdDSA public key (refused when WinSparkle rejects it),
//                     app details, headers, automatic checks off, every callback, then
//                     win_sparkle_init. Once per process: WinSparkle has one global updater.
//   check(mode)       "install" (check, download, verify EdDSA, run the installer with the feed's
//                     sparkle:installerArguments), "ui" (the dialog), "silent" (no UI)
//   cleanup()         win_sparkle_cleanup (also when the extension unloads)
//
// WinSparkle calls back on its own threads: every callback is deferred to the main thread as
// `native_event`. `can_shutdown` answers yes and `shutdown_request` asks the facade to quit the
// game, so the installer can replace its files.

#include "../src/pkey_win_common.h"

#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/array.hpp>

#include <atomic>
#include <mutex>

using namespace godot;

namespace {

typedef void(__cdecl *ws_void_fn)();
typedef int(__cdecl *ws_int_fn)();
typedef int(__cdecl *ws_run_installer_fn)(const wchar_t *);

struct WinSparkleApi {
  HMODULE module = nullptr;
  void(__cdecl *set_appcast_url)(const char *) = nullptr;
  int(__cdecl *set_eddsa_public_key)(const char *) = nullptr;
  void(__cdecl *set_app_details)(const wchar_t *, const wchar_t *, const wchar_t *) = nullptr;
  void(__cdecl *set_http_header)(const char *, const char *) = nullptr;
  void(__cdecl *set_automatic_check_for_updates)(int) = nullptr;
  void(__cdecl *set_error_callback)(ws_void_fn) = nullptr;
  void(__cdecl *set_can_shutdown_callback)(ws_int_fn) = nullptr;
  void(__cdecl *set_shutdown_request_callback)(ws_void_fn) = nullptr;
  void(__cdecl *set_did_find_update_callback)(ws_void_fn) = nullptr;
  void(__cdecl *set_did_not_find_update_callback)(ws_void_fn) = nullptr;
  void(__cdecl *set_update_cancelled_callback)(ws_void_fn) = nullptr;
  void(__cdecl *set_update_dismissed_callback)(ws_void_fn) = nullptr;
  void(__cdecl *set_user_run_installer_callback)(ws_run_installer_fn) = nullptr;
  void(__cdecl *init)() = nullptr;
  void(__cdecl *cleanup)() = nullptr;
  void(__cdecl *check_update_with_ui)() = nullptr;
  void(__cdecl *check_update_with_ui_and_install)() = nullptr;
  void(__cdecl *check_update_without_ui)() = nullptr;
};

WinSparkleApi g_ws;
std::mutex g_ws_lock;
std::atomic<uint64_t> g_owner{0};
std::atomic<bool> g_started{false};

void ws_emit(const char *event, Dictionary d = Dictionary()) {
  d["thread"] = (int64_t)GetCurrentThreadId();
  pkey_win::emit(g_owner, event, d);
}

void __cdecl on_error() { ws_emit("error"); }
int __cdecl on_can_shutdown() {
  ws_emit("can_shutdown");
  return 1;
}
void __cdecl on_shutdown_request() { ws_emit("shutdown_request"); }
void __cdecl on_did_find_update() { ws_emit("did_find_update"); }
void __cdecl on_did_not_find_update() { ws_emit("did_not_find_update"); }
void __cdecl on_update_cancelled() { ws_emit("update_cancelled"); }
void __cdecl on_update_dismissed() { ws_emit("update_dismissed"); }
int __cdecl on_run_installer(const wchar_t *path) {
  Dictionary d;
  d["path"] = pkey_win::from_wide(path);
  ws_emit("run_installer", d);
  return 0;  // WinSparkle runs it, with the feed's sparkle:installerArguments
}

}  // namespace

class PKeyWinSparkleNative : public RefCounted {
  GDCLASS(PKeyWinSparkleNative, RefCounted)

  static Dictionary fail(const char *code, const String &message = String()) {
    Dictionary d;
    d["ok"] = false;
    d["error"] = code;
    if (!message.is_empty()) d["message"] = message;
    return d;
  }

 protected:
  static void _bind_methods() {
    ClassDB::bind_method(D_METHOD("load", "path"), &PKeyWinSparkleNative::load);
    ClassDB::bind_method(D_METHOD("start", "appcast_url", "eddsa_public_key", "company", "app", "version", "headers"), &PKeyWinSparkleNative::start);
    ClassDB::bind_method(D_METHOD("check", "mode"), &PKeyWinSparkleNative::check);
    ClassDB::bind_method(D_METHOD("cleanup"), &PKeyWinSparkleNative::cleanup);
    ADD_SIGNAL(MethodInfo("native_event", PropertyInfo(Variant::STRING, "event"), PropertyInfo(Variant::DICTIONARY, "detail")));
  }

 public:
  Dictionary load(const String &path) {
    std::lock_guard<std::mutex> lock(g_ws_lock);
    if (g_ws.module) {
      Dictionary ok;
      ok["ok"] = true;
      return ok;
    }
    int64_t win32 = 0;
    HMODULE m = pkey_win::load_beside(path, win32);
    if (!m) {
      Dictionary d = fail("dependency");
      d["win32"] = win32;
      return d;
    }
    WinSparkleApi a;
    a.module = m;
    using pkey_win::resolve;
    bool ok = resolve(m, "win_sparkle_set_appcast_url", a.set_appcast_url) &&
              resolve(m, "win_sparkle_set_eddsa_public_key", a.set_eddsa_public_key) &&
              resolve(m, "win_sparkle_set_app_details", a.set_app_details) &&
              resolve(m, "win_sparkle_set_http_header", a.set_http_header) &&
              resolve(m, "win_sparkle_set_automatic_check_for_updates", a.set_automatic_check_for_updates) &&
              resolve(m, "win_sparkle_set_error_callback", a.set_error_callback) &&
              resolve(m, "win_sparkle_set_can_shutdown_callback", a.set_can_shutdown_callback) &&
              resolve(m, "win_sparkle_set_shutdown_request_callback", a.set_shutdown_request_callback) &&
              resolve(m, "win_sparkle_set_did_find_update_callback", a.set_did_find_update_callback) &&
              resolve(m, "win_sparkle_set_did_not_find_update_callback", a.set_did_not_find_update_callback) &&
              resolve(m, "win_sparkle_set_update_cancelled_callback", a.set_update_cancelled_callback) &&
              resolve(m, "win_sparkle_set_update_dismissed_callback", a.set_update_dismissed_callback) &&
              resolve(m, "win_sparkle_set_user_run_installer_callback", a.set_user_run_installer_callback) &&
              resolve(m, "win_sparkle_init", a.init) && resolve(m, "win_sparkle_cleanup", a.cleanup) &&
              resolve(m, "win_sparkle_check_update_with_ui", a.check_update_with_ui) &&
              resolve(m, "win_sparkle_check_update_with_ui_and_install", a.check_update_with_ui_and_install) &&
              resolve(m, "win_sparkle_check_update_without_ui", a.check_update_without_ui);
    if (!ok) {
      FreeLibrary(m);
      return fail("dependency", "WinSparkle.dll lacks a function this plugin needs (0.9.0 or later is required)");
    }
    g_ws = a;
    Dictionary d;
    d["ok"] = true;
    return d;
  }

  Dictionary start(const String &url, const String &pub, const String &company, const String &app, const String &version,
                   const Dictionary &headers) {
    if (!g_ws.module) return fail("dependency");
    if (pub.is_empty()) return fail("missing_public_key");
    if (url.is_empty()) return fail("missing_appcast_url");
    if (g_started.exchange(true)) return fail("already_started");
    g_owner = get_instance_id();
    g_ws.set_appcast_url(url.utf8().get_data());
    if (g_ws.set_eddsa_public_key(pub.utf8().get_data()) != 1) {
      g_started = false;
      return fail("bad_public_key", "WinSparkle rejected the EdDSA public key");
    }
    std::wstring wc = pkey_win::wide(company), wa = pkey_win::wide(app), wv = pkey_win::wide(version);
    g_ws.set_app_details(wc.c_str(), wa.c_str(), wv.c_str());
    Array keys = headers.keys();
    for (int64_t i = 0; i < keys.size(); i++)
      g_ws.set_http_header(String(keys[i]).utf8().get_data(), String(headers[keys[i]]).utf8().get_data());
    g_ws.set_automatic_check_for_updates(0);
    g_ws.set_error_callback(on_error);
    g_ws.set_can_shutdown_callback(on_can_shutdown);
    g_ws.set_shutdown_request_callback(on_shutdown_request);
    g_ws.set_did_find_update_callback(on_did_find_update);
    g_ws.set_did_not_find_update_callback(on_did_not_find_update);
    g_ws.set_update_cancelled_callback(on_update_cancelled);
    g_ws.set_update_dismissed_callback(on_update_dismissed);
    g_ws.set_user_run_installer_callback(on_run_installer);
    g_ws.init();
    Dictionary d;
    d["ok"] = true;
    return d;
  }

  void check(const String &mode) {
    if (!g_started) return;
    if (mode == "install")
      g_ws.check_update_with_ui_and_install();
    else if (mode == "ui")
      g_ws.check_update_with_ui();
    else
      g_ws.check_update_without_ui();
  }

  void cleanup() { pkey_win::winsparkle_shutdown(); }
};

void pkey_win::winsparkle_shutdown() {
  if (g_started.exchange(false) && g_ws.cleanup) g_ws.cleanup();
}

void pkey_win::register_winsparkle() { GDREGISTER_CLASS(PKeyWinSparkleNative); }
