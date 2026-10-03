import json, sys
r = json.load(open(sys.argv[1]))
print('done', r.get('done'))
labels = [s for s in json.load(open(sys.argv[2]))['steps'] if s.get('op') == 'call']
sigs = [g for g in r['signals'] if g['signal'] == 'iau_state']
for lab, g in zip(labels, sigs):
    p = g['payload']
    print(f"--- {lab.get('label', lab.get('name'))} ({p['event']}) main_thread={g['main_thread']} emit_thread={p['emit_thread']}")
    for t in p['trace']:
        d = {k: v for k, v in t.items() if k not in ('thread',)}
        if 'info' in d:
            i = d.pop('info'); d['info'] = {k: i[k] for k in ('availability', 'availableVersionCode', 'installStatus', 'priority', 'staleness', 'bytes', 'total', 'flexibleAllowed', 'immediateAllowed', 'flexiblePreconditions', 'immediatePreconditions')}
        print('   ', json.dumps(d))
