/// <reference types="@cloudflare/workers-types" />

/**
 * Renders the `curl | sh` installer served at `/<product>/install.sh`.
 *
 * The script body is operator-templated per product (`release_config.install_template`)
 * with `{{binaryName}}` / `{{origin}}` / `{{channels}}` placeholders, so each product
 * controls its own wording/install layout. When no template is configured we fall back
 * to a built-in script: detect the CPU architecture, download the
 * matching binary from this gateway, verify its published SHA-256 checksum, install it to
 * `/usr/local/bin` when writable (no sudo escalation) or `~/.local/bin` otherwise, and mark
 * it executable.
 *
 * SECURITY (R6-01). Everything interpolated here lands in a POSIX shell that users pipe
 * straight into `sh`, and `binaryName` is repo-owned (`.pkey/release.*`). Two layers guard it:
 *   1. `validateInstallContext` rejects any value outside a strict character class, so the
 *      renderer refuses to emit a script it cannot prove safe (callers serve a 404).
 *   2. Values that are not themselves charset-bounded (`origin`, `cliBase`) are emitted as
 *      `shQuote`-produced single-quoted literals rather than double-quoted interpolations.
 *
 * SECURITY (R6-02). The download is verified against a `.sha256` published alongside the
 * artifact before it is made executable. Nothing here checks notarization — `curl`-downloaded
 * files never receive `com.apple.quarantine`, so Gatekeeper is not consulted on this path.
 */

export interface InstallContext {
  /** Gateway origin, e.g. `https://key.plrs.im` (no trailing slash). */
  origin: string;
  /** Path prefix for this product's artifact downloads, e.g. `/<product>/release/dl`. */
  cliBase: string;
  /** Canonical path of this script, e.g. `/<product>/release/install.sh`, for its own usage
   *  lines. Previously derived as `cliBase + "/install.sh"`, which named a path that has never
   *  existed — the installer told users to curl a URL that 404s. */
  installPath: string;
  /** Product binary name, e.g. `djdl`. */
  binaryName: string;
  /** Channel selectors the installer should advertise (e.g. `staging`, `beta`). */
  channels: string[];
  /** Env var the script reads for an explicit version (defaults `<BINARY>_VERSION`). */
  versionEnv: string;
}

/** Repo-owned; mirrors the `binaryName` class enforced at the manifest boundary. */
const BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Derived from the request URL (R6-11); scheme + host + optional port, nothing else. */
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9._-]+(?::[0-9]{1,5})?$/;
/**
 * Built from the product slug, which the router bounds to `[a-z0-9-]`, plus a fixed suffix.
 *
 * Two-to-four segments since P2.T1: the download base moved from `/<p>/cli` to the canonical
 * `/<p>/release/dl` (§R1). The CHARACTER CLASS is unchanged — that is the part doing the R6-01
 * work — and the bound stays finite so no caller-derived value can grow a path arbitrarily.
 */
const PRODUCT_PATH_RE = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,3}$/;
/** Shell env-var name, so it must be a shell-legal identifier. */
const VERSION_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * POSIX single-quote a value so a shell reads it as one literal token: wrap in `'…'` and
 * close/escape/reopen around every embedded `'`. Safe for arbitrary bytes.
 */
export function shQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * Is this safe to interpolate into the installer? Exported so the ingest paths
 * (`linkRepo` / `resyncRepo`) can refuse to persist a name the renderer would reject.
 */
export function isSafeBinaryName(value: string): boolean {
  return BINARY_NAME_RE.test(value);
}

/**
 * Reject an install context the renderer cannot prove safe. Returns a human-readable reason,
 * or `null` when every field is within its character class.
 */
export function validateInstallContext(ctx: InstallContext): string | null {
  if (!BINARY_NAME_RE.test(ctx.binaryName))
    return `unsafe binaryName: ${JSON.stringify(ctx.binaryName)}`;
  if (!ORIGIN_RE.test(ctx.origin))
    return `unsafe origin: ${JSON.stringify(ctx.origin)}`;
  if (!PRODUCT_PATH_RE.test(ctx.cliBase))
    return `unsafe cliBase: ${JSON.stringify(ctx.cliBase)}`;
  if (!PRODUCT_PATH_RE.test(ctx.installPath))
    return `unsafe installPath: ${JSON.stringify(ctx.installPath)}`;
  if (!VERSION_ENV_RE.test(ctx.versionEnv))
    return `unsafe versionEnv: ${JSON.stringify(ctx.versionEnv)}`;
  return null;
}

