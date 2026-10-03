// S-11 spike: Windows GDExtension sketch for P5-07. Research code.
//   PKeyVelopackNative   over velopack_libc (C API): check, download (worker thread, progress), apply on exit.
//   PKeyWinSparkleNative over WinSparkle.dll, loaded at RUNTIME (LoadLibraryW) so a missing DLL is
//                        a `dependency` answer, not an extension load failure.
//   PKeyStoreContextNative (Windows only): package identity and the StoreContext calls an
//                        unpackaged / non-Store app can make, on an MTA worker thread.
// The Velopack part also compiles on macOS (velopack_libc ships an osx static lib) for a local check.

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <appmodel.h>
#include <shobjidl_core.h>
#include <unknwn.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Services.Store.h>
#endif

#include <Velopack.h>

#include <gdextension_interface.h>
#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/defs.hpp>
#include <godot_cpp/godot.hpp>
#include <godot_cpp/variant/dictionary.hpp>
#include <godot_cpp/variant/packed_string_array.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <string>
#include <thread>

using namespace godot;

static void emit_deferred(uint64_t id, const char *signal, const String &event, const Dictionary &detail) {
  Object *o = ObjectDB::get_instance(ObjectID(id));
  if (o) o->call_deferred("emit_signal", signal, event, detail);
}

static bool is_main_thread_now() {
#ifdef _WIN32
  // Godot's main thread is the one that loaded us; compare with the recorded id.
  extern DWORD g_main_tid;
  return GetCurrentThreadId() == g_main_tid;
#else
  return true;
#endif
}
#ifdef _WIN32
DWORD g_main_tid = 0;
#endif

// ── Velopack ────────────────────────────────────────────────────────────────────────────────

static String vpk_last_error() {
  char buf[2048] = {0};
  vpkc_get_last_error(buf, sizeof(buf));
  return String::utf8(buf);
}

static Dictionary asset_dict(vpkc_asset_t *a) {
  Dictionary d;
  if (!a) return d;
  d["id"] = String::utf8(a->PackageId ? a->PackageId : "");
  d["version"] = String::utf8(a->Version ? a->Version : "");
  d["type"] = String::utf8(a->Type ? a->Type : "");
  d["file"] = String::utf8(a->FileName ? a->FileName : "");
  d["size"] = (int64_t)a->Size;
  return d;
}

class PKeyVelopackNative : public RefCounted {
  GDCLASS(PKeyVelopackNative, RefCounted)
  vpkc_update_manager_t *mgr_ = nullptr;
  vpkc_update_info_t *info_ = nullptr;
  std::thread worker_;
  std::atomic<bool> busy_{false};
  std::atomic<bool> downloaded_{false};

 protected:
  static void _bind_methods() {
    ClassDB::bind_method(D_METHOD("open", "url"), &PKeyVelopackNative::open);
    ClassDB::bind_method(D_METHOD("check"), &PKeyVelopackNative::check);
    ClassDB::bind_method(D_METHOD("download_async"), &PKeyVelopackNative::download_async);
    ClassDB::bind_method(D_METHOD("apply_on_exit", "restart"), &PKeyVelopackNative::apply_on_exit);
    ClassDB::bind_method(D_METHOD("is_busy"), &PKeyVelopackNative::is_busy);
    ADD_SIGNAL(MethodInfo("velopack_event", PropertyInfo(Variant::STRING, "event"), PropertyInfo(Variant::DICTIONARY, "detail")));
  }

 public:
  ~PKeyVelopackNative() {
    if (worker_.joinable()) worker_.join();
    if (info_) vpkc_free_update_info(info_);
    if (mgr_) vpkc_free_update_manager(mgr_);
  }

