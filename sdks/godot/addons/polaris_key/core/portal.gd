class_name PKeyPortal
extends RefCounted
## The product page link (WIRE-CONTRACT-V4 §5.7, plans/DISC-01.md), pinned by
## `conformance/corpus/v2/portal-matrix.json`. A port of `@polaris-key/client-core/portal`.
##
## Discovery's `core.portal` is UNSIGNED display data: whether the product's customer portal is on
## and, while it is, the product page `<customer origin>/activate?product=<slug>`.
##
##   parse_portal(core)                   the member as a whole (`parseCases`): null for unknown,
##                                        {enabled = false}, or {enabled = true, activate = link or null}
##   portal_link(served, portal, base_url, product)
##                                        the one link a kit draws (`linkCases`): the response's own
##                                        link, then discovery's member, then the legacy guess against
##                                        a Worker that sends none. null is no link: the kit draws
##                                        "Contact {developer}"
##
## A link that fails §5.3 rule 4 is no link, never repaired and never replaced by a guess once the
## Worker has answered. A client never adds `#key=` to it.


## `core.portal` of a discovery document's `core` block, or null when it says nothing usable (an
## older Worker, or a malformed member): "unknown", which is not "off".
static func parse_portal(core: Variant) -> Variant:
	if not (core is Dictionary):
		return null
	var p = core.get("portal")
	if not (p is Dictionary):
		return null
	var enabled = p.get("enabled")
	if not (enabled is bool):
		return null
	if not enabled:
		return {"enabled": false}
	var activate = p.get("activate")
	return {"enabled": true, "activate": activate if PKeyManage.is_valid(activate) else null}


## RFC 3986 unreserved characters stay; every other UTF-8 byte is `%XX`.
static func _encode_slug(value: String) -> String:
	var out := ""
	for b in value.to_utf8_buffer():
		var keep: bool = (b >= 0x30 and b <= 0x39) or (b >= 0x41 and b <= 0x5A) or (b >= 0x61 and b <= 0x7A) or b == 0x2D or b == 0x2E or b == 0x5F or b == 0x7E
		out += char(b) if keep else "%%%02X" % b
	return out


## The product page link, or null (no link). First match: a valid `served` link; the discovered
## member (off, or no usable link, is null, never the guess); the legacy
## `<origin>/activate?product=<slug>` where the Worker said nothing.
static func portal_link(served: Variant, portal: Variant, base_url: String, product: String) -> Variant:
	if PKeyManage.is_valid(served):
		return served
	if portal is Dictionary:
		return portal.get("activate") if portal.get("enabled") == true else null
	if product.is_empty():
		return null
	var base := base_url
	while base.ends_with("/"):
		base = base.left(-1)
	var origin: String = PKeyConstants.CUSTOMER_ORIGIN_DEFAULT if base == "https://" + PKeyClaims.ISSUER else base
	var link := "%s/activate?product=%s" % [origin, _encode_slug(product)]
	return link if PKeyManage.is_valid(link) else null
