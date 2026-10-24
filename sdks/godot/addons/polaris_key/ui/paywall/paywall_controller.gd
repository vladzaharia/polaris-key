class_name PKeyPaywallController
extends RefCounted
## PKeyPaywall's headless logic: the Paywall model's input from what a game knows (the tier it
## sells, whether this build can sell it, the store or the portal), the model's view, and what its
## primary button does. No node here, so a game drawing its own upsell reuses it as is.

const Models := preload("res://addons/polaris_key/ui/model/models.gd")

## What the primary button does for a copy key the model names.
const ACTION_PURCHASE := "purchase"
const ACTION_PORTAL := "portal"
const ACTION_DONE := "done"


## The model input (ui-matrix.json `paywall`). `state`: `{tier, store_purchase, can_restore,
## available, url, purchased, pending, loading, elapsed_ms, license}`; a store purchase is the
## platform's own (iOS or Android), anything else buys in the browser.
static func input(state: Dictionary) -> Dictionary:
	var out := {
		"entitlement": {"name": String(state.get("tier", "")), "entitled": false},
		"offers": {"available": bool(state.get("available", true))},
	}
	var url := String(state.get("url", ""))
	if url != "":
		out["offers"]["url"] = url
	if bool(state.get("purchased", false)):
		out["offers"]["purchased"] = true
	var caps := {}
	if bool(state.get("store_purchase", false)):
		caps["purchase"] = true
		var os := "android" if OS.get_name() == "Android" else "ios"
		out["platform"] = {"os": os, "formFactor": "phone" if os == "android" else "iphone"}
	if bool(state.get("can_restore", false)):
		caps["restore"] = true
	if not caps.is_empty():
		out["capabilities"] = caps
	if String(state.get("pending", "")) != "":
		out["pending"] = state["pending"]
	if bool(state.get("loading", false)):
		out["loading"] = true
		if state.get("elapsed_ms") != null:
			out["elapsedMs"] = state["elapsed_ms"]
	if not bool(state.get("license", true)):
		out["services"] = ["config", "release", "distribution", "update", "identity", "sync"]
	return out


static func view(inp: Dictionary) -> Dictionary:
	return Models.view_of("Paywall", inp)


## The catalog key of the primary button ("" for none).
static func primary_of(v: Dictionary) -> String:
	var p = v.get("decisions", {}).get("primary")
	return "" if p == null else String(p)


## What the primary does: purchase (the store), portal (open the https page) or done.
static func action_of(primary: String) -> String:
	match primary:
		"paywall.upgrade":
			return ACTION_PURCHASE
		"paywall.portal":
			return ACTION_PORTAL
		"common.done":
			return ACTION_DONE
	return ""
