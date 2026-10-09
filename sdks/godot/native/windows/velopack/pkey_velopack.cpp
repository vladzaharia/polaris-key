// PKeyVelopackNative: Velopack's UpdateManager from a Godot Windows export (P5-07; notes/S-11
// §4.2, §8 step 3). The GDScript facade is addons/polaris_key/native/pkey_velopack.gd.
//
// velopack_libc.dll is loaded at RUN TIME from beside the executable (load_library): an
// import-linked DLL that is missing makes Godot drop the whole extension, and with it WinSparkle
// and StoreContext (notes/S-11 §4.5). Its header gives the types; the functions are resolved
// with GetProcAddress into decltype'd pointers.
//
//   open(url, headers)  an HttpSource over the feed directory with the headers
//                       (vpkc_new_source_http_url_with_options: Velopack sends none otherwise),
//                       then an UpdateManager on it. The feed's FileNames are bare file names
//                       resolved against `url` (the Worker 302s them to the package bytes).
//   check_async()       vpkc_check_for_updates on a worker thread -> "checked"
//   download_async()    vpkc_download_updates on a worker thread -> "progress", then
//                       "downloaded" or "download_failed"
//   apply_on_exit(r)    vpkc_wait_exit_then_apply_updates(silent, restart): Update.exe waits
//                       for this process to exit, applies and restarts the main exe (the shim);
//                       the caller quits the game at once

#include "../src/pkey_win_common.h"

#include <Velopack.h>

#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/array.hpp>

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace godot;

namespace {

struct VelopackApi {
  HMODULE module = nullptr;
  decltype(&::vpkc_new_source_http_url_with_options) new_source = nullptr;
  decltype(&::vpkc_free_source) free_source = nullptr;
  decltype(&::vpkc_new_update_manager_with_source) new_manager = nullptr;
  decltype(&::vpkc_free_update_manager) free_manager = nullptr;
  decltype(&::vpkc_get_current_version) current_version = nullptr;
  decltype(&::vpkc_get_app_id) app_id = nullptr;
  decltype(&::vpkc_is_portable) is_portable = nullptr;
  decltype(&::vpkc_check_for_updates) check = nullptr;
  decltype(&::vpkc_download_updates) download = nullptr;
  decltype(&::vpkc_wait_exit_then_apply_updates) apply = nullptr;
  decltype(&::vpkc_free_update_info) free_info = nullptr;
  decltype(&::vpkc_get_last_error) last_error = nullptr;
};

VelopackApi g_api;
std::mutex g_api_lock;

String last_error() {
  if (!g_api.last_error) return String();
  char buf[2048] = {0};
  g_api.last_error(buf, sizeof(buf));
  return String::utf8(buf);
}

Dictionary asset_dict(const vpkc_asset_t *a) {
  Dictionary d;
  if (!a) return d;
  d["id"] = String::utf8(a->PackageId ? a->PackageId : "");
  d["version"] = String::utf8(a->Version ? a->Version : "");
  d["type"] = String::utf8(a->Type ? a->Type : "");
  d["file"] = String::utf8(a->FileName ? a->FileName : "");
  d["size"] = (int64_t)a->Size;
  return d;
}

}  // namespace

class PKeyVelopackNative : public RefCounted {
  GDCLASS(PKeyVelopackNative, RefCounted)

  vpkc_update_source_t *source_ = nullptr;
  vpkc_update_manager_t *mgr_ = nullptr;
  vpkc_update_info_t *info_ = nullptr;
  // The header strings handed to the source, kept alive with it.
  std::vector<std::string> header_text_;
  std::vector<vpkc_http_header_t> header_rows_;
  std::vector<vpkc_http_header_t *> header_ptrs_;
  std::thread worker_;
  std::atomic<bool> busy_{false};
  std::atomic<bool> downloaded_{false};
  std::atomic<int64_t> next_request_{0};

  struct Progress {
    uint64_t owner;
    int64_t request;
    int last;
  };

  static void on_progress(void *user, size_t pct) {
    Progress *p = static_cast<Progress *>(user);
    if ((int)pct >= p->last + 5 || pct == 100) {
      p->last = (int)pct;
      Dictionary d;
      d["request"] = p->request;
      d["percent"] = (int64_t)pct;
      pkey_win::emit(p->owner, "progress", d);
    }
  }

