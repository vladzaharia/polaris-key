class_name PKeyPortalStore
extends RefCounted
## The client's holder of discovery's `core.portal` (port of the Python `PortalStore`): the member
## from this session's discovery, else the last one persisted as `portal.json` directly in the
## product's cache directory, so the product page survives a cold start. It lives beside the
## presentation cache and shares its root.
##
## The file is `{v, product, baseUrl, portal}`. A file that does not parse, names another product
## or base, or does not read back exactly as `PKeyPortal.parse_portal` normalises it is deleted.

const MEMBER_FILE := "portal.json"
const MEMBER_FILE_VERSION := 1

## Where `portal.json` lives. attach() sets it from the Core's storage namespace.
var cache_dir := PKeyPresentationSource.CACHE_DIR
var product := ""
var base_url := ""

var _current = null
var _discovered := false
var _generated_cache_dir := ""


## Bind to a configured Core (kept in its `portal_source` meta, which discover() feeds). A new product drops the old member.
func attach(core: PKeyCore) -> void:
	var generated: String = PKeyPresentationSource.CACHE_DIR if core.storage_namespace == core.product else PKeyPresentationSource.CACHE_DIR.path_join(core.storage_namespace)
	if cache_dir == PKeyPresentationSource.CACHE_DIR or cache_dir == _generated_cache_dir:
		cache_dir = generated
	_generated_cache_dir = generated
	if (product != "" and product != core.product) or (base_url != "" and base_url != core.base_url):
		_discovered = false
		_current = null
	product = core.product
	base_url = core.base_url
	core.set_meta(&"portal_source", self)


## The held member (`{enabled: false}`, `{enabled: true, activate: link or null}`), or null for
## unknown.
func current() -> Variant:
	return _current.duplicate(true) if _current is Dictionary else null


## Cold start: the member `portal.json` holds, unless this session already discovered one.
func load_cached() -> void:
	if _discovered:
		return
	var m = _read()
	if m != null and not _discovered:
		_current = m


## A successful discovery's document: parse, store and persist. No member (or an invalid one)
## clears it.
func accept(manifest: Variant) -> void:
	var m = PKeyPortal.parse_portal(manifest.get("core")) if manifest is Dictionary else null
	_discovered = true
	_current = m.duplicate(true) if m is Dictionary else null
	_write(m)


static func _wire(m: Dictionary) -> Dictionary:
	if m.get("enabled") == true and m.get("activate") != null:
		return {"enabled": true, "activate": m["activate"]}
	return {"enabled": m.get("enabled") == true}


func _path() -> String:
	return cache_dir.path_join(MEMBER_FILE)


func _write(m: Variant) -> void:
	if m == null:
		_remove(_path())
		return
	if DirAccess.make_dir_recursive_absolute(cache_dir) != OK:
		return
	var body := PKeyJson.stringify({"v": MEMBER_FILE_VERSION, "product": product, "baseUrl": base_url, "portal": _wire(m)}).to_utf8_buffer()
	var tmp := "%s.tmp-%s" % [MEMBER_FILE, Crypto.new().generate_random_bytes(6).hex_encode()]
	var f := FileAccess.open(cache_dir.path_join(tmp), FileAccess.WRITE)
	if f == null:
		return
	f.store_buffer(body)
	var err := f.get_error()
	f.close()
	var d := DirAccess.open(cache_dir)
	if err == OK and d != null:
		err = d.rename(tmp, MEMBER_FILE)
	if err != OK:
		_remove(cache_dir.path_join(tmp))


func _read() -> Variant:
	var path := _path()
	if not FileAccess.file_exists(path):
		return null
	var parsed := PKeyJson.parse_bytes(FileAccess.get_file_as_bytes(path))
	var value = parsed.get("value") if parsed["ok"] else null
	var m = null
	if value is Dictionary and value.get("v") is float and int(value["v"]) == MEMBER_FILE_VERSION and product != "" and value.get("product") == product and value.get("baseUrl") == base_url:
		m = PKeyPortal.parse_portal({"portal": value.get("portal")})
		if m != null and not PKeyPresentationSource.same(_wire(m), value.get("portal")):
			m = null
	if m == null:
		_remove(path)
	return m


static func _remove(path: String) -> void:
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)
