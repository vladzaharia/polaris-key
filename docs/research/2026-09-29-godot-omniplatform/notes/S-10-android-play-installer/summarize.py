import json, sys
for case in sys.argv[1:]:
    try: r = json.load(open(f'results/result_{case}.json'))
    except Exception as e: print(case, 'MISSING', e); continue
    print(f'=== {case} done={r.get("done", False)} flavor={r.get("flavor")}')
    for s in r.get('steps', []):
        rr = s.get('r')
        if s['op'] == 'copyIn': continue
        if isinstance(rr, dict) and 'log' in rr:
            for e in rr['log'][-4:]: print('   log', json.dumps({k: e.get(k) for k in ('event','status','message','legacyStatus','pluginAlive','promptLaunched','wall')}))
            continue
        if isinstance(rr, dict) and 'verify' in rr:
            v = rr['verify']; rr = dict(rr); rr['verify'] = {k: v.get(k) for k in ('ok','refused')}
        if isinstance(rr, dict) and 'blob' in rr: rr = dict(rr); rr['blob'] = rr['blob'][:12] + '...'
        print(' ', s['op'], json.dumps(rr)[:420], 'awaited=' + str(s['awaited']) if 'awaited' in s else '')
    for g in r.get('signals', []):
        p = g['payload']
        print('  SIG', g['signal'], 'main_thread=%s' % g['main_thread'], json.dumps({k: p.get(k) for k in p if k not in ('emit_main_looper',)})[:400])