  Dictionary open(const String &url) {
    Dictionary d;
    vpkc_update_options_t opts{};
    opts.AllowVersionDowngrade = false;
    opts.ExplicitChannel = nullptr;
    opts.MaximumDeltasBeforeFallback = 10;
    bool ok = vpkc_new_update_manager(url.utf8().get_data(), &opts, nullptr, &mgr_);
    d["ok"] = ok;
    if (!ok) {
      d["error"] = "not_installed_or_bad_source";
      d["message"] = vpk_last_error();
      mgr_ = nullptr;
      return d;
    }
    char ver[256] = {0};
    vpkc_get_current_version(mgr_, ver, sizeof(ver));
    char app[256] = {0};
    vpkc_get_app_id(mgr_, app, sizeof(app));
    d["current_version"] = String::utf8(ver);
    d["app_id"] = String::utf8(app);
    d["portable"] = vpkc_is_portable(mgr_);
    return d;
  }

  // Synchronous: one small HTTP GET. P5-07 should move it to the worker thread too.
  Dictionary check() {
    Dictionary d;
    if (!mgr_) { d["status"] = "not_open"; return d; }
    if (info_) { vpkc_free_update_info(info_); info_ = nullptr; }
    auto t0 = std::chrono::steady_clock::now();
    vpkc_update_check_t r = vpkc_check_for_updates(mgr_, &info_);
    d["ms"] = (double)std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - t0).count() / 1000.0;
    switch (r) {
      case UPDATE_AVAILABLE: {
        d["status"] = "available";
        d["target"] = asset_dict(info_->TargetFullRelease);
        d["base"] = asset_dict(info_->BaseRelease);
        Array deltas;
        for (size_t i = 0; i < info_->DeltasToTargetCount; i++) deltas.push_back(asset_dict(info_->DeltasToTarget[i]));
        d["deltas"] = deltas;
        d["is_downgrade"] = info_->IsDowngrade;
        break;
      }
      case NO_UPDATE_AVAILABLE: d["status"] = "none"; break;
      case REMOTE_IS_EMPTY: d["status"] = "remote_empty"; break;
      default: d["status"] = "error"; d["message"] = vpk_last_error(); break;
    }
    return d;
  }

  struct Progress { uint64_t id; int last; };
  static void on_progress(void *user, size_t pct) {
    Progress *p = (Progress *)user;
    if ((int)pct >= p->last + 10 || pct == 100) {
      p->last = (int)pct;
      Dictionary d;
      d["percent"] = (int64_t)pct;
      d["main_thread"] = is_main_thread_now();
      emit_deferred(p->id, "velopack_event", "progress", d);
    }
  }

  bool download_async() {
    if (!mgr_ || !info_ || busy_.exchange(true)) return false;
    if (worker_.joinable()) worker_.join();
    uint64_t id = get_instance_id();
    vpkc_update_manager_t *mgr = mgr_;
    vpkc_update_info_t *info = info_;
    worker_ = std::thread([this, id, mgr, info]() {
      Progress p{id, -10};
      auto t0 = std::chrono::steady_clock::now();
      bool ok = vpkc_download_updates(mgr, info, &PKeyVelopackNative::on_progress, &p);
      Dictionary d;
      d["ok"] = ok;
      d["ms"] = (double)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
      if (!ok) d["message"] = vpk_last_error();
      downloaded_ = ok;
      busy_ = false;
      emit_deferred(id, "velopack_event", ok ? "downloaded" : "download_failed", d);
    });
    return true;
  }

  // Starts Update.exe, which waits for this process to exit, applies, and (optionally) restarts
  // the main exe (the shim). The caller must then quit the SceneTree.
  Dictionary apply_on_exit(bool restart) {
    Dictionary d;
    if (!mgr_ || !info_ || !downloaded_) { d["ok"] = false; d["error"] = "nothing_downloaded"; return d; }
    bool ok = vpkc_wait_exit_then_apply_updates(mgr_, info_->TargetFullRelease, true, restart, nullptr, 0);
    d["ok"] = ok;
    if (!ok) d["message"] = vpk_last_error();
    return d;
  }

  bool is_busy() const { return busy_; }
};

#ifdef _WIN32
// ── WinSparkle (runtime-loaded) ─────────────────────────────────────────────────────────────

