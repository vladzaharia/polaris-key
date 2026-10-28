// PKeyWinCredentialNative (SP-27): Windows Credential Manager for the desktop keyring store
// (addons/polaris_key/core/store/keyring_windows.gd, PKeyWinCredBackend). Three synchronous calls
// over CredReadW / CredWriteW / CredDeleteW on CRED_TYPE_GENERIC credentials:
//
//   read(target)                 {ok, found: false} | {ok, found: true, user, value}
//   write(target, user, secret)  {ok}
//   remove(target)               {ok} (a missing credential is success)
//
// and {ok: false, error, win32} on any other failure (the Win32 error from GetLastError).
//
// The layout is python-keyring's WinVaultKeyring (the reference the Kotlin store also follows,
// UK-40): TargetName is the service (`pkey:<product>`), UserName the account (`device-token`), and
// the blob is the secret in UTF-16LE. The GDScript side applies keyring's `<user>@<service>`
// compound-target rule. One difference: Persist is CRED_PERSIST_LOCAL_MACHINE, not ENTERPRISE, so
// the token never roams with a roaming profile (it is bound to this device's id).
//
// Credential Manager is part of Windows (advapi32), so this class always loads and needs nothing
// beside pkey_win.dll.
//
// PKeyWinDpapiNative (CC-26.7) is the sealer behind the Godot device key store
// (addons/polaris_key/core/store/sealer_windows.gd): DPAPI wraps and unwraps the record's bytes.
//
//   protect(data, entropy)    {ok, blob} | {ok: false, error, win32}
//   unprotect(blob, entropy)  {ok, plain} | {ok: false, error, win32, unopenable}
//
// CryptProtectData with CRYPTPROTECT_UI_FORBIDDEN and no CRYPTPROTECT_LOCAL_MACHINE: the blob opens
// only for this Windows user on this machine, with no prompt. The entropy is the caller's context
// (the product slug), so a blob of one product does not open as another's. `unopenable` is set only
// for an error that cannot pass (the blob is not DPAPI data, or another user or machine made it);
// every other failure is a fault the store reports as such, never as "the keys are gone". DPAPI
// keeps no per-product key, so there is nothing to delete: the store removes its record. Plain
// buffers are zeroed after use.
#include "pkey_win_common.h"

#include <dpapi.h>
#include <wincred.h>

#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/class_db.hpp>

#include <cstring>
#include <vector>

using namespace godot;

namespace {

Dictionary failure(const char *what, DWORD err) {
  Dictionary d;
  d["ok"] = false;
  d["error"] = String(what) + " failed (Win32 error " + String::num_int64((int64_t)err) + ")";
  d["win32"] = (int64_t)err;
  return d;
}

Dictionary success() {
  Dictionary d;
  d["ok"] = true;
  return d;
}

}  // namespace

class PKeyWinCredentialNative : public RefCounted {
  GDCLASS(PKeyWinCredentialNative, RefCounted)

 protected:
  static void _bind_methods() {
    ClassDB::bind_method(D_METHOD("read", "target"), &PKeyWinCredentialNative::read);
    ClassDB::bind_method(D_METHOD("write", "target", "user", "secret"), &PKeyWinCredentialNative::write);
    ClassDB::bind_method(D_METHOD("remove", "target"), &PKeyWinCredentialNative::remove);
  }

 public:
  Dictionary read(const String &target) {
    std::wstring t = pkey_win::wide(target);
    PCREDENTIALW cred = nullptr;
    if (!CredReadW(t.c_str(), CRED_TYPE_GENERIC, 0, &cred)) {
      DWORD err = GetLastError();
      if (err == ERROR_NOT_FOUND) {
        Dictionary d = success();
        d["found"] = false;
        return d;
      }
      return failure("CredReadW", err);
    }
    Dictionary d = success();
    d["found"] = true;
    d["user"] = pkey_win::from_wide(cred->UserName);
    // The blob is UTF-16LE without a terminator; an odd size is not a string this store wrote.
    DWORD size = cred->CredentialBlobSize;
    if (size % 2 != 0) {
      CredFree(cred);
      return failure("CredReadW (the credential blob is not UTF-16)", ERROR_INVALID_DATA);
    }
    std::vector<char16_t> buf(size / 2 + 1, 0);
    if (size > 0) memcpy(buf.data(), cred->CredentialBlob, size);
    d["value"] = String(buf.data());
    SecureZeroMemory(cred->CredentialBlob, size);
    CredFree(cred);
    return d;
  }

