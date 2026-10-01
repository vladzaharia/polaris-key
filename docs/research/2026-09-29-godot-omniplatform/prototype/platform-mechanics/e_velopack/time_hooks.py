#!/usr/bin/env python3
"""S-05 (e): time how long an executable takes to answer each Velopack hook (spawn -> exit).
usage: time_hooks.py <label> <exe> [reps]   -> JSON lines on stdout; hooks run with cwd = exe dir,
exactly as Velopack's run_hook does ([hook, version], wait, kill on timeout)."""
import json, os, subprocess, sys, time
label, exe = sys.argv[1], sys.argv[2]
reps = int(sys.argv[3]) if len(sys.argv) > 3 else 5
limits = {"--veloapp-install": 30, "--veloapp-obsolete": 15, "--veloapp-updated": 15, "--veloapp-uninstall": 30}
for hook, lim in limits.items():
    for r in range(reps):
        t = time.perf_counter()
        try:
            p = subprocess.run([exe, hook, "1.0.1"], cwd=os.path.dirname(exe), capture_output=True, timeout=lim)
            rc, killed = p.returncode, False
        except subprocess.TimeoutExpired:
            rc, killed = None, True
        print(json.dumps({"label": label, "hook": hook, "rep": r, "ms": round((time.perf_counter() - t) * 1000, 1), "rc": rc, "killed": killed, "limit_s": lim}), flush=True)
