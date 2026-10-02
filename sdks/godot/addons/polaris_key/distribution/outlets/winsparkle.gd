class_name PKeyWinSparkleBridge
extends PKeyNativeBridge
## WinSparkle on Windows (notes/E3 §A3: it needs a GDExtension): the fallback native updater for a
## direct Windows build without Velopack. The feed is P3-09's WinSparkle appcast for this channel
## (`update.endpoints.winsparkle`, `…/update/{channel}/winsparkle.xml`). P5-07 ships the plugin,
## an Engine singleton `PolarisKeyWinSparkle`; without it every call answers `unsupported`
## (`dependency`) and the adapter opens the build's download link instead.


func id() -> String:
	return "winsparkle"


func singleton_name() -> String:
	return "PolarisKeyWinSparkle"
