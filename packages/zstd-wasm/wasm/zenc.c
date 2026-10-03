// @polaris-key/zstd-wasm, encoder module (P4-17, notes/S-08 §6): libzstd 1.5.7 encoder plus
// decoder for wasm32, no libc, built by `build.sh enc`. It produces a `zstd --patch-from` frame
// byte-identical to `zstd --single-thread -<level> --patch-from=<from> <to>` (S-08 §4.2) and
// verifies it by decoding in the same instance.
//
// One job per instance, in this order (the JS driver in src/encoder.ts does it):
//
//   1. allocate the base (`from`) buffer and fill it: raw, or decoded from its `full` object as
//      it streams in (`ze_dbegin`/`ze_dstep`: ZSTD_d_stableOutBuffer, so the decoder writes
//      straight into the buffer and holds no window of its own, and the compressed bytes are
//      never resident); the decoder context sits above a mark and is reset away;
//   2. allocate the target (`to`) buffer and fill it the same way;
//   3. `ze_begin` (the base as a raw-content prefix, the parameters of programs/fileio.c's
//      FIO_adjustParamsForPatchFromMode), `ze_input` the WHOLE target once, and drain the frame
//      with `ze_step`. The input buffer is STABLE (ZSTD_c_stableInBuffer): libzstd reads the
//      target where it lies instead of copying it into a window buffer of its own, so the peak
//      is base + target + the match state, the S-08 model;
//   4. `ze_reset` to the mark taken after the base (dropping the target and the context) and
//      decode the frame over the base into a fresh target-sized buffer with `ze_decode`, which the
//      driver hashes.
//
// Levels outside 1..15 are refused (ZE_LEVEL): single-threaded zstd 1.5.7 at levels 16-19 breaks
// down on large prefixes (S-08 §4.1, a 19.6 MB delta where level 9 gives 0.53 MB), and this
// encoder is single-threaded by construction.
//
// Memory: the bump allocator of zdec.c, plus a mark and reset. Nothing is ever freed otherwise;
// the instance's memory dies with it.
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

/* Refusals, all negative; -1..-7 are zdec.c's. A libzstd error is -(1000 + its ZSTD_ErrorCode). */
#define ZD_HEADER -1      /* the frame header does not parse, or a skippable frame */
#define ZD_NOT_ONE -2     /* the input is not exactly one frame */
#define ZD_SIZE -3        /* the content size is absent or not the caller's size */
#define ZD_WINDOW -4      /* the header window is above 2^windowLogMax */
#define ZD_MEMORY -5      /* no context could be allocated */
#define ZD_LENGTH -6      /* the decode produced another length */
#define ZD_ARG -7         /* windowLogMax outside 10..31 */
#define ZE_LEVEL -8       /* the level is outside 1..15 */
#define ZE_STATE -9       /* ze_input/ze_step before ze_begin */

#define CK(x) do { size_t e_ = (x); if (ZSTD_isError(e_)) return -1000 - (long long)ZSTD_getErrorCode(e_); } while (0)

__attribute__((export_name("ze_alloc"))) void *ze_alloc(size_t n) { return malloc(n); }

static ZSTD_CCtx *cc;
static ZSTD_DCtx *ds;
static ZSTD_inBuffer ib;
static size_t last;
static int info[2];

/* The heap mark: everything allocated after it is dropped by ze_reset (and so is the context). */
__attribute__((export_name("ze_mark"))) unsigned long ze_mark(void) {
  if (!top) top = (unsigned long)&__heap_base;
  return top;
}
__attribute__((export_name("ze_reset"))) void ze_reset(unsigned long m) { top = m; cc = 0; ds = 0; }

/* Header checks shared by every decode; the window check runs whenever a prefix is given. */
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

/* One frame into dst (exactly `size` bytes), with an optional raw-content prefix: zdec.c's
 * zd_decode. Returns `size` or a refusal. */
__attribute__((export_name("ze_decode"))) long long ze_decode(void *dst, size_t size, const void *src, size_t n,
                                                              const void *prefix, size_t pn, unsigned wlm) {
  long long c = check(src, n, size, prefix != 0, wlm);
  if (c) return c;
  ZSTD_DCtx *d = ZSTD_createDCtx();
  if (!d) return ZD_MEMORY;
  if (prefix) CK(ZSTD_DCtx_refPrefix(d, prefix, pn));
  size_t r = ZSTD_decompressDCtx(d, dst, size, src, n);
  if (ZSTD_isError(r)) return -1000 - (long long)ZSTD_getErrorCode(r);
  if (r != size) return ZD_LENGTH;
  return (long long)r;
}

/* Streaming decode of one frame straight into dst[0..size) (ZSTD_d_stableOutBuffer): the
 * compressed input arrives in chunks and is never resident as a whole. */
