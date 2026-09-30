import json, sys
ref = json.load(open(sys.argv[1])); got = json.load(open(sys.argv[2]))
same = [k for k in ref if got.get(k) == ref[k]]; diff = [k for k in ref if got.get(k) != ref[k]]
print(f"{sys.argv[2].split('/')[-1]}: {len(same)}/{len(ref)} match reference; mismatches: {len(diff)}")
for k in diff[:12]: print("   ", k, (got.get(k) or '')[:40])
