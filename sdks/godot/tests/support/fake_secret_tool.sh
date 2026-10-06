#!/bin/sh
# A stand-in for libsecret's `secret-tool` (suite_keyring): the same command line, exit codes and
# stdin/stdout contract, over one file per attribute set under $PKEY_FAKE_SECRET_DIR.
#
#   store --label=L service S username U   reads the secret from stdin until EOF
#   lookup service S username U            prints it (no newline); exit 1 silently when absent
#   clear service S username U             removes it
#
# PKEY_FAKE_SECRET_FAIL=1 makes every call fail with a message on stderr (a locked or missing
# daemon), like `secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY`.
dir="${PKEY_FAKE_SECRET_DIR:?}"
if [ "${PKEY_FAKE_SECRET_FAIL:-}" = 1 ]; then
  echo "secret-tool: fake failure (the collection is locked)" >&2
  exit 1
fi
action="$1"; shift
case "$action" in store) shift ;; esac
[ "$1" = service ] && [ "$3" = username ] || { echo "secret-tool: bad attributes" >&2; exit 2; }
key="$(printf '%s|%s' "$2" "$4" | od -An -tx1 | tr -d ' \n')"
mkdir -p "$dir"
case "$action" in
  store) cat > "$dir/$key" ;;
  lookup) [ -f "$dir/$key" ] || exit 1; cat "$dir/$key" ;;
  clear) rm -f "$dir/$key" ;;
  *) echo "secret-tool: unknown action $action" >&2; exit 2 ;;
esac
