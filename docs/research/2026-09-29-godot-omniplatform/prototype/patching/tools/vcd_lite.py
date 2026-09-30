#!/usr/bin/env python3
"""'VCDIFF-lite' delta for PCKs: COPY(src_ofs,len) / ADD(len) ops + a literal stream, zstd-compressed as a whole.
The client needs only PackedByteArray.decompress (plain zstd, no dictionary) and FileAccess seek/get_buffer.
PCK-aware generator: unchanged entries -> one COPY; changed entries -> 64-byte block matching against the
old version of the same path (and the whole old pack as a fallback index); everything else -> ADD.
usage: vcd_lite.py old.pck new.pck out.vcdl [block]
"""
import struct, sys, hashlib, time
import zstandard as zs
sys.path.insert(0, __file__.rsplit('/', 1)[0])
import pck

old_p, new_p, out_p = sys.argv[1:4]
B = int(sys.argv[4]) if len(sys.argv) > 4 else 64
old = open(old_p, 'rb').read(); new = open(new_p, 'rb').read()
io = pck.read_pck(old_p); inw = pck.read_pck(new_p)
old_by_sha = {}
old_by_path = {}
for e in io['entries']:
    d = old[e['ofs']:e['ofs'] + e['size']]
    old_by_sha.setdefault(hashlib.sha256(d).digest(), e['ofs'])
    old_by_path[e['path']] = e

ops = []  # (kind, a, b): ('C', src, len) / ('A', start_in_new, len)
def add(start, n):
    if n <= 0: return
    if ops and ops[-1][0] == 'A' and ops[-1][1] + ops[-1][2] == start:
        ops[-1] = ('A', ops[-1][1], ops[-1][2] + n)
    else:
        ops.append(('A', start, n))
def copy(src, n):
    if ops and ops[-1][0] == 'C' and ops[-1][1] + ops[-1][2] == src:
        ops[-1] = ('C', ops[-1][1], ops[-1][2] + n)
    else:
        ops.append(('C', src, n))

def block_diff(nstart, nlen, ostart, olen):
    """Greedy 64-byte block matcher of new[nstart:nstart+nlen] against old[ostart:ostart+olen]."""
    idx = {}
    for o in range(ostart, ostart + olen - B + 1, B):
        idx.setdefault(old[o:o + B], o)
    i = nstart; end = nstart + nlen; lit = i
    while i + B <= end:
        o = idx.get(new[i:i + B])
        if o is None:
            i += 1; continue
        # extend backwards into pending literals and forwards
        bk = 0
        while i - bk > lit and o - bk > ostart and new[i - bk - 1] == old[o - bk - 1]: bk += 1
        fw = B
        while i + fw < end and o + fw < ostart + olen and new[i + fw] == old[o + fw]: fw += 1
        add(lit, i - bk - lit); copy(o - bk, bk + fw)
        i += fw; lit = i
    add(lit, end - lit)

t0 = time.time()
ents = sorted(inw['entries'], key=lambda e: e['ofs'])
pos = 0
for e in ents:
    if e['size'] == 0: continue
    add(pos, e['ofs'] - pos)  # header / padding
    d = new[e['ofs']:e['ofs'] + e['size']]
    src = old_by_sha.get(hashlib.sha256(d).digest())
    if src is not None:
        copy(src, e['size'])
    elif e['path'] in old_by_path:
        oe = old_by_path[e['path']]
        block_diff(e['ofs'], e['size'], oe['ofs'], oe['size'])
    else:
        add(e['ofs'], e['size'])
    pos = e['ofs'] + e['size']
add(pos, len(new) - pos)  # trailing padding + directory
gen_s = time.time() - t0

opbuf = bytearray(); lits = bytearray()
for k, a, n in ops:
    if k == 'C':
        opbuf += struct.pack('<BQI', 0, a, n)
    else:
        opbuf += struct.pack('<BQI', 1, 0, n); lits += new[a:a + n]
raw = struct.pack('<4sIQQ', b'VCDL', len(ops), len(new), len(lits)) + bytes(opbuf) + bytes(lits)
comp = zs.ZstdCompressor(level=19).compress(raw)
open(out_p, 'wb').write(struct.pack('<Q', len(raw)) + comp)
nc = sum(1 for o in ops if o[0] == 'C')
print(f"ops={len(ops)} (copy {nc}, add {len(ops)-nc}) literals={len(lits)} raw={len(raw)} zstd19={len(comp)+8} gen={gen_s:.1f}s")
