// S-08 spike: libzstd 1.5.7 encoder + decoder for wasm32, no libc (same toolchain and bump
// allocator as packages/zstd-wasm/wasm/zdec.c). Streams a `--patch-from` encode: the prefix
// (old payload) stays resident in linear memory, the new payload is pushed in chunks, output is
// drained in chunks. Parameters mirror programs/fileio.c FIO_adjustParamsForPatchFromMode.
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

__attribute__((export_name("ze_alloc"))) void *ze_alloc(size_t n) { return malloc(n); }
__attribute__((export_name("ze_heap_top"))) unsigned long ze_heap_top(void) { return top; }

static unsigned highbit64(unsigned long long v) { unsigned n = 0; while (v >>= 1) n++; return n; }

static ZSTD_CCtx *cc;
static ZSTD_inBuffer ib;
static size_t last;
static int info[8];

#define CK(x) do { size_t e_ = (x); if (ZSTD_isError(e_)) return -1000 - (int)ZSTD_getErrorCode(e_); } while (0)

/* Begin a --patch-from encode. level: zstd level. wlogOverride/clogOverride/hlogOverride: 0 = as
 * the CLI. ldm: -1 = as the CLI (auto), 0/1 forced. Returns 0 or a negative error. */
__attribute__((export_name("ze_begin"))) int ze_begin(const void *prefix, size_t pn, unsigned long long srcSize, int level,
                                                      int wlogOverride, int clogOverride, int hlogOverride, int ldm) {
  unsigned long long maxSrc = srcSize;
  unsigned fileWindowLog = highbit64(maxSrc) + 1;
  ZSTD_compressionParameters cp = ZSTD_getCParams(level, (size_t)maxSrc, pn);
  int wlog = (int)fileWindowLog;
  if (wlog < ZSTD_WINDOWLOG_MIN) wlog = ZSTD_WINDOWLOG_MIN;
  if (wlog > ZSTD_WINDOWLOG_MAX) wlog = ZSTD_WINDOWLOG_MAX;
  if (wlogOverride) wlog = wlogOverride;
  /* ZSTD_cycleLog: chainLog - (strategy >= btlazy2) */
  unsigned cycle = cp.chainLog - (cp.strategy >= ZSTD_btlazy2 ? 1 : 0);
  int useLdm = ldm >= 0 ? ldm : (fileWindowLog > cycle);
  cc = ZSTD_createCCtx();
  if (!cc) return -5;
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_contentSizeFlag, 1));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_checksumFlag, 1));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_compressionLevel, level));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_enableLongDistanceMatching, useLdm));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_windowLog, wlog));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_chainLog, clogOverride ? clogOverride : (int)cp.chainLog));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_hashLog, hlogOverride ? hlogOverride : (int)cp.hashLog));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_searchLog, (int)cp.searchLog));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_minMatch, (int)cp.minMatch));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_targetLength, (int)cp.targetLength));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_strategy, (int)cp.strategy));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_enableDedicatedDictSearch, 1));
  CK(ZSTD_CCtx_setPledgedSrcSize(cc, srcSize));
  CK(ZSTD_CCtx_refPrefix(cc, prefix, pn));
  info[0] = wlog; info[1] = useLdm; info[2] = clogOverride ? clogOverride : (int)cp.chainLog;
  info[3] = hlogOverride ? hlogOverride : (int)cp.hashLog; info[4] = (int)cp.strategy;
  return 0;
}
__attribute__((export_name("ze_info"))) int ze_info(int i) { return info[i]; }

__attribute__((export_name("ze_input"))) void ze_input(const void *p, size_t n) { ib.src = p; ib.size = n; ib.pos = 0; }
__attribute__((export_name("ze_inleft"))) size_t ze_inleft(void) { return ib.size - ib.pos; }
__attribute__((export_name("ze_remaining"))) size_t ze_remaining(void) { return last; }
__attribute__((export_name("ze_cctx_size"))) size_t ze_cctx_size(void) { return ZSTD_sizeof_CCtx(cc); }

/* One compressStream2 call into out[0..cap). Returns bytes written or a negative error. */
__attribute__((export_name("ze_step"))) long long ze_step(void *out, size_t cap, int end) {
  ZSTD_outBuffer ob = {out, cap, 0};
  size_t r = ZSTD_compressStream2(cc, &ob, &ib, end ? ZSTD_e_end : ZSTD_e_continue);
  if (ZSTD_isError(r)) return -1000 - (long long)ZSTD_getErrorCode(r);
  last = r;
  return (long long)ob.pos;
}

/* Streaming decode with a prefix (verification). */
static ZSTD_DCtx *dc;
static ZSTD_inBuffer dib;
__attribute__((export_name("zd_begin"))) int zd_begin(const void *prefix, size_t pn, unsigned wlm) {
  dc = ZSTD_createDCtx();
  if (!dc) return -5;
  CK(ZSTD_DCtx_setParameter(dc, ZSTD_d_windowLogMax, (int)wlm));
  CK(ZSTD_DCtx_refPrefix(dc, prefix, pn));
  return 0;
}
__attribute__((export_name("zd_input"))) void zd_input(const void *p, size_t n) { dib.src = p; dib.size = n; dib.pos = 0; }
__attribute__((export_name("zd_inleft"))) size_t zd_inleft(void) { return dib.size - dib.pos; }
__attribute__((export_name("zd_step"))) long long zd_step(void *out, size_t cap) {
  ZSTD_outBuffer ob = {out, cap, 0};
  size_t r = ZSTD_decompressStream(dc, &ob, &dib);
  if (ZSTD_isError(r)) return -1000 - (long long)ZSTD_getErrorCode(r);
  last = r;
  return (long long)ob.pos;
}
__attribute__((export_name("zd_dctx_size"))) size_t zd_dctx_size(void) { return ZSTD_sizeof_DCtx(dc); }

/* Heap marks: reset the bump heap to a mark so a verify decode reuses the encoder's memory
 * (and the resident prefix) instead of growing linear memory again. */
__attribute__((export_name("ze_mark"))) unsigned long ze_mark(void) { return top; }
__attribute__((export_name("ze_reset"))) void ze_reset(unsigned long m) { top = m; cc = 0; }
