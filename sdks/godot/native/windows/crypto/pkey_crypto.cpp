// PKeyWinCryptoNative (CC-14b.6): the Windows lane of the Cloud Connect crypto port (D-3). The
// GDScript adapter is addons/polaris_key/native/pkey_win_crypto.gd (PKeyWinCrypto); the lane
// selector takes it only after its own known-answer self-test.
//
//   aes_gcm_seal(key, nonce, aad, plain)     status byte, then ciphertext and the 16-byte tag
//   aes_gcm_open(key, nonce, aad, sealed)    status byte, then the plaintext
//   x25519_public(private_key)               status byte, then the 32-byte public key
//   x25519(private_key, peer_public)         status byte, then the 32-byte shared secret
//
// AES-256-GCM on CNG (BCrypt, BCRYPT_CHAIN_MODE_GCM): a 32-byte key, a 12-byte nonce and a 16-byte
// tag. Every method answers a PackedByteArray whose first byte is the status:
//
//   1 ok   0 refused (the tag does not verify; no plaintext is returned)   2 unsupported (the
//   provider or the GCM mode is not there)   3 bad input (a length is wrong, or the message is
//   larger than one Noise message)
//
// X25519 (CC-14b.7) is Monocypher 4.0.3's crypto_x25519_public_key and crypto_x25519 (RFC 7748,
// constant time, the scalar clamped inside; nothing else of Monocypher is called). CNG has no
// X25519 on every supported Windows. A shared secret that is all zero (a low-order peer key, in any
// spelling) is refused: status 0, no bytes (`dh_zero`). The private key is read in place and the
// local copies of results are wiped.
//
// Every BCrypt handle, and the key object the provider keeps the key schedule in, is released on
// every path (the guard below), the key object is zeroed first, and a failed open zeroes the
// buffer it decrypted into. Nothing here logs, prints or keeps a key or a plaintext. A
// PackedByteArray copy made by the engine is outside this file's reach (a recorded residual).
#include "pkey_win_common.h"

#include <bcrypt.h>

#include "monocypher.h"

#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/packed_byte_array.hpp>

#include <cstring>
#include <vector>

using namespace godot;

namespace {

constexpr uint8_t kRefused = 0;
constexpr uint8_t kOk = 1;
constexpr uint8_t kUnsupported = 2;
constexpr uint8_t kBadInput = 3;

constexpr int64_t kKeyBytes = 32;
constexpr int64_t kNonceBytes = 12;
constexpr int64_t kTagBytes = 16;
constexpr int64_t kCurveBytes = 32;
// One Noise message is at most 65,535 bytes, so one AEAD call carries at most that, tag included.
constexpr int64_t kMaxAead = 65535;

PackedByteArray status_only(uint8_t status) {
  PackedByteArray r;
  r.resize(1);
  r.ptrw()[0] = status;
  return r;
}

PackedByteArray ok_with(const uint8_t *bytes, int64_t n) {
  PackedByteArray r;
  r.resize(1 + n);
  uint8_t *w = r.ptrw();
  w[0] = kOk;
  memcpy(w + 1, bytes, (size_t)n);
  return r;
}

// An AES-256 key in a GCM-mode provider. The destructor destroys the key, zeroes the key object
// the provider wrote the key schedule into, then closes the provider: every path out of a call
// runs it.
class GcmKey {
 public:
  GcmKey() = default;
  GcmKey(const GcmKey &) = delete;
  GcmKey &operator=(const GcmKey &) = delete;
  ~GcmKey() {
    if (key_) BCryptDestroyKey(key_);
    if (!object_.empty()) SecureZeroMemory(object_.data(), object_.size());
    if (alg_) BCryptCloseAlgorithmProvider(alg_, 0);
  }

  // Zero when the key is ready, else the status byte to answer.
  uint8_t init(const uint8_t *secret, ULONG secret_len) {
    if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&alg_, BCRYPT_AES_ALGORITHM, nullptr, 0))) {
      alg_ = nullptr;
      return kUnsupported;
    }
    if (!BCRYPT_SUCCESS(BCryptSetProperty(alg_, BCRYPT_CHAINING_MODE, (PUCHAR)BCRYPT_CHAIN_MODE_GCM, sizeof(BCRYPT_CHAIN_MODE_GCM), 0))) {
      return kUnsupported;
    }
    DWORD object_len = 0, got = 0;
    if (!BCRYPT_SUCCESS(BCryptGetProperty(alg_, BCRYPT_OBJECT_LENGTH, (PUCHAR)&object_len, sizeof(object_len), &got, 0)) || object_len == 0) {
      return kUnsupported;
    }
    object_.assign(object_len, 0);
    if (!BCRYPT_SUCCESS(BCryptGenerateSymmetricKey(alg_, &key_, object_.data(), object_len, const_cast<PUCHAR>(secret), secret_len, 0))) {
      key_ = nullptr;
      return kRefused;
    }
    return 0;
  }

  BCRYPT_KEY_HANDLE handle() const { return key_; }

 private:
  BCRYPT_ALG_HANDLE alg_ = nullptr;
  BCRYPT_KEY_HANDLE key_ = nullptr;
  std::vector<UCHAR> object_;
};

// CNG rejects a null buffer even for a zero length, so an empty message points at this byte.
UCHAR g_empty = 0;

PUCHAR or_empty(const uint8_t *p, int64_t n) { return n > 0 ? const_cast<PUCHAR>(p) : &g_empty; }

}  // namespace

class PKeyWinCryptoNative : public RefCounted {
  GDCLASS(PKeyWinCryptoNative, RefCounted)

