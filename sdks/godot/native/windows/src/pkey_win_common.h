// Shared helpers for the Windows GDExtension (P5-07): one DLL, pkey_win.dll, holding
// PKeyVelopackNative, PKeyWinSparkleNative and PKeyStoreContextNative (notes/S-11 §4.5, §8), and
// PKeyWinCredentialNative (SP-27, the desktop keyring store's Credential Manager calls).
//
// Every callback reaches GDScript as `native_event(event, detail)` on the main thread through
// call_deferred: WinSparkle and Velopack call back on their own threads, StoreContext's blocking
// calls run on an MTA worker thread.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <godot_cpp/core/object.hpp>
#include <godot_cpp/variant/dictionary.hpp>
#include <godot_cpp/variant/string.hpp>

#include <cstdint>
#include <cstdio>
#include <string>

namespace pkey_win {

// Emit `native_event(event, detail)` on the object `owner`, deferred to the main loop. Safe from
// any thread (Godot's message queue is), and a no-op once the object is gone.
inline void emit(uint64_t owner, const char *event, const godot::Dictionary &detail) {
  godot::Object *o = godot::ObjectDB::get_instance(godot::ObjectID(owner));
  if (o) o->call_deferred("emit_signal", "native_event", godot::String(event), detail);
}

inline std::wstring wide(const godot::String &s) { return std::wstring((const wchar_t *)s.utf16().get_data()); }

inline godot::String from_wide(const wchar_t *s) { return s ? godot::String((const char16_t *)s) : godot::String(); }

inline godot::String hresult_hex(int32_t hr) {
  char b[16];
  snprintf(b, sizeof(b), "0x%08X", (uint32_t)hr);
  return godot::String(b);
}

// Load the DLL at the ABSOLUTE `path` (beside the executable): the module, or nullptr with the
// Win32 error in `win32`. A relative path is refused (ERROR_BAD_PATHNAME) rather than searched
// for. LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32 resolves the DLL's own
// dependencies from its folder and System32 only: never the current directory or PATH.
inline HMODULE load_beside(const godot::String &path, int64_t &win32) {
  if (!path.is_absolute_path() || path.begins_with("res://") || path.begins_with("user://")) {
    win32 = ERROR_BAD_PATHNAME;
    return nullptr;
  }
  std::wstring w = wide(path);
  for (auto &c : w)
    if (c == L'/') c = L'\\';
  HMODULE m = LoadLibraryExW(w.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
  win32 = m ? 0 : (int64_t)GetLastError();
  return m;
}

// Resolve `name` from `module` into `fn` (typed by decltype of the header's declaration).
template <typename F>
inline bool resolve(HMODULE module, const char *name, F &fn) {
  fn = reinterpret_cast<F>(GetProcAddress(module, name));
  return fn != nullptr;
}

void register_velopack();
void register_winsparkle();
void register_storecontext();
void register_credman();
void winsparkle_shutdown();

}  // namespace pkey_win
