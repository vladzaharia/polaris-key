// PKeyStoreContextNative: Microsoft Store package updates from a Godot MSIX build (P5-07;
// notes/S-11 §4.4, §8 step 5; notes/E3 §A1.3). The GDScript facade is
// addons/polaris_key/native/pkey_storecontext.gd.
//
// This translation unit alone is compiled as C++20: C++/WinRT under C++17 includes
// <experimental/coroutine>, which the VS 2026 STL rejects (STL1011). godot-cpp stays at C++17.
//
//   package_identity()          GetCurrentPackageFullName: {packaged, full_name, rc}; rc 15700
//                               (APPMODEL_ERROR_NO_PACKAGE) means unpackaged
//   request_async(op, hwnd, s)  on an MTA worker thread (a blocking .get() is not allowed on the
//                               STA main thread): StoreContext::GetDefault(), then
//                               IInitializeWithWindow::Initialize(hwnd) so any dialog is owned by
//                               the game window, then the operation:
//                                 "updates"                GetAppAndOptionalStorePackageUpdatesAsync
//                                 "can_silently_download"  CanSilentlyDownloadStorePackageUpdates
//                                 "download_and_install"   RequestDownloadAndInstallStore…Async
//                                                          (consent dialog), or with `silent`
//                                                          TrySilentDownloadAndInstallStore…Async
//                               -> "store_progress" events, then one "store_result"
//                               {request, op, ok, hresult?, message?, …}
//
// An HRESULT is reported as is; the facade maps 0x803F6101, 0x803F6107 and 0x80070002 to "not a
// Store install". Real update results need a Store-associated package (notes/S-11 §7 row 6).

#include "../src/pkey_win_common.h"

#include <appmodel.h>
#include <shobjidl_core.h>
#include <unknwn.h>
#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Services.Store.h>

#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/array.hpp>

#include <atomic>
#include <mutex>
#include <thread>
#include <vector>

using namespace godot;

namespace {

String state_name(winrt::Windows::Services::Store::StorePackageUpdateState s) {
  using winrt::Windows::Services::Store::StorePackageUpdateState;
  switch (s) {
    case StorePackageUpdateState::Pending: return "pending";
    case StorePackageUpdateState::Downloading: return "downloading";
    case StorePackageUpdateState::Deploying: return "deploying";
    case StorePackageUpdateState::Completed: return "completed";
    case StorePackageUpdateState::Canceled: return "canceled";
    case StorePackageUpdateState::OtherError: return "other_error";
    case StorePackageUpdateState::ErrorLowBattery: return "error_low_battery";
    case StorePackageUpdateState::ErrorWiFiRecommended: return "error_wifi_recommended";
    case StorePackageUpdateState::ErrorWiFiRequired: return "error_wifi_required";
  }
  return "unknown";
}

String overall_name(winrt::Windows::Services::Store::StorePackageUpdateState s) { return state_name(s); }

}  // namespace

class PKeyStoreContextNative : public RefCounted {
  GDCLASS(PKeyStoreContextNative, RefCounted)

  std::vector<std::thread> workers_;
  std::mutex lock_;
  std::atomic<int64_t> next_request_{0};

 protected:
  static void _bind_methods() {
    ClassDB::bind_method(D_METHOD("package_identity"), &PKeyStoreContextNative::package_identity);
    ClassDB::bind_method(D_METHOD("request_async", "op", "hwnd", "silent"), &PKeyStoreContextNative::request_async);
    ADD_SIGNAL(MethodInfo("native_event", PropertyInfo(Variant::STRING, "event"), PropertyInfo(Variant::DICTIONARY, "detail")));
  }

 public:
  ~PKeyStoreContextNative() {
    std::lock_guard<std::mutex> g(lock_);
    for (auto &t : workers_)
      if (t.joinable()) t.join();
  }

