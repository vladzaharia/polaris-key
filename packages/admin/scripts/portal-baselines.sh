#!/usr/bin/env bash
# The portal's linux visual baselines (PX-20; packages/admin/e2e/portalHarness.ts).
#
# CI runs the portal quality bar in Playwright's own image (.github/workflows/ci.yml, job
# `console`), so the committed baselines are rendered in that same image. This script copies the
# working tree (without node_modules, dist or .git) into a throwaway container of that image,
# installs and builds the console there, runs e2e/portalQuality.e2e.test.ts and copies the linux
# baselines back into e2e/__baselines__/portal/linux/.
#
#   scripts/portal-baselines.sh            re-record every linux baseline
#   scripts/portal-baselines.sh --check    compare against the committed set, as CI does
#
# Needs Docker; the container is linux/amd64 (what CI runs), emulated on an arm64 host. The pnpm store lives in the `pk-portal-baselines-pnpm` volume between runs.
set -euo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble"
MODE="update"
case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

ADMIN="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$ADMIN/../.." && pwd)"
OUT="$ADMIN/e2e/__baselines__/portal"
mkdir -p "$OUT/linux"
PNPM="$(mise exec node@22 -- node -p "require('$ROOT/package.json').packageManager.split('@')[1]")"

docker run --rm --init --ipc=host --platform linux/amd64 \
  -e MODE="$MODE" -e PNPM="$PNPM" -e CI=1 \
  -v "$ROOT":/src:ro \
  -v "$OUT":/out \
  -v pk-portal-baselines-pnpm:/pnpm-store \
  "$IMAGE" bash -euo pipefail -c '
    mkdir -p /work
    tar -C /src --exclude=node_modules --exclude=dist --exclude=.turbo --exclude=.git \
      --exclude=.venv --exclude=packages/admin/e2e/__baselines__ -cf - . | tar -C /work -xf -
    mkdir -p /work/packages/admin/e2e/__baselines__/portal
    cp -R /out/linux /work/packages/admin/e2e/__baselines__/portal/linux
    cd /work
    # Node 22, the floor the repo pins (AGENTS.md); the image ships its own Node.
    if [ "$(node -p "process.versions.node.split(\".\")[0]")" != 22 ]; then
      D=https://nodejs.org/dist/latest-v22.x
      T=$(curl -fsSL "$D/SHASUMS256.txt" | grep -o "node-v22[.0-9]*-linux-x64\.tar\.gz" | head -1)
      curl -fsSL "$D/$T" | tar -xz -C /opt
      export PATH="/opt/${T%.tar.gz}/bin:$PATH"
    fi
    npm install -g --silent "pnpm@$PNPM"
    pnpm config set store-dir /pnpm-store >/dev/null
    pnpm install --frozen-lockfile --filter=@polaris-key/admin... --filter=@polaris-key/worker... >/dev/null
    pnpm exec turbo run build --filter=@polaris-key/admin... --output-logs=errors-only
    cd packages/admin
    # Update re-records every state it visits over the committed set, so a state that fails
    # before its screenshot (a timeout under emulation) keeps its committed baseline rather
    # than losing it. A baseline for a state that no longer exists is removed by hand.
    if [ "$MODE" = update ]; then
      export PK_UPDATE_BASELINES=1
    fi
    status=0
    pnpm exec vitest run -c vitest.e2e.config.ts e2e/portalQuality.e2e.test.ts || status=$?
    if [ "$MODE" = update ]; then
      rm -f /out/linux/*.png
      cp e2e/__baselines__/portal/linux/*.png /out/linux/
    elif [ -d e2e/__baselines__/portal/.out ]; then
      mkdir -p /out/.out && cp -R e2e/__baselines__/portal/.out/. /out/.out/
    fi
    exit $status
  '
echo "linux baselines: $OUT/linux ($(ls "$OUT/linux" | wc -l | tr -d " ") files)"
