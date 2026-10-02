class_name PKeySparkleBridge
extends PKeyNativeBridge
## Sparkle 2 on macOS (README §5.6 option 1, §5.10): `binary {method: native}` on a direct macOS
## build hands the update to Sparkle (`SPUStandardUpdaterController`), which keeps the code
## signature valid and relaunches. The feed is Update's appcast for this channel and arch
## (`update.endpoints.appcast`, PolarisKey.update.appcast_url()). P5-07 ships the plugin, an
## Engine singleton `PolarisKeySparkle`; without it every call answers `unsupported`
## (`dependency`) and the adapter opens the build's download link instead.


func id() -> String:
	return "sparkle"


func singleton_name() -> String:
	return "PolarisKeySparkle"
