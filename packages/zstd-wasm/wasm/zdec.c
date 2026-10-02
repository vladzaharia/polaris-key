// @polaris-key/zstd-wasm: decoder-only libzstd 1.5.7 for wasm32, no libc (A7 §9.5;
// plans/P4-01.md §2.13). Exactly one zstd frame with its content size, optionally decoded with
// a raw-content prefix (`zstd --patch-from`).
//
// Every decode is refused BEFORE it starts when the frame header does not parse, the input is
// not exactly one frame, the declared content size is not the caller's `size`, or (with a
// prefix) the header window is above 2^windowLogMax (plans/P4-01.md §2.7 rule 3). libzstd
// enforces ZSTD_d_windowLogMax only on its buffered streaming path, never in the one-shot
// ZSTD_decompressDCtx used here, so the check is this file's.
//
// Memory: a bump allocator that never frees. Each call is meant to run in a fresh instance
// (the JS entries instantiate per call), so a decode's linear memory dies with it.
#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"
#include <stdlib.h>
#include <string.h>

extern unsigned char __heap_base;
static unsigned long top = 0;
static unsigned long cap_bytes(void) { return (unsigned long)__builtin_wasm_memory_size(0) * 65536ul; }
void *malloc(size_t n) {
  if (!top) top = (unsigned long)&__heap_base;
  unsigned long p = (top + 15) & ~15ul, end = p + n;
  if (end < p) return 0;
  if (end > cap_bytes()) {
    unsigned long need = (end - cap_bytes() + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, need) == (unsigned long)-1) return 0;
  }
  top = end;
  return (void *)p;
}
void *calloc(size_t n, size_t s) {
  if (s && n > (size_t)-1 / s) return 0;
  void *p = malloc(n * s);
  if (p) memset(p, 0, n * s);
  return p;
}
void free(void *p) { (void)p; }
void *memcpy(void *d, const void *s, size_t n) { __builtin_memcpy(d, s, n); return d; }
void *memmove(void *d, const void *s, size_t n) { __builtin_memmove(d, s, n); return d; }
void *memset(void *p, int v, size_t n) { __builtin_memset(p, v, n); return p; }
int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *x = a, *y = b;
  for (size_t i = 0; i < n; i++) if (x[i] != y[i]) return x[i] - y[i];
  return 0;
}
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }

/* Refusals, all negative. A libzstd decode error is -(1000 + its ZSTD_ErrorCode). */
#define ZD_HEADER -1      /* the frame header does not parse, or a skippable frame */
#define ZD_NOT_ONE -2     /* the input is not exactly one frame */
#define ZD_SIZE -3        /* the content size is absent or not the caller's size */
#define ZD_WINDOW -4      /* the header window is above 2^windowLogMax */
#define ZD_MEMORY -5      /* no context could be allocated */
#define ZD_LENGTH -6      /* the decode produced another length */
#define ZD_ARG -7         /* windowLogMax outside 10..31 */

__attribute__((export_name("zd_alloc"))) void *zd_alloc(size_t n) { return malloc(n); }

/* Header checks shared by both decodes; the window check runs whenever a prefix is given. */
static long long check(const void *src, size_t n, unsigned long long size, int windowed, unsigned wlm) {
  ZSTD_frameHeader h;
  if (ZSTD_getFrameHeader(&h, src, n) != 0) return ZD_HEADER;
  if (h.frameType != ZSTD_frame) return ZD_HEADER;
  if (ZSTD_findFrameCompressedSize(src, n) != n) return ZD_NOT_ONE;
  if (h.frameContentSize == ZSTD_CONTENTSIZE_UNKNOWN || h.frameContentSize != size) return ZD_SIZE;
  if (windowed) {
    if (wlm < 10 || wlm > 31) return ZD_ARG;
    if (h.windowSize > (1ull << wlm)) return ZD_WINDOW;
  }
  return 0;
}

/* Decode one frame into dst (exactly `size` bytes), with an optional raw-content prefix.
 * Returns `size` or a refusal. */
__attribute__((export_name("zd_decode"))) long long zd_decode(void *dst, size_t size, const void *src, size_t n,
                                                              const void *prefix, size_t pn, unsigned wlm) {
  long long c = check(src, n, size, prefix != 0, wlm);
  if (c) return c;
  ZSTD_DCtx *d = ZSTD_createDCtx();
  if (!d) return ZD_MEMORY;
  if (prefix) {
    size_t e = ZSTD_DCtx_refPrefix(d, prefix, pn);
    if (ZSTD_isError(e)) return -1000 - (long long)ZSTD_getErrorCode(e);
  }
  size_t r = ZSTD_decompressDCtx(d, dst, size, src, n);
  if (ZSTD_isError(r)) return -1000 - (long long)ZSTD_getErrorCode(r);
  if (r != size) return ZD_LENGTH;
  return (long long)r;
}

__attribute__((export_name("zd_version"))) unsigned zd_version(void) { return ZSTD_versionNumber(); }
