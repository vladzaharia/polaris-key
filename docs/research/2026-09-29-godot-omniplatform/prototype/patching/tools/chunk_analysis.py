import json, os, zstandard as zs
O='out'
C=zs.ZstdCompressor(level=19)
modes=['16384','65536','262144','1048576','fixed_65536','fixed_262144','fixed_1048576']
rows=[]
for base in ['pck','zip','pck.zst']:
    v2size=os.path.getsize(f'{O}/v2.{base}')
    v2=open(f'{O}/v2.{base}','rb').read()
    for m in modes:
        a=json.load(open(f'{O}/cdc_v1.{base}_{m}.json')); b=json.load(open(f'{O}/cdc_v2.{base}_{m}.json'))
        have={c['sha256'] for c in a}
        miss={}; 
        for c in b:
            if c['sha256'] not in have: miss[c['sha256']]=c
        raw=sum(c['size'] for c in miss.values())
        comp=sum(len(C.compress(v2[c['ofs']:c['ofs']+c['size']])) for c in miss.values()) if base!='pck.zst' else raw
        avg=sum(c['size'] for c in b)//len(b)
        recipe=len(b)*40
        rows.append((base,m,len(b),avg,len(miss),raw,comp,recipe,v2size))
print(f"{'input':8} {'chunker':14} {'chunks':>6} {'avg':>8} {'missing':>7} {'dl_raw':>10} {'dl_zstd':>10} {'recipe':>7} {'%of v2':>7}")
for r in rows:
    print(f"{r[0]:8} {r[1]:14} {r[2]:>6} {r[3]:>8} {r[4]:>7} {r[5]:>10} {r[6]:>10} {r[7]:>7} {100*r[5]/r[8]:>6.1f}%")
json.dump(rows, open(f'{O}/chunk_analysis.json','w'))
