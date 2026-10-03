#!/usr/bin/env python3
"""jcheck.py <log.jsonl> <event> <expression>: exit 0 when the expression, evaluated over `d`
(the detail of the LAST line whose event is <event>), is true. Used by the e2e run scripts."""
import json
import sys

log, event, expr = sys.argv[1], sys.argv[2], sys.argv[3]
detail = None
try:
    with open(log, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("event") == event:
                detail = row.get("detail")
except OSError:
    pass
if detail is None:
    sys.exit(1)
try:
    sys.exit(0 if eval(expr, {}, {"d": detail}) else 1)
except Exception as e:  # a missing key is a failed check, not a crash
    print(f"jcheck: {e!r}", file=sys.stderr)
    sys.exit(1)
