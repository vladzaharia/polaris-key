"""Re-run of the chunking study: FastCDC (plain and file-aware) and fixed blocks over v1/v2 in three container forms.
Writes out/r/cdc_<file>_<mode>.json recipes and out/r/chunk_analysis.json; prints a table."""
import json, os, subprocess, sys, time
import zstandard as zs
sys.path.insert(0, 'tools'); import pck
O = 'out'; R = 'out/r'
C = zs.ZstdCompressor(level=19)
def segs(p):
    i = pck.read_pck(p); ents = sorted(i['entries'], key=lambda e: e['ofs']); out = []; pos = 0
    for e in ents:
        if e['size'] == 0: continue
        if e['ofs'] > pos: out.append([pos, e['ofs'] - pos])
        out.append([e['ofs'], e['size']]); pos = e['ofs'] + e['size']
    out.append([pos, os.path.getsize(p) - pos]); return out
for v in ['v1', 'v2']:
    json.dump(segs(f'{O}/{v}.pck'), open(f'{R}/segs_{v}.json', 'w'))
def recipe(file, mode, seg=None):
    tag = f"{os.path.basename(file)}_{mode.replace(':', '_')}" + ('_fa' if seg else '')
    env = dict(os.environ)
    if seg: env['FASTCDC_SEGMENTS'] = seg
    t = time.time()
    r = subprocess.run(['node', 'tools/fastcdc.cjs', file, mode], capture_output=True, env=env, check=True)
    open(f'{R}/cdc_{tag}.json', 'wb').write(r.stdout)
    return json.loads(r.stdout), time.time() - t
rows = []
modes = ['16384', '65536', '262144', '1048576', 'fixed:65536', 'fixed:262144', 'fixed:1048576']
for base in ['pck', 'pck.zst', 'zip']:
    f1, f2 = f'{O}/v1.{base}', f'{O}/v2.{base}'
    v2 = open(f2, 'rb').read(); v2size = len(v2)
    variants = [(m, None) for m in modes] + ([(m, 'fa') for m in ['16384', '65536', '262144']] if base == 'pck' else [])
    for m, fa in variants:
        a, _ = recipe(f1, m, f'{R}/segs_v1.json' if fa else None)
        b, secs = recipe(f2, m, f'{R}/segs_v2.json' if fa else None)
        have = {c['sha256'] for c in a}
        miss = {}
        for c in b:
            if c['sha256'] not in have: miss[c['sha256']] = c
        raw = sum(c['size'] for c in miss.values())
        comp = sum(len(C.compress(v2[c['ofs']:c['ofs'] + c['size']])) for c in miss.values())
        allcomp = sum(len(C.compress(v2[c['ofs']:c['ofs'] + c['size']])) for c in {c['sha256']: c for c in b}.values()) if m in ('65536', '262144') and not fa else None
        rows.append(dict(input=base, chunker=('fa-' if fa else '') + m, chunks=len(b), avg=v2size // len(b), missing=len(miss),
                         dl_raw=raw, dl_zstd=comp, index_bytes=len(b) * 40, pct_raw=round(100 * raw / v2size, 1),
                         full_per_chunk_zstd=allcomp))
        if base == 'pck' and m == '65536' and not fa:
            os.makedirs(f'{R}/chunks_65536', exist_ok=True); os.makedirs(f'{R}/chunks_65536_zst', exist_ok=True)
            for h, c in miss.items():
                blob = v2[c['ofs']:c['ofs'] + c['size']]
                open(f'{R}/chunks_65536/{h}', 'wb').write(blob)
                open(f'{R}/chunks_65536_zst/{h}', 'wb').write(C.compress(blob))
json.dump(rows, open(f'{R}/chunk_analysis.json', 'w'), indent=1)
print(f"{'input':8} {'chunker':16} {'chunks':>6} {'avg':>8} {'miss':>5} {'dl_raw':>10} {'dl_zstd':>10} {'index':>7} {'%raw':>6} {'full_pc_zstd':>12}")
for r in rows:
    print(f"{r['input']:8} {r['chunker']:16} {r['chunks']:>6} {r['avg']:>8} {r['missing']:>5} {r['dl_raw']:>10} {r['dl_zstd']:>10} {r['index_bytes']:>7} {r['pct_raw']:>5}% {r['full_per_chunk_zstd'] or '':>12}")