  Dictionary write(const String &target, const String &user, const String &secret) {
    std::wstring t = pkey_win::wide(target);
    std::wstring u = pkey_win::wide(user);
    std::wstring s = pkey_win::wide(secret);
    CREDENTIALW cred = {};
    cred.Type = CRED_TYPE_GENERIC;
    cred.TargetName = const_cast<LPWSTR>(t.c_str());
    cred.UserName = const_cast<LPWSTR>(u.c_str());
    cred.CredentialBlobSize = (DWORD)(s.size() * sizeof(wchar_t));
    cred.CredentialBlob = reinterpret_cast<LPBYTE>(const_cast<wchar_t *>(s.data()));
    cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
    BOOL ok = CredWriteW(&cred, 0);
    DWORD err = ok ? 0 : GetLastError();
    SecureZeroMemory(s.data(), s.size() * sizeof(wchar_t));
    if (!ok) return failure("CredWriteW", err);
    return success();
  }

  Dictionary remove(const String &target) {
    std::wstring t = pkey_win::wide(target);
    if (!CredDeleteW(t.c_str(), CRED_TYPE_GENERIC, 0)) {
      DWORD err = GetLastError();
      if (err == ERROR_NOT_FOUND) return success();
      return failure("CredDeleteW", err);
    }
    return success();
  }
};

class PKeyWinDpapiNative : public RefCounted {
  GDCLASS(PKeyWinDpapiNative, RefCounted)

 protected:
  static void _bind_methods() {
    ClassDB::bind_method(D_METHOD("protect", "data", "entropy"), &PKeyWinDpapiNative::protect);
    ClassDB::bind_method(D_METHOD("unprotect", "blob", "entropy"), &PKeyWinDpapiNative::unprotect);
  }

  static Dictionary fault(const char *what, DWORD err, bool unopenable) {
    Dictionary d = failure(what, err);
    d["unopenable"] = unopenable;
    return d;
  }

  static DATA_BLOB view(const PackedByteArray &b) {
    DATA_BLOB v;
    v.cbData = (DWORD)b.size();
    v.pbData = const_cast<BYTE *>(b.ptr());
    return v;
  }

  static PackedByteArray take(DATA_BLOB &out, bool zero) {
    PackedByteArray r;
    r.resize((int64_t)out.cbData);
    if (out.cbData > 0) memcpy(r.ptrw(), out.pbData, out.cbData);
    if (zero && out.cbData > 0) SecureZeroMemory(out.pbData, out.cbData);
    LocalFree(out.pbData);
    return r;
  }

 public:
  Dictionary protect(const PackedByteArray &data, const PackedByteArray &entropy) {
    DATA_BLOB in = view(data), ent = view(entropy), out = {};
    if (!CryptProtectData(&in, L"pkey", &ent, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) {
      return fault("CryptProtectData", GetLastError(), false);
    }
    Dictionary d = success();
    d["blob"] = take(out, false);
    return d;
  }

  Dictionary unprotect(const PackedByteArray &blob, const PackedByteArray &entropy) {
    DATA_BLOB in = view(blob), ent = view(entropy), out = {};
    if (!CryptUnprotectData(&in, nullptr, &ent, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) {
      DWORD err = GetLastError();
      // Only an error that can never pass is "unopenable". NTE_BAD_KEY_STATE is deliberately NOT one:
      // it can mean the user profile or master key is not loaded yet, a transient condition that must
      // never read as "the keys are gone".
      bool never = err == ERROR_INVALID_DATA || err == (DWORD)NTE_BAD_DATA;
      return fault("CryptUnprotectData", err, never);
    }
    Dictionary d = success();
    d["plain"] = take(out, true);
    return d;
  }
};

void pkey_win::register_credman() {
  GDREGISTER_CLASS(PKeyWinCredentialNative);
  GDREGISTER_CLASS(PKeyWinDpapiNative);
}