static ZSTD_outBuffer dob;
__attribute__((export_name("ze_dbegin"))) int ze_dbegin(void *dst, size_t size) {
  ds = ZSTD_createDCtx();
  if (!ds) return ZD_MEMORY;
  CK(ZSTD_DCtx_setParameter(ds, ZSTD_d_stableOutBuffer, 1));
  CK(ZSTD_DCtx_setParameter(ds, ZSTD_d_windowLogMax, ZSTD_WINDOWLOG_MAX));
  dob.dst = dst; dob.size = size; dob.pos = 0;
  return 0;
}
/* Feed one chunk. Returns 0 when the frame is complete, a positive hint while it is not, or a
 * refusal: bytes after the end of the frame are ZD_NOT_ONE. */
__attribute__((export_name("ze_dstep"))) long long ze_dstep(const void *src, size_t n) {
  if (!ds) return ZE_STATE;
  ZSTD_inBuffer in = {src, n, 0};
  size_t r = 1;
  while (in.pos < in.size) {
    size_t before = in.pos, out = dob.pos;
    r = ZSTD_decompressStream(ds, &dob, &in);
    if (ZSTD_isError(r)) return -1000 - (long long)ZSTD_getErrorCode(r);
    if (r == 0 && in.pos < in.size) return ZD_NOT_ONE;
    if (in.pos == before && dob.pos == out) return ZD_LENGTH;
  }
  return (long long)r;
}
/* Decoded bytes so far. */
__attribute__((export_name("ze_dpos"))) size_t ze_dpos(void) { return dob.pos; }

static unsigned highbit64(unsigned long long v) { unsigned n = 0; while (v >>= 1) n++; return n; }

/* Begin a --patch-from encode of `srcSize` bytes over `prefix`, at `level` (1..15). The
 * parameters are FIO_adjustParamsForPatchFromMode's for a single-threaded CLI run: the window
 * from the target's bit length plus one (the CLI's maxSrcFileSize), long mode when that window exceeds the cycle of
 * the level's match finder, the level's own table sizes, content size and checksum on. */
__attribute__((export_name("ze_begin"))) int ze_begin(const void *prefix, size_t pn, unsigned long long srcSize, int level) {
  if (level < 1 || level > 15) return ZE_LEVEL;
  unsigned fileWindowLog = highbit64(srcSize) + 1;
  ZSTD_compressionParameters cp = ZSTD_getCParams(level, (size_t)srcSize, pn);
  int wlog = (int)fileWindowLog;
  if (wlog < ZSTD_WINDOWLOG_MIN) wlog = ZSTD_WINDOWLOG_MIN;
  if (wlog > ZSTD_WINDOWLOG_MAX) wlog = ZSTD_WINDOWLOG_MAX;
  unsigned cycle = cp.chainLog - (cp.strategy >= ZSTD_btlazy2 ? 1 : 0);
  int useLdm = fileWindowLog > cycle;
  cc = ZSTD_createCCtx();
  if (!cc) return ZD_MEMORY;
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_contentSizeFlag, 1));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_checksumFlag, 1));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_compressionLevel, level));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_enableLongDistanceMatching, useLdm));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_windowLog, wlog));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_chainLog, (int)cp.chainLog));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_hashLog, (int)cp.hashLog));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_searchLog, (int)cp.searchLog));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_minMatch, (int)cp.minMatch));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_targetLength, (int)cp.targetLength));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_strategy, (int)cp.strategy));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_enableDedicatedDictSearch, 1));
  CK(ZSTD_CCtx_setParameter(cc, ZSTD_c_stableInBuffer, 1));
  CK(ZSTD_CCtx_setPledgedSrcSize(cc, srcSize));
  CK(ZSTD_CCtx_refPrefix(cc, prefix, pn));
  info[0] = wlog;
  info[1] = useLdm;
  ib.src = 0; ib.size = 0; ib.pos = 0;
  return 0;
}

/* 0: the window log; 1: long mode on (1) or off (0). */
__attribute__((export_name("ze_info"))) int ze_info(int i) { return i >= 0 && i < 2 ? info[i] : -1; }

/* The whole target, once: the buffer must stay where it is until the frame is drained. */
__attribute__((export_name("ze_input"))) int ze_input(const void *p, size_t n) {
  if (!cc) return ZE_STATE;
  ib.src = p; ib.size = n; ib.pos = 0;
  return 0;
}

/* One ZSTD_e_end call into out[0..cap). Returns the bytes written or a refusal; the frame is
 * complete when ze_remaining() answers 0. */
__attribute__((export_name("ze_step"))) long long ze_step(void *out, size_t cap) {
  if (!cc) return ZE_STATE;
  ZSTD_outBuffer ob = {out, cap, 0};
  size_t r = ZSTD_compressStream2(cc, &ob, &ib, ZSTD_e_end);
  if (ZSTD_isError(r)) return -1000 - (long long)ZSTD_getErrorCode(r);
  last = r;
  return (long long)ob.pos;
}
__attribute__((export_name("ze_remaining"))) size_t ze_remaining(void) { return last; }

__attribute__((export_name("ze_version"))) unsigned ze_version(void) { return ZSTD_versionNumber(); }
