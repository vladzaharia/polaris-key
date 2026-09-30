import sys; sys.path.insert(0, __file__.rsplit('/',1)[0]); import pck
A,B=sys.argv[1],sys.argv[2]
a=pck.read_pck(A); b=pck.read_pck(B)
ea={e['path']:e for e in a['entries']}; eb={e['path']:e for e in b['entries']}
print('only in A', sorted(set(ea)-set(eb))); print('only in B', sorted(set(eb)-set(ea)))
diff=[p for p in ea if p in eb and ea[p]['md5']!=eb[p]['md5']]
print('content differs', len(diff))
for p in diff:
    da=pck.read_entry(A,ea[p]); db=pck.read_entry(B,eb[p])
    nd=[i for i in range(min(len(da),len(db))) if da[i]!=db[i]]
    print(f'  {p} size {len(da)}->{len(db)} differing bytes {len(nd)} first@{nd[:1]}')
print('offset differs', sum(1 for p in ea if p in eb and ea[p]['ofs']!=eb[p]['ofs']))
