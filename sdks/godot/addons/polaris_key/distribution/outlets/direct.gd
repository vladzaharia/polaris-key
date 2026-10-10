class_name PKeyDirectAdapter
extends PKeyOutletAdapter
## The direct outlet (`binaryUpdates: self`): the game's own download, on any platform. It is the
## only outlet that installs anything itself, and `binary` dispatches on `method`:
##
##   native       the platform's native updater through its bridge (`ctx.native_bridge`: Sparkle on
##                macOS, Velopack then WinSparkle on Windows, the verified AppImage installer, else
##                Velopack on Linux). With no plugin installed the bridge answers `unsupported`
##                (`dependency`) and the adapter opens the build's download link instead
##   download     the build's download URL (discovery's `distribution.endpoints.builds` with
##                `{selector}` = the record's version and `{buildId}` = the decision's build),
##                else the game's release page
##   sidecar-pck  download, verify and stage the record's code pack in the background
##                (PKeySidecarSwap); the next decision answers `code-ready`
##
## `code-ready` restarts into the staged pack ("Restart to update"). On iOS `direct` is Web
## Distribution, narrowed to `store`: the answer opens the web-distribution page
## (PKeyOptions.update_page_url) or a listing. A package-managed install (Homebrew, Scoop,
## Flatpak, …) is narrowed to `platform`: silent, with the package manager's message. `blocked`
## opens the release page when the game gave one.


func _init() -> void:
	kind = "direct"


## `binary {method: native}` on Android goes to PKeyUpdater.install_apk(check) (the verified
## PackageInstaller update, P5-06), which needs the record; the download link is opened only when the
## plugin answers unsupported. Everything else is the base adapter's.
func apply(decision: Dictionary, host: Object, check: PKeyUpdateCheck = null) -> PKeyApplyResult:
	if decision.get("action") == "binary" and decision.get("method") == "native" and host != null and host.has_method("install_apk"):
		var ctx: Dictionary = host.context(decision) if host.has_method("context") else {}
		var p := describe(decision, ctx)
		if p["behaviour"] == PKeyApplyResult.HOOK and p["bridge"] == PKeyApkBridge.BRIDGE_ID:
			if check == null:
				return PKeyApplyResult.failed(PKeyErrors.INVALID_OPTIONS, "Installing an APK needs the PKeyUpdateCheck (its verified record).")
			var r: PKeyApplyResult = await host.install_apk(check)
			if r.ok or r.code != PKeyErrors.UNSUPPORTED or p["fallback_url"] == "":
				return r
			var link := _open(host, p["fallback_url"])
			link.detail = {"url": p["fallback_url"], "fallback_from": p["bridge"], "hook_code": String(r.code)}
			return link
	return await super(decision, host, check)


func describe(decision: Dictionary, ctx: Dictionary) -> Dictionary:
	var build_url := String(ctx.get("build_url", ""))
	var release_url := String(ctx.get("release_url", ""))
	match decision.get("action"):
		"code-ready":
			return plan(PKeyApplyResult.RESTART, "update_restart")
		"binary":
			var download := first_https([build_url, release_url])
			match decision.get("method"):
				"native":
					var bridge := String(ctx.get("native_bridge", ""))
					if bridge != "" and ctx.get("native_available") == true:
						return plan(PKeyApplyResult.HOOK, "update_install", "", "", bridge, download)
					return link_or_silent(download, "update_action")
				"download":
					return link_or_silent(download, "update_action")
				"sidecar-pck":
					return plan(PKeyApplyResult.STAGED, "update_download")
		"store":
			return link_or_silent(first_https([decision.get("listingUrl"), ctx.get("page_url", "")]), "update_action")
		"platform":
			return plan(PKeyApplyResult.SILENT, "", "", "update_platform_package")
		"blocked":
			return link_or_silent(first_https([release_url, ctx.get("page_url", "")]), "update_action")
	return plan(PKeyApplyResult.SILENT)
