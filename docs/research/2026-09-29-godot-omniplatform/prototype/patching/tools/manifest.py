import sys, json, hashlib; sys.path.insert(0, __file__.rsplit('/',1)[0]); import pck
src, out = sys.argv[1], sys.argv[2]
info = pck.read_pck(src); m = {"pack_sha256": hashlib.sha256(open(src,'rb').read()).hexdigest(), "size": __import__('os').path.getsize(src), "files": {}}
for e in info["entries"]:
    if e["flags"] & 2: continue
    d = pck.read_entry(src, e)
    m["files"][e["path"]] = {"sha256": hashlib.sha256(d).hexdigest(), "size": e["size"], "md5": e["md5"], "ofs": e["ofs"]}
json.dump(m, open(out, "w"), indent=0, sort_keys=True)
print(out, len(m["files"]))
