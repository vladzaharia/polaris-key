class_name PKeyApkBridge
extends PKeyNativeBridge
## The Android direct-build updater (P5-06): PackageInstaller through the PolarisKeyAndroid plugin
## (PKeyAndroid, direct flavour). It is available only on a direct-flavour Android build with the
## plugin, which is what lets the decision offer `binary {method: native}` there. Installing needs
## the verified release record, which this bridge interface does not carry, so the direct adapter
## routes `native` on Android to PKeyUpdater.install_apk(check) (PKeyApkUpdate) instead of
## install_and_relaunch(); without the plugin, or on a play build, the adapter opens the build's
## download link.

const BRIDGE_ID := "apk"

## The Android facade (PKeyAndroid.shared() when null; tests inject one).
var android: PKeyAndroid = null


func id() -> String:
	return BRIDGE_ID


func _android() -> PKeyAndroid:
	return android if android != null else PKeyAndroid.shared()


func is_available() -> bool:
	return _android().installer_availability().ok


## Nothing to check natively: the update decision is the check.
func check_now() -> PKeyApplyResult:
	return _unsupported()


## Not used: the adapter installs through PKeyUpdater.install_apk(check), which has the record.
func install_and_relaunch() -> PKeyApplyResult:
	return _unsupported()


func _unsupported() -> PKeyApplyResult:
	var gate := _android().installer_availability()
	if not gate.ok:
		return PKeyApplyResult.failed(gate.code, gate.message, gate.detail)
	return PKeyApplyResult.failed(PKeyErrors.UNSUPPORTED, "The apk bridge installs through PKeyUpdater.install_apk(check).", {"feature": PKeyConstants.Feature.UPDATE_DRIVER, "reason": PKeyConstants.UnsupportedReason.RUNTIME, "bridge": id()})