  Dictionary package_identity() {
    Dictionary d;
    UINT32 len = 0;
    LONG rc = GetCurrentPackageFullName(&len, nullptr);
    if (rc == ERROR_INSUFFICIENT_BUFFER) {
      std::wstring name(len, L'\0');
      rc = GetCurrentPackageFullName(&len, name.data());
      if (rc == ERROR_SUCCESS) d["full_name"] = pkey_win::from_wide(name.c_str());
    }
    d["rc"] = (int64_t)rc;
    d["packaged"] = rc == ERROR_SUCCESS;
    return d;
  }

  int64_t request_async(const String &op, int64_t hwnd, bool silent) {
    if (op != "updates" && op != "can_silently_download" && op != "download_and_install") return -1;
    int64_t request = ++next_request_;
    uint64_t owner = get_instance_id();
    std::string op_s(op.utf8().get_data());
    std::lock_guard<std::mutex> g(lock_);
    workers_.emplace_back([owner, request, op_s, hwnd, silent]() {
      using namespace winrt;
      using namespace winrt::Windows::Services::Store;
      Dictionary d;
      d["request"] = request;
      d["op"] = String(op_s.c_str());
      try {
        init_apartment(apartment_type::multi_threaded);
      } catch (...) {
        // already initialised on this thread: keep going
      }
      try {
        StoreContext ctx = StoreContext::GetDefault();
        if (hwnd != 0) {
          auto iww = ctx.as<::IInitializeWithWindow>();
          check_hresult(iww->Initialize(reinterpret_cast<HWND>(static_cast<intptr_t>(hwnd))));
        }
        if (op_s == "can_silently_download") {
          d["can_silently"] = ctx.CanSilentlyDownloadStorePackageUpdates();
          d["ok"] = true;
        } else {
          auto updates = ctx.GetAppAndOptionalStorePackageUpdatesAsync().get();
          Array list;
          bool mandatory = false;
          for (auto const &u : updates) {
            Dictionary row;
            auto id = u.Package().Id();
            auto v = id.Version();
            row["package"] = pkey_win::from_wide(id.FullName().c_str());
            char ver[64];
            snprintf(ver, sizeof(ver), "%u.%u.%u.%u", (unsigned)v.Major, (unsigned)v.Minor, (unsigned)v.Build, (unsigned)v.Revision);
            row["version"] = String(ver);
            row["mandatory"] = u.Mandatory();
            mandatory = mandatory || u.Mandatory();
            list.push_back(row);
          }
          d["updates"] = list;
          d["count"] = (int64_t)updates.Size();
          d["mandatory"] = mandatory;
          if (op_s == "updates") {
            d["ok"] = true;
          } else if (updates.Size() == 0) {
            d["ok"] = true;
            d["state"] = "none";
          } else if (silent && !ctx.CanSilentlyDownloadStorePackageUpdates()) {
            d["ok"] = false;
            d["state"] = "silent_unavailable";
            d["message"] = "CanSilentlyDownloadStorePackageUpdates is false (automatic updates off or a metered network)";
          } else {
            auto async = silent ? ctx.TrySilentDownloadAndInstallStorePackageUpdatesAsync(updates)
                                : ctx.RequestDownloadAndInstallStorePackageUpdatesAsync(updates);
            async.Progress([owner, request](auto const &, StorePackageUpdateStatus const &s) {
              Dictionary p;
              p["request"] = request;
              p["package"] = pkey_win::from_wide(s.PackageFamilyName.c_str());
              p["progress"] = s.PackageDownloadProgress;
              p["state"] = state_name(s.PackageUpdateState);
              pkey_win::emit(owner, "store_progress", p);
            });
            auto result = async.get();
            d["state"] = overall_name(result.OverallState());
            d["ok"] = result.OverallState() == StorePackageUpdateState::Completed;
          }
        }
      } catch (hresult_error const &e) {
        d["ok"] = false;
        d["hresult"] = pkey_win::hresult_hex(e.code());
        d["message"] = pkey_win::from_wide(e.message().c_str());
      } catch (...) {
        d["ok"] = false;
        d["message"] = "unknown exception";
      }
      pkey_win::emit(owner, "store_result", d);
    });
    return request;
  }
};

void pkey_win::register_storecontext() { GDREGISTER_CLASS(PKeyStoreContextNative); }
