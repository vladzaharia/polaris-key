class_name PKeySparkleBridge
extends PKeyNativeBridge
## Sparkle 2 on macOS (README §5.6 option 1, §5.10): `binary {method: native}` on a direct macOS
## build hands the update to Sparkle (`SPUStandardUpdaterController`), which keeps the code
## signature valid and relaunches. The feed is Update's appcast for this channel and arch
## (`update.endpoints.appcast`, PolarisKey.update.appcast_url()). The native side is P5-07's
## PKeySparkle facade over the `PKeySparkleNative` GDExtension (or an Engine singleton
## `PolarisKeySparkle` a game registers itself); without the extension every call answers
## `unsupported` (`dependency`; `runtime` off macOS) and the adapter opens the build's download
## link instead.


func id() -> String:
	return "sparkle"


func singleton_name() -> String:
	return "PolarisKeySparkle"


func make_facade() -> PKeyNativeFacade:
	return PKeySparkle.new(env)