namespace ws {
typedef void(__cdecl *vfn)();
typedef void(__cdecl *sfn)(const char *);
typedef void(__cdecl *ssfn)(const char *, const char *);
typedef void(__cdecl *detailsfn)(const wchar_t *, const wchar_t *, const wchar_t *);
typedef void(__cdecl *wfn)(const wchar_t *);
typedef int(__cdecl *ifn)();
typedef void(__cdecl *setcb_v)(vfn);
typedef void(__cdecl *setcb_i)(ifn);
typedef int(__cdecl *runinst_cb)(const wchar_t *);
typedef void(__cdecl *setcb_run)(runinst_cb);
typedef void(__cdecl *setint)(int);
HMODULE dll = nullptr;
std::atomic<uint64_t> owner{0};
}  // namespace ws

#define WS_FN(type, name) auto name = (ws::type)GetProcAddress(ws::dll, #name)

static void ws_emit(const char *ev) {
  Dictionary d;
  d["main_thread"] = is_main_thread_now();
  d["tid"] = (int64_t)GetCurrentThreadId();
  emit_deferred(ws::owner, "winsparkle_event", ev, d);
}
static void __cdecl ws_on_error() { ws_emit("error"); }
static int __cdecl ws_can_shutdown() { ws_emit("can_shutdown"); return 1; }
static void __cdecl ws_on_shutdown() { ws_emit("shutdown_request"); }
static void __cdecl ws_on_found() { ws_emit("did_find_update"); }
static void __cdecl ws_on_not_found() { ws_emit("did_not_find_update"); }
static void __cdecl ws_on_cancelled() { ws_emit("update_cancelled"); }
static void __cdecl ws_on_dismissed() { ws_emit("update_dismissed"); }
static int __cdecl ws_on_run_installer(const wchar_t *path) {
  Dictionary d;
  d["path"] = String((const char16_t *)path);
  d["main_thread"] = is_main_thread_now();
  emit_deferred(ws::owner, "winsparkle_event", "run_installer", d);
  return 0;  // let WinSparkle run it (with sparkle:installerArguments)
}

class PKeyWinSparkleNative : public RefCounted {
  GDCLASS(PKeyWinSparkleNative, RefCounted)
 protected:
  static void _bind_methods() {
    ClassDB::bind_method(D_METHOD("load", "dll_path"), &PKeyWinSparkleNative::load);
    ClassDB::bind_method(D_METHOD("start", "appcast_url", "eddsa_pub", "company", "app", "version", "headers"), &PKeyWinSparkleNative::start);
    ClassDB::bind_method(D_METHOD("check", "mode"), &PKeyWinSparkleNative::check);
    ClassDB::bind_method(D_METHOD("cleanup"), &PKeyWinSparkleNative::cleanup);
    ADD_SIGNAL(MethodInfo("winsparkle_event", PropertyInfo(Variant::STRING, "event"), PropertyInfo(Variant::DICTIONARY, "detail")));
  }

 public:
  Dictionary load(const String &dll_path) {
    Dictionary d;
    if (!ws::dll) ws::dll = LoadLibraryW((const wchar_t *)dll_path.utf16().get_data());
    d["ok"] = ws::dll != nullptr;
    if (!ws::dll) { d["error"] = "dependency"; d["win32"] = (int64_t)GetLastError(); }
    return d;
  }

