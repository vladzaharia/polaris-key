class_name PKeyDirectAdapter
extends PKeyOutletAdapter
## The direct outlet (`binaryUpdates: self`): the game's own download, on any platform. It is the
## only outlet that installs anything itself, and `binary` dispatches on `method`:
##
##   native       the platform's native updater through its bridge (`ctx.native_bridge`: Sparkle on
##                macOS, Velopack then WinSparkle on Windows, AppImageUpdate in an AppImage, else
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