  void join() {
    if (worker_.joinable()) worker_.join();
  }

 protected:
  static void _bind_methods() {
    ClassDB::bind_method(D_METHOD("load_library", "path"), &PKeyVelopackNative::load_library);
    ClassDB::bind_method(D_METHOD("open", "url", "headers"), &PKeyVelopackNative::open);
    ClassDB::bind_method(D_METHOD("check_async"), &PKeyVelopackNative::check_async);
    ClassDB::bind_method(D_METHOD("download_async"), &PKeyVelopackNative::download_async);
    ClassDB::bind_method(D_METHOD("apply_on_exit", "restart"), &PKeyVelopackNative::apply_on_exit);
    ClassDB::bind_method(D_METHOD("is_busy"), &PKeyVelopackNative::is_busy);
    ADD_SIGNAL(MethodInfo("native_event", PropertyInfo(Variant::STRING, "event"), PropertyInfo(Variant::DICTIONARY, "detail")));
  }

 public:
  ~PKeyVelopackNative() {
    join();
    if (info_ && g_api.free_info) g_api.free_info(info_);
    if (mgr_ && g_api.free_manager) g_api.free_manager(mgr_);
    if (source_ && g_api.free_source) g_api.free_source(source_);
  }

  Dictionary load_library(const String &path) {
    std::lock_guard<std::mutex> lock(g_api_lock);
    Dictionary d;
    if (!g_api.module) {
      int64_t win32 = 0;
      HMODULE m = pkey_win::load_beside(path, win32);
      if (!m) {
        d["ok"] = false;
        d["error"] = "dependency";
        d["win32"] = win32;
        return d;
      }
      VelopackApi api;
      api.module = m;
      bool ok = pkey_win::resolve(m, "vpkc_new_source_http_url_with_options", api.new_source) &&
                pkey_win::resolve(m, "vpkc_free_source", api.free_source) &&
                pkey_win::resolve(m, "vpkc_new_update_manager_with_source", api.new_manager) &&
                pkey_win::resolve(m, "vpkc_free_update_manager", api.free_manager) &&
                pkey_win::resolve(m, "vpkc_get_current_version", api.current_version) &&
                pkey_win::resolve(m, "vpkc_get_app_id", api.app_id) &&
                pkey_win::resolve(m, "vpkc_is_portable", api.is_portable) &&
                pkey_win::resolve(m, "vpkc_check_for_updates", api.check) &&
                pkey_win::resolve(m, "vpkc_download_updates", api.download) &&
                pkey_win::resolve(m, "vpkc_wait_exit_then_apply_updates", api.apply) &&
                pkey_win::resolve(m, "vpkc_free_update_info", api.free_info) &&
                pkey_win::resolve(m, "vpkc_get_last_error", api.last_error);
      if (!ok) {
        FreeLibrary(m);
        d["ok"] = false;
        d["error"] = "dependency";
        d["message"] = "velopack_libc.dll lacks a vpkc_* function this plugin needs";
        return d;
      }
      g_api = api;
    }
    d["ok"] = true;
    return d;
  }