  Dictionary start(const String &url, const String &pub, const String &company, const String &app, const String &version, const Dictionary &headers) {
    Dictionary d;
    if (!ws::dll) { d["ok"] = false; d["error"] = "dependency"; return d; }
    if (pub.is_empty()) { d["ok"] = false; d["error"] = "missing_public_key"; return d; }
    ws::owner = get_instance_id();
    WS_FN(sfn, win_sparkle_set_appcast_url);
    WS_FN(sfn, win_sparkle_set_eddsa_public_key);
    WS_FN(detailsfn, win_sparkle_set_app_details);
    WS_FN(ssfn, win_sparkle_set_http_header);
    WS_FN(setint, win_sparkle_set_automatic_check_for_updates);
    WS_FN(setcb_v, win_sparkle_set_error_callback);
    WS_FN(setcb_i, win_sparkle_set_can_shutdown_callback);
    WS_FN(setcb_v, win_sparkle_set_shutdown_request_callback);
    WS_FN(setcb_v, win_sparkle_set_did_find_update_callback);
    WS_FN(setcb_v, win_sparkle_set_did_not_find_update_callback);
    WS_FN(setcb_v, win_sparkle_set_update_cancelled_callback);
    WS_FN(setcb_v, win_sparkle_set_update_dismissed_callback);
    WS_FN(setcb_run, win_sparkle_set_user_run_installer_callback);
    WS_FN(vfn, win_sparkle_init);
    if (!win_sparkle_set_appcast_url || !win_sparkle_init || !win_sparkle_set_eddsa_public_key) { d["ok"] = false; d["error"] = "dependency_symbols"; return d; }
    win_sparkle_set_appcast_url(url.utf8().get_data());
    win_sparkle_set_eddsa_public_key(pub.utf8().get_data());
    win_sparkle_set_app_details((const wchar_t *)company.utf16().get_data(), (const wchar_t *)app.utf16().get_data(), (const wchar_t *)version.utf16().get_data());
    Array keys = headers.keys();
    for (int i = 0; i < keys.size(); i++) win_sparkle_set_http_header(String(keys[i]).utf8().get_data(), String(headers[keys[i]]).utf8().get_data());
    win_sparkle_set_automatic_check_for_updates(0);
    win_sparkle_set_error_callback(ws_on_error);
    win_sparkle_set_can_shutdown_callback(ws_can_shutdown);
    win_sparkle_set_shutdown_request_callback(ws_on_shutdown);
    win_sparkle_set_did_find_update_callback(ws_on_found);
    win_sparkle_set_did_not_find_update_callback(ws_on_not_found);
    win_sparkle_set_update_cancelled_callback(ws_on_cancelled);
    win_sparkle_set_update_dismissed_callback(ws_on_dismissed);
    if (win_sparkle_set_user_run_installer_callback) win_sparkle_set_user_run_installer_callback(ws_on_run_installer);
    win_sparkle_init();
    d["ok"] = true;
    return d;
  }

  void check(const String &mode) {
    if (!ws::dll) return;
    if (mode == "install") { WS_FN(vfn, win_sparkle_check_update_with_ui_and_install); win_sparkle_check_update_with_ui_and_install(); }
    else if (mode == "ui") { WS_FN(vfn, win_sparkle_check_update_with_ui); win_sparkle_check_update_with_ui(); }
    else { WS_FN(vfn, win_sparkle_check_update_without_ui); win_sparkle_check_update_without_ui(); }
  }

  void cleanup() {
    if (!ws::dll) return;
    WS_FN(vfn, win_sparkle_cleanup);
    if (win_sparkle_cleanup) win_sparkle_cleanup();
  }
};

// ── StoreContext ────────────────────────────────────────────────────────────────────────────

static String hr_hex(int32_t hr) {
  char b[16];
  snprintf(b, sizeof(b), "0x%08X", (uint32_t)hr);
  return String(b);
}

class PKeyStoreContextNative : public RefCounted {
  GDCLASS(PKeyStoreContextNative, RefCounted)
  std::thread worker_;

 protected:
  static void _bind_methods() {
    ClassDB::bind_static_method("PKeyStoreContextNative", D_METHOD("package_identity"), &PKeyStoreContextNative::package_identity);
    ClassDB::bind_method(D_METHOD("probe_async", "hwnd"), &PKeyStoreContextNative::probe_async);
    ADD_SIGNAL(MethodInfo("store_event", PropertyInfo(Variant::STRING, "event"), PropertyInfo(Variant::DICTIONARY, "detail")));
  }

 public:
  ~PKeyStoreContextNative() {
    if (worker_.joinable()) worker_.join();
  }

  static Dictionary package_identity() {
    Dictionary d;
    UINT32 len = 0;
    LONG rc = GetCurrentPackageFullName(&len, nullptr);
    d["rc"] = (int64_t)rc;  // 15700 = APPMODEL_ERROR_NO_PACKAGE; 122 = ERROR_INSUFFICIENT_BUFFER (packaged)
    if (rc == ERROR_INSUFFICIENT_BUFFER) {
      std::wstring name(len, L'\0');
      rc = GetCurrentPackageFullName(&len, name.data());
      d["rc"] = (int64_t)rc;
      if (rc == ERROR_SUCCESS) d["full_name"] = String((const char16_t *)name.c_str());
    }
    d["packaged"] = rc == ERROR_SUCCESS;
    return d;
  }

