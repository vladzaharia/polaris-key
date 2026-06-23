/// <reference types="@cloudflare/workers-types" />

/**
 * Renders the `curl | sh` installer served at `/<product>/install.sh`.
 *
 * The script body is operator-templated per product (`release_config.install_template`)
 * with `{{binaryName}}` / `{{origin}}` / `{{channels}}` placeholders, so each product
 * controls its own wording/install layout. When no template is configured we fall back
 * to a built-in script (ported from djdl): detect the CPU architecture, download the
 * matching binary from this gateway, install it to `/usr/local/bin` when writable
 * (no sudo escalation) or `~/.local/bin` otherwise, and mark it executable. The binary
 * is expected to be notarized, so there is NO Gatekeeper/`xattr` workaround.
 */

export interface InstallContext {
  /** Gateway origin, e.g. `https://key.plrs.im` (no trailing slash). */
  origin: string;
  /** Path prefix for this product's CLI downloads, e.g. `/<product>/cli`. */
  cliBase: string;
  /** Product binary name, e.g. `djdl`. */
  binaryName: string;
  /** Channel selectors the installer should advertise (e.g. `staging`, `beta`). */
  channels: string[];
  /** Env var the script reads for an explicit version (defaults `<BINARY>_VERSION`). */
  versionEnv: string;
}

/** Substitute the supported `{{...}}` placeholders in an operator-provided template. */
export function applyInstallTemplate(template: string, ctx: InstallContext): string {
  const channelsList = ctx.channels.join(" ");
  return template
    .replace(/\{\{\s*binaryName\s*\}\}/g, ctx.binaryName)
    .replace(/\{\{\s*origin\s*\}\}/g, ctx.origin)
    .replace(/\{\{\s*cliBase\s*\}\}/g, ctx.cliBase)
    .replace(/\{\{\s*versionEnv\s*\}\}/g, ctx.versionEnv)
    .replace(/\{\{\s*channels\s*\}\}/g, channelsList);
}

/**
 * The built-in installer (used when a product has no `install_template`). Ports djdl's
 * arch-detection + writable-dir selection, parameterized by binary name and origin.
 */
export function defaultInstallScript(ctx: InstallContext): string {
  const { origin, cliBase, binaryName, versionEnv } = ctx;
  return `#!/bin/sh
# ${binaryName} installer — ${origin}
#
# Usage:
#   curl -fsSL ${origin}${cliBase}/install.sh | sh
#
# Install a specific version (defaults to the latest release):
#   curl -fsSL ${origin}${cliBase}/install.sh | ${versionEnv}=1.2.3 sh
#
# Install a testing channel (coexists with stable; installs ${binaryName}-<channel>):
#   curl -fsSL ${origin}${cliBase}/install.sh | ${versionEnv}=staging sh
#   curl -fsSL ${origin}${cliBase}/install.sh | ${versionEnv}=pr-42 sh
set -eu

ORIGIN="${origin}"
CLI_BASE="${cliBase}"
VERSION="\${${versionEnv}:-latest}"

# Channel builds install under a distinct name so they coexist with stable.
case "$VERSION" in
  staging)    NAME="${binaryName}-staging" ;;
  beta)       NAME="${binaryName}-beta" ;;
  pr-[0-9]*)  NAME="${binaryName}-$VERSION" ;;
  *)          NAME="${binaryName}" ;;
esac

# --- Detect architecture --------------------------------------------------
RAW_ARCH="$(uname -m)"
case "$RAW_ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x86_64" ;;
  *)
    echo "Error: unsupported architecture '$RAW_ARCH'." >&2
    echo "${binaryName} ships builds for arm64 and x86_64 macs only." >&2
    exit 1
    ;;
esac

OS="$(uname -s)"
if [ "$OS" != "Darwin" ]; then
  echo "Error: ${binaryName} is a macOS tool, but this looks like '$OS'." >&2
  exit 1
fi

URL="$ORIGIN$CLI_BASE/$VERSION/${binaryName}-$ARCH"
echo "Downloading $NAME ($VERSION, $ARCH)..."

# --- Choose an install directory -----------------------------------------
if [ -w /usr/local/bin ] 2>/dev/null; then
  INSTALL_DIR="/usr/local/bin"
elif [ -d /usr/local/bin ] && mkdir -p /usr/local/bin 2>/dev/null && [ -w /usr/local/bin ]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

TARGET="$INSTALL_DIR/$NAME"
TMP="$(mktemp "\${TMPDIR:-/tmp}/${binaryName}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

# --- Download -------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar -o "$TMP" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP" "$URL"
else
  echo "Error: neither curl nor wget is available." >&2
  exit 1
fi

# --- Install --------------------------------------------------------------
chmod +x "$TMP"
mv "$TMP" "$TARGET"
trap - EXIT
chmod +x "$TARGET"

echo "Installed $NAME to $TARGET"

# --- PATH guidance --------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo "Run '$NAME --help' to get started."
    ;;
  *)
    echo ""
    echo "Note: $INSTALL_DIR is not on your PATH yet."
    echo "Add it by appending this line to your shell profile"
    echo "(e.g. ~/.zshrc or ~/.bash_profile), then open a new terminal:"
    echo ""
    echo "  export PATH=\\"$INSTALL_DIR:\\$PATH\\""
    echo ""
    echo "After that, run '$NAME --help' to get started."
    ;;
esac
`;
}

/** Render the installer for a product: template if present, else the built-in script. */
export function renderInstallScript(template: string | null | undefined, ctx: InstallContext): string {
  if (template && template.trim()) return applyInstallTemplate(template, ctx);
  return defaultInstallScript(ctx);
}