/** Substitute the supported `{{...}}` placeholders in an operator-provided template. */
export function applyInstallTemplate(
  template: string,
  ctx: InstallContext,
): string {
  const channelsList = ctx.channels.join(" ");
  return template
    .replace(/\{\{\s*binaryName\s*\}\}/g, ctx.binaryName)
    .replace(/\{\{\s*origin\s*\}\}/g, ctx.origin)
    .replace(/\{\{\s*cliBase\s*\}\}/g, ctx.cliBase)
    .replace(/\{\{\s*installPath\s*\}\}/g, ctx.installPath)
    .replace(/\{\{\s*versionEnv\s*\}\}/g, ctx.versionEnv)
    .replace(/\{\{\s*channels\s*\}\}/g, channelsList);
}

/**
 * The built-in installer (used when a product has no `install_template`). Does
 * arch-detection + writable-dir selection, parameterized by binary name and origin.
 *
 * Throws if the context is outside the safe character classes — call `renderInstallScript`
 * (or `validateInstallContext`) rather than relying on the throw.
 */
export function defaultInstallScript(ctx: InstallContext): string {
  const reason = validateInstallContext(ctx);
  if (reason) throw new Error(`refusing to render install.sh: ${reason}`);
  const { origin, cliBase, installPath, binaryName, versionEnv } = ctx;
  return `#!/bin/sh
# ${binaryName} installer — ${origin}
#
# Usage:
#   curl -fsSL ${origin}${installPath} | sh
#
# Install a specific version (defaults to the latest release):
#   curl -fsSL ${origin}${installPath} | ${versionEnv}=1.2.3 sh
#
# Install a testing channel (coexists with stable; installs ${binaryName}-<channel>):
#   curl -fsSL ${origin}${installPath} | ${versionEnv}=beta sh
#   curl -fsSL ${origin}${installPath} | ${versionEnv}=pr-42 sh
set -eu

ORIGIN=${shQuote(origin)}
CLI_BASE=${shQuote(cliBase)}
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
SHA_URL="$URL?checksum=sha256"
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
EXPECTED_SHA256=""
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar -o "$TMP" "$URL"
  EXPECTED_SHA256="$(curl -fsSL "$SHA_URL" 2>/dev/null || true)"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP" "$URL"
  EXPECTED_SHA256="$(wget -q -O - "$SHA_URL" 2>/dev/null || true)"
else
  echo "Error: neither curl nor wget is available." >&2
  exit 1
fi

# --- Verify integrity (fail closed) ---------------------------------------
# No published checksum means we refuse to install: an unverifiable binary is not
# installed "anyway", it is an error.
EXPECTED_SHA256="$(printf '%s' "$EXPECTED_SHA256" | tr -d '[:space:]')"
if [ -z "$EXPECTED_SHA256" ]; then
  echo "Error: no published SHA-256 checksum for $NAME ($VERSION, $ARCH)." >&2
  echo "Refusing to install an unverified binary. Expected: $SHA_URL" >&2
  exit 1
fi
if command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(shasum -a 256 "$TMP" | awk '{ print $1 }')"
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$TMP" | awk '{ print $1 }')"
elif command -v openssl >/dev/null 2>&1; then
  ACTUAL_SHA256="$(openssl dgst -sha256 "$TMP" | awk '{ print $NF }')"
else
  echo "Error: no SHA-256 tool found (shasum, sha256sum, or openssl)." >&2
  echo "Refusing to install an unverified binary." >&2
  exit 1
fi
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "Error: CHECKSUM MISMATCH for $NAME — the download does not match the" >&2
  echo "published checksum. This binary was NOT installed." >&2
  echo "  expected: $EXPECTED_SHA256" >&2
  echo "  actual:   $ACTUAL_SHA256" >&2
  exit 1
fi
echo "Verified SHA-256 $ACTUAL_SHA256"

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

/**
 * Render the installer for a product: template if present, else the built-in script.
 * Returns `null` when the context is outside the safe character classes, so callers fail
 * closed (404) instead of serving a script built from an unvalidated value.
 */
export function renderInstallScript(
  template: string | null | undefined,
  ctx: InstallContext,
): string | null {
  if (validateInstallContext(ctx)) return null;
  if (template && template.trim()) return applyInstallTemplate(template, ctx);
  return defaultInstallScript(ctx);
}
