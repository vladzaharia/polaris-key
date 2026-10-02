class_name PKeyAppInstallerAdapter
extends PKeyPlatformAdapter
## App Installer: silent; Windows updates the package from its `.appinstaller` file (P3-09's `update.endpoints.appInstaller`).


func _init() -> void:
	kind = "app-installer"
	body_key = "update_platform_app_installer"
