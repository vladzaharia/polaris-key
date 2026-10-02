class_name PKeyStoreAdapter
extends PKeyOutletAdapter
## The store outlets (`binaryUpdates: store`): App Store, TestFlight, AltStore, AltStore PAL,
## Play, Play testing, Obtainium, F-Droid repos and the Microsoft Store. A `store` answer opens
## the decision's `listingUrl` (the feed may carry one only under the plan's prefixes for its
## kind, plans/P3-01.md §2.9) when it is https; otherwise, and always for AltStore, Obtainium and
## F-Droid (whose feeds carry no listing), the page compiled into the game
## (PKeyOptions.update_page_url: the AltStore source, the repository or the store page). A
## `blocked` answer opens that page when there is one. Nothing else acts: a store build never
## downloads or swaps anything. The iOS store sheet (P5-05) and Play In-App Updates (P5-06)
## extend these adapters.

## The PKeyUiCopy key of the action button.
var action_key := "update_store"


func describe(decision: Dictionary, ctx: Dictionary) -> Dictionary:
	match decision.get("action"):
		"store":
			return link_or_silent(first_https([decision.get("listingUrl"), ctx.get("page_url", "")]), action_key)
		"blocked":
			return link_or_silent(String(ctx.get("page_url", "")), action_key)
	return plan(PKeyApplyResult.SILENT)