  // Runs the StoreContext calls on an MTA thread (blocking .get() is not allowed on an STA such as
  // Godot's main/UI thread) and reports each result as a signal on the main thread.
  bool probe_async(int64_t hwnd) {
    if (worker_.joinable()) worker_.join();
    uint64_t id = get_instance_id();
    worker_ = std::thread([id, hwnd]() {
      using namespace winrt;
      using namespace winrt::Windows::Services::Store;
      Dictionary d;
      try {
        init_apartment(apartment_type::multi_threaded);
      } catch (...) {
      }
      auto step = [&](const char *name, auto &&fn) {
        Dictionary r;
        auto t0 = std::chrono::steady_clock::now();
        try {
          fn(r);
          r["ok"] = true;
        } catch (hresult_error const &e) {
          r["ok"] = false;
          r["hresult"] = hr_hex(e.code());
          r["message"] = String((const char16_t *)e.message().c_str());
        } catch (...) {
          r["ok"] = false;
          r["message"] = "unknown exception";
        }
        r["ms"] = (double)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
        d[name] = r;
      };
      StoreContext ctx{nullptr};
      step("get_default", [&](Dictionary &r) { ctx = StoreContext::GetDefault(); r["null"] = ctx == nullptr; });
      if (ctx) {
        step("initialize_with_window", [&](Dictionary &r) {
          auto iww = ctx.as<::IInitializeWithWindow>();
          r["hr"] = hr_hex(iww->Initialize((HWND)(intptr_t)hwnd));
        });
        step("get_store_product_for_current_app", [&](Dictionary &r) {
          auto res = ctx.GetStoreProductForCurrentAppAsync().get();
          r["extended_error"] = hr_hex(res.ExtendedError().value);
          r["has_product"] = res.Product() != nullptr;
          if (res.Product()) r["store_id"] = String((const char16_t *)res.Product().StoreId().c_str());
        });
        step("get_app_and_optional_store_package_updates", [&](Dictionary &r) {
          auto ups = ctx.GetAppAndOptionalStorePackageUpdatesAsync().get();
          r["count"] = (int64_t)ups.Size();
        });
        step("can_silently_download_store_package_updates", [&](Dictionary &r) {
          r["value"] = ctx.CanSilentlyDownloadStorePackageUpdates();
        });
        step("get_app_license", [&](Dictionary &r) {
          auto lic = ctx.GetAppLicenseAsync().get();
          r["is_active"] = lic.IsActive();
          r["is_trial"] = lic.IsTrial();
          r["sku_store_id"] = String((const char16_t *)lic.SkuStoreId().c_str());
        });
      }
      d["main_thread"] = is_main_thread_now();
      emit_deferred(id, "store_event", "probe", d);
    });
    return true;
  }
};
#endif  // _WIN32

static void initialize(ModuleInitializationLevel level) {
  if (level != MODULE_INITIALIZATION_LEVEL_SCENE) return;
#ifdef _WIN32
  g_main_tid = GetCurrentThreadId();
#endif
  GDREGISTER_CLASS(PKeyVelopackNative);
#ifdef _WIN32
  GDREGISTER_CLASS(PKeyWinSparkleNative);
  GDREGISTER_CLASS(PKeyStoreContextNative);
#endif
}
static void uninitialize(ModuleInitializationLevel level) {}

extern "C" GDExtensionBool GDE_EXPORT pkey_win_init(GDExtensionInterfaceGetProcAddress p_get_proc_address, GDExtensionClassLibraryPtr p_library,
                                                    GDExtensionInitialization *r_initialization) {
  GDExtensionBinding::InitObject init_obj(p_get_proc_address, p_library, r_initialization);
  init_obj.register_initializer(initialize);
  init_obj.register_terminator(uninitialize);
  init_obj.set_minimum_library_initialization_level(MODULE_INITIALIZATION_LEVEL_SCENE);
  return init_obj.init();
}
