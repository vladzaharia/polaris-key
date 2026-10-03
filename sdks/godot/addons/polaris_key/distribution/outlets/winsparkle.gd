class_name PKeyWinSparkleBridge
extends PKeyNativeBridge
## WinSparkle on Windows (notes/E3 §A3: it needs a GDExtension): the fallback native updater for a
## direct Windows build without Velopack. The feed is P3-09's WinSparkle appcast for this channel
## (`update.endpoints.winsparkle`, `…/update/{channel}/winsparkle.xml`). The native side is P5-07's
## PKeyWinSparkle facade over the Windows GDExtension's `PKeyWinSparkleNative` (or an Engine
## singleton `PolarisKeyWinSparkle`); it needs the EdDSA public key in `options.public_key`
## (PKeyOptions.update_eddsa_public_key). Without the extension or WinSparkle.dll every call
## answers `unsupported` (`dependency`; `runtime` off Windows) and the adapter opens the build's
## download link instead.


func id() -> String:
	return "winsparkle"


func singleton_name() -> String:
	return "PolarisKeyWinSparkle"


func make_facade() -> PKeyNativeFacade:
	return PKeyWinSparkle.new(env)
