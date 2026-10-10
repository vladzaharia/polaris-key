class_name PKeyVelopackBridge
extends PKeyNativeBridge
## Velopack on Windows and Linux (README §5.6 option 1; S-05 §4.5): `binary {method: native}` on
## a Velopack install hands the update to Velopack's UpdateManager, which downloads the full or
## delta package, applies it and relaunches. The feed is the directory of P3-09's Velopack route
## for this channel (`update.endpoints.velopack` up to `releases.{velopackChannel}.json`;
## UpdateManager appends the file name itself), and `velopack_channel` is the channel the app was
## packed with (`win`, `osx`, `linux`, optionally `-x64` / `-arm64`).
##
## A Velopack install ships P5-07's launcher shim as `--mainExe`, which answers the
## `--veloapp-*` hooks in milliseconds without starting the engine. An update replaces the whole
## app directory, so a Velopack install never takes a sidecar-PCK swap (PKeySidecarSwap refuses
## `velopack`). The native side is P5-07's PKeyVelopack facade over the Windows GDExtension's
## `PKeyVelopackNative` (or an Engine singleton `PolarisKeyVelopack`); without it every call
## answers `unsupported` (`dependency`; `runtime` off Windows or outside a Velopack install) and
## the adapter opens the build's download link.

## Automatic installation currently returns unsupported/runtime: feed-controlled checksums
## cannot authorize executable bytes. The adapter retains its manual download-link fallback.

## The channel the app was packed with (`vpk pack --channel`).
var velopack_channel := ""


func id() -> String:
	return "velopack"


func singleton_name() -> String:
	return "PolarisKeyVelopack"


func make_facade() -> PKeyNativeFacade:
	return PKeyVelopack.new(env)