  Dictionary open(const String &url, const Dictionary &headers) {
    Dictionary d;
    if (!g_api.module) {
      d["ok"] = false;
      d["error"] = "dependency";
      return d;
    }
    if (busy_) {
      d["ok"] = false;
      d["error"] = "busy";
      return d;
    }
    join();
    if (info_) g_api.free_info(info_), info_ = nullptr;
    if (mgr_) g_api.free_manager(mgr_), mgr_ = nullptr;
    if (source_) g_api.free_source(source_), source_ = nullptr;
    downloaded_ = false;

    header_text_.clear();
    header_rows_.clear();
    header_ptrs_.clear();
    Array keys = headers.keys();
    header_text_.reserve(keys.size() * 2);
    for (int64_t i = 0; i < keys.size(); i++) {
      header_text_.push_back(std::string(String(keys[i]).utf8().get_data()));
      header_text_.push_back(std::string(String(headers[keys[i]]).utf8().get_data()));
    }
    header_rows_.resize(keys.size());
    for (int64_t i = 0; i < keys.size(); i++) {
      header_rows_[i].Name = header_text_[i * 2].data();
      header_rows_[i].Value = header_text_[i * 2 + 1].data();
      header_ptrs_.push_back(&header_rows_[i]);
    }
    vpkc_http_options_t http{};
    http.Headers = header_ptrs_.empty() ? nullptr : header_ptrs_.data();
    http.HeadersCount = header_ptrs_.size();
    http.TimeoutMilliseconds = 0;
    source_ = g_api.new_source(url.utf8().get_data(), &http);
    if (!source_) {
      d["ok"] = false;
      d["error"] = "bad_source";
      d["message"] = last_error();
      return d;
    }
    vpkc_update_options_t opts{};
    opts.AllowVersionDowngrade = false;
    opts.ExplicitChannel = nullptr;
    opts.MaximumDeltasBeforeFallback = 10;
    if (!g_api.new_manager(source_, &opts, nullptr, &mgr_)) {
      String msg = last_error();
      mgr_ = nullptr;
      d["ok"] = false;
      // "This application is not properly installed: Could not auto-locate app manifest"
      d["error"] = msg.to_lower().contains("installed") ? "not_installed" : "bad_source";
      d["message"] = msg;
      return d;
    }
    char ver[256] = {0};
    g_api.current_version(mgr_, ver, sizeof(ver));
    char app[256] = {0};
    g_api.app_id(mgr_, app, sizeof(app));
    d["ok"] = true;
    d["current_version"] = String::utf8(ver);
    d["app_id"] = String::utf8(app);
    d["portable"] = g_api.is_portable(mgr_);
    return d;
  }

  int64_t check_async() {
    if (!mgr_ || busy_.exchange(true)) return -1;
    join();
    int64_t request = ++next_request_;
    uint64_t owner = get_instance_id();
    if (info_) g_api.free_info(info_), info_ = nullptr;
    downloaded_ = false;
    worker_ = std::thread([this, owner, request]() {
      vpkc_update_info_t *info = nullptr;
      vpkc_update_check_t r = g_api.check(mgr_, &info);
      Dictionary d;
      d["request"] = request;
      switch (r) {
        case UPDATE_AVAILABLE: {
          d["status"] = "available";
          d["target"] = asset_dict(info->TargetFullRelease);
          d["base"] = asset_dict(info->BaseRelease);
          Array deltas;
          for (size_t i = 0; i < info->DeltasToTargetCount; i++) deltas.push_back(asset_dict(info->DeltasToTarget[i]));
          d["deltas"] = deltas;
          d["is_downgrade"] = info->IsDowngrade;
          info_ = info;
          break;
        }
        case NO_UPDATE_AVAILABLE:
          d["status"] = "none";
          break;
        case REMOTE_IS_EMPTY:
          d["status"] = "remote_empty";
          break;
        default:
          d["status"] = "error";
          d["message"] = last_error();
          break;
      }
      busy_ = false;
      pkey_win::emit(owner, "checked", d);
    });
    return request;
  }

  int64_t download_async() {
    if (!mgr_ || !info_ || busy_.exchange(true)) return -1;
    join();
    int64_t request = ++next_request_;
    uint64_t owner = get_instance_id();
    worker_ = std::thread([this, owner, request]() {
      auto progress = std::make_unique<Progress>(Progress{owner, request, -5});
      bool ok = g_api.download(mgr_, info_, &PKeyVelopackNative::on_progress, progress.get());
      Dictionary d;
      d["request"] = request;
      d["ok"] = ok;
      if (!ok) d["message"] = last_error();
      downloaded_ = ok;
      busy_ = false;
      pkey_win::emit(owner, ok ? "downloaded" : "download_failed", d);
    });
    return request;
  }

  Dictionary apply_on_exit(bool /* restart */) {
    // Even direct GDExtension callers cannot install feed-authorized executable bytes.
    // Restore apply only with verification of the exact package against a pinned-key record.
    Dictionary d;
    d["ok"] = false;
    d["error"] = "release_verification_unavailable";
    d["message"] = "Velopack installation requires pinned-key-signed release-record package verification.";
    return d;
  }

  bool is_busy() const { return busy_; }
};

void pkey_win::register_velopack() { GDREGISTER_CLASS(PKeyVelopackNative); }
