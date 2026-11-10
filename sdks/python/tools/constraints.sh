#!/usr/bin/env bash
# Regenerate constraints/pyXY.txt: exact pins for what `.[dev]` and the extras resolve to on one
# CPython, from releases at least 14 days old (the owner's pinning rule). Needs uv.
#   tools/constraints.sh            all three files
#   tools/constraints.sh 3.14       one
set -euo pipefail
cd "$(dirname "$0")/.."
cutoff="${PKEY_CONSTRAINTS_CUTOFF:-$(python3 -c 'import datetime;print((datetime.date.today()-datetime.timedelta(days=14)).isoformat()+"T00:00:00Z")')}"
extras=(dev qt connect keyring requests tui cli click typer starlette fastapi flask django drf)
for v in "${@:-3.9 3.12 3.14}"; do
  for ver in $v; do
    n="py${ver/./}"
    tmp="$(mktemp)"
    # No -o to an existing file: uv would reuse its pins as preferences and never move them.
    uv pip compile pyproject.toml --python-version "$ver" --python-platform x86_64-manylinux_2_34 \
      $(printf -- '--extra %s ' "${extras[@]}") --exclude-newer "$cutoff" --no-header --no-annotate -o "$tmp" >/dev/null
    {
      echo "# Exact pins for CPython $ver: everything \`pip install -e \".[dev]\"\` (and the qt, connect, keyring and"
      echo "# server extras) resolves to, each release at least 14 days old. Use as a constraint, never edit by hand:"
      echo "#   pip install -e \".[dev]\" -c constraints/$n.txt"
      echo "# Regenerate (see \"Dependency pins\" in README.md): tools/constraints.sh $ver"
      cat "$tmp"
    } >"constraints/$n.txt"
    /bin/rm -f "$tmp"
  done
done