 protected:
  static void _bind_methods() {
    ClassDB::bind_method(D_METHOD("aes_gcm_seal", "key", "nonce", "aad", "plain"), &PKeyWinCryptoNative::aes_gcm_seal);
    ClassDB::bind_method(D_METHOD("aes_gcm_open", "key", "nonce", "aad", "sealed"), &PKeyWinCryptoNative::aes_gcm_open);
    ClassDB::bind_method(D_METHOD("x25519_public", "private_key"), &PKeyWinCryptoNative::x25519_public);
    ClassDB::bind_method(D_METHOD("x25519", "private_key", "peer_public"), &PKeyWinCryptoNative::x25519);
  }

 public:
  PackedByteArray aes_gcm_seal(const PackedByteArray &key, const PackedByteArray &nonce, const PackedByteArray &aad, const PackedByteArray &plain) {
    if (key.size() != kKeyBytes || nonce.size() != kNonceBytes || plain.size() + kTagBytes > kMaxAead || aad.size() > kMaxAead) {
      return status_only(kBadInput);
    }
    GcmKey k;
    if (uint8_t s = k.init(key.ptr(), (ULONG)kKeyBytes)) return status_only(s);

    const int64_t n = plain.size();
    PackedByteArray out;
    out.resize(1 + n + kTagBytes);
    uint8_t *body = out.ptrw();
    body[0] = kOk;
    uint8_t *ct = body + 1;
    uint8_t *tag = ct + n;

    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info;
    BCRYPT_INIT_AUTH_MODE_INFO(info);
    info.pbNonce = const_cast<PUCHAR>(nonce.ptr());
    info.cbNonce = (ULONG)kNonceBytes;
    info.pbAuthData = aad.size() > 0 ? const_cast<PUCHAR>(aad.ptr()) : nullptr;
    info.cbAuthData = (ULONG)aad.size();
    info.pbTag = tag;
    info.cbTag = (ULONG)kTagBytes;

    ULONG written = 0;
    NTSTATUS st = BCryptEncrypt(k.handle(), or_empty(plain.ptr(), n), (ULONG)n, &info, nullptr, 0, n > 0 ? ct : &g_empty, (ULONG)n, &written, 0);
    if (!BCRYPT_SUCCESS(st) || written != (ULONG)n) return status_only(kRefused);
    return out;
  }

  PackedByteArray aes_gcm_open(const PackedByteArray &key, const PackedByteArray &nonce, const PackedByteArray &aad, const PackedByteArray &sealed) {
    if (key.size() != kKeyBytes || nonce.size() != kNonceBytes || sealed.size() < kTagBytes || sealed.size() > kMaxAead || aad.size() > kMaxAead) {
      return status_only(kBadInput);
    }
    GcmKey k;
    if (uint8_t s = k.init(key.ptr(), (ULONG)kKeyBytes)) return status_only(s);

    const int64_t n = sealed.size() - kTagBytes;
    // The tag is copied: CNG wants a writable tag pointer in the mode info.
    uint8_t tag[kTagBytes];
    memcpy(tag, sealed.ptr() + n, kTagBytes);

    PackedByteArray out;
    out.resize(1 + n);
    uint8_t *body = out.ptrw();
    body[0] = kOk;
    uint8_t *plain = body + 1;

    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info;
    BCRYPT_INIT_AUTH_MODE_INFO(info);
    info.pbNonce = const_cast<PUCHAR>(nonce.ptr());
    info.cbNonce = (ULONG)kNonceBytes;
    info.pbAuthData = aad.size() > 0 ? const_cast<PUCHAR>(aad.ptr()) : nullptr;
    info.cbAuthData = (ULONG)aad.size();
    info.pbTag = tag;
    info.cbTag = (ULONG)kTagBytes;

    ULONG written = 0;
    NTSTATUS st = BCryptDecrypt(k.handle(), or_empty(sealed.ptr(), n), (ULONG)n, &info, nullptr, 0, n > 0 ? plain : &g_empty, (ULONG)n, &written, 0);
    SecureZeroMemory(tag, sizeof(tag));
    if (!BCRYPT_SUCCESS(st) || written != (ULONG)n) {
      // A tag that does not verify (STATUS_AUTH_TAG_MISMATCH) or any other failure returns no
      // plaintext: whatever was decrypted into the buffer is erased, and the reply is the status
      // byte alone.
      if (n > 0) SecureZeroMemory(plain, (SIZE_T)n);
      return status_only(kRefused);
    }
    return out;
  }

  PackedByteArray x25519_public(const PackedByteArray &private_key) {
    if (private_key.size() != kCurveBytes) return status_only(kBadInput);
    uint8_t pub[kCurveBytes];
    crypto_x25519_public_key(pub, private_key.ptr());
    PackedByteArray out = ok_with(pub, kCurveBytes);
    SecureZeroMemory(pub, sizeof(pub));
    return out;
  }

  PackedByteArray x25519(const PackedByteArray &private_key, const PackedByteArray &peer_public) {
    if (private_key.size() != kCurveBytes || peer_public.size() != kCurveBytes) return status_only(kBadInput);
    uint8_t shared[kCurveBytes];
    crypto_x25519(shared, private_key.ptr(), peer_public.ptr());
    // Constant-time test for an all-zero output: the peer key was of small order (RFC 7748 6.1).
    uint8_t any = 0;
    for (int64_t i = 0; i < kCurveBytes; i++) any |= shared[i];
    PackedByteArray out = any == 0 ? status_only(kRefused) : ok_with(shared, kCurveBytes);
    SecureZeroMemory(shared, sizeof(shared));
    return out;
  }
};

void pkey_win::register_crypto() { GDREGISTER_CLASS(PKeyWinCryptoNative); }
