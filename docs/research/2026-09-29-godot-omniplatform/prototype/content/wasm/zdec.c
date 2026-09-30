// Decoder-only libzstd for wasm32 with raw-content prefix support (zstd --patch-from). No libc.
#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"
#include <string.h>
#include <stdlib.h>
extern unsigned char __heap_base;
static unsigned long top = 0;
static unsigned long cap_bytes(void) { return (unsigned long)__builtin_wasm_memory_size(0) * 65536ul; }
void *malloc(size_t n) {
  if (!top) top = (unsigned long)&__heap_base;
  unsigned long p = (top + 15) & ~15ul, end = p + n;
  if (end > cap_bytes()) {
    unsigned long need = (end - cap_bytes() + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, need) == (unsigned long)-1) return 0;
  }
  top = end;
  return (void *)p;
}
void *calloc(size_t n, size_t s) { void *p = malloc(n * s); if (p) memset(p, 0, n * s); return p; }
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

__attribute__((export_name("zd_reset"))) void zd_reset(void) { top = (unsigned long)&__heap_base; }
__attribute__((export_name("zd_alloc"))) void *zd_alloc(size_t n) { return malloc(n); }
__attribute__((export_name("zd_content_size"))) long long zd_content_size(const void *src, size_t n) {
  unsigned long long r = ZSTD_getFrameContentSize(src, n);
  return r >= ZSTD_CONTENTSIZE_ERROR ? -1 : (long long)r;
}
/* returns decoded size, or -(zstd error code) - 1 */
__attribute__((export_name("zd_decompress"))) long long zd_decompress(void *dst, size_t cap, const void *src, size_t n, const void *dict, size_t dn) {
  ZSTD_DCtx *d = ZSTD_createDCtx();
  if (!d) return -1000;
  if (dict) { size_t e = ZSTD_DCtx_refPrefix(d, dict, dn); if (ZSTD_isError(e)) return -(long long)ZSTD_getErrorCode(e) - 1; }
  size_t r = ZSTD_decompressDCtx(d, dst, cap, src, n);
  if (ZSTD_isError(r)) return -(long long)ZSTD_getErrorCode(r) - 1;
  return (long long)r;
}
__attribute__((export_name("zd_version"))) unsigned zd_version(void) { return ZSTD_versionNumber(); }
