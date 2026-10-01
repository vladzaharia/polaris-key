#!/usr/bin/env bash
# fetch_godot.sh <version> <dir> [--template]
#
# Puts the official Godot <version> Linux x86_64 editor at <dir>/godot and, with --template, the
# official linux_release.x86_64 export template at <dir>/linux_release.x86_64. Every download is
# checked against its upstream SHA-512 in tools/godot.sha512 before use; an unpinned file is
# refused. Does nothing when <dir> already holds the binaries (a CI cache hit).
#
# The template comes from the full .tpz (1.28 GB): only templates/linux_release.x86_64 is
# extracted and the archive is deleted, so the cache holds one 73 MB binary. A Range fetch of the
# single zip member would be smaller but could not be checked against the upstream hash.

set -eu

if [ $# -lt 2 ]; then
  echo "usage: fetch_godot.sh <version> <dir> [--template]" >&2
  exit 2
fi
VERSION="$1"
DIR="$2"
TEMPLATE="${3:-}"
PINS="$(cd "$(dirname "$0")" && pwd)/godot.sha512"
BASE="https://github.com/godotengine/godot/releases/download/${VERSION}-stable"

need_editor=1
need_template=0
[ -x "$DIR/godot" ] && need_editor=0
if [ "$TEMPLATE" = "--template" ] && [ ! -x "$DIR/linux_release.x86_64" ]; then
  need_template=1
fi
if [ "$need_editor" = 0 ] && [ "$need_template" = 0 ]; then
  echo "fetch_godot: $DIR already holds Godot $VERSION"
  exit 0
fi

mkdir -p "$DIR"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fetch_godot.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# fetch <file>: download into $WORK and check it against its pinned SHA-512.
fetch() {
  local file="$1"
  if ! grep -E "^[0-9a-f]{128}  ${file}\$" "$PINS" >"$WORK/$file.sha512"; then
    echo "fetch_godot: $file has no pin in $PINS" >&2
    exit 1
  fi
  echo "fetch_godot: downloading $file"
  curl -fsSL --retry 3 -o "$WORK/$file" "$BASE/$file"
  if command -v sha512sum >/dev/null 2>&1; then
    (cd "$WORK" && sha512sum -c "$file.sha512")
  else
    (cd "$WORK" && shasum -a 512 -c "$file.sha512")
  fi
}

if [ "$need_editor" = 1 ]; then
  editor="Godot_v${VERSION}-stable_linux.x86_64"
  fetch "$editor.zip"
  unzip -q -o "$WORK/$editor.zip" "$editor" -d "$WORK"
  mv "$WORK/$editor" "$DIR/godot"
  chmod +x "$DIR/godot"
  rm -f "$WORK/$editor.zip"
fi

if [ "$need_template" = 1 ]; then
  tpz="Godot_v${VERSION}-stable_export_templates.tpz"
  fetch "$tpz"
  unzip -q -o -j "$WORK/$tpz" "templates/linux_release.x86_64" -d "$WORK"
  rm -f "$WORK/$tpz"
  mv "$WORK/linux_release.x86_64" "$DIR/linux_release.x86_64"
  chmod +x "$DIR/linux_release.x86_64"
fi

echo "fetch_godot: Godot $VERSION ready in $DIR"
