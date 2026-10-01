class_name PKeyConfigEnv
extends RefCounted
## The environment layer of config resolution, as a game has it (notes/A2 §11):
##
##   - `OS.get_environment(prefix + key.replace(".", "__"))`, the `PKEY_CONFIG_*` convention
##     every SDK shares. A per-key lookup: nothing enumerates the environment;
##   - `--pkey-config key=value` user arguments (after `--` on the command line; on web the
##     export's HTML shell can pass them). They name the KEY, not the variable, and beat a
##     variable for the same key, being the more explicit of the two. Both spellings work:
##     `--pkey-config key=value` and `--pkey-config=key=value`; a later one wins.
##
## Either value goes through client-core's looksLikeJson rule (PKeyConfigResolve).
##
## Whether the layer is on (PKeyOptions.config_env_layer):
##   CONFIG_ENV_AUTO    on in debug builds and on desktop; OFF in a release build on mobile or
##                      web, where nothing legitimate sets it
##   CONFIG_ENV_ALWAYS  on everywhere
##   CONFIG_ENV_NEVER   off everywhere
## It can only ever change a `default` key: enforced and hidden keys ignore it. A macOS app
## launched from Finder has no shell environment, so there the arguments are the way in.

const ARG := "--pkey-config"
const MOBILE_AND_WEB := ["android", "ios", "web"]

var prefix := PKeyConfigResolve.DEFAULT_ENV_PREFIX
var enabled := true
## var_name -> raw value, from the user arguments.
var args := {}
## `Callable(name) -> Variant` reading the process environment (null when unset). Tests inject.
var reader: Callable = func(name: String) -> Variant:
	return OS.get_environment(name) if OS.has_environment(name) else null


## The layer for this process: the mode from PKeyOptions, the build and platform it runs on,
## and the user arguments. `is_debug`, `platform` and `user_args` are injectable for tests.
static func for_process(mode: int, p_prefix: String, is_debug := OS.is_debug_build(), platform := PKeyHeaders.platform(), user_args := OS.get_cmdline_user_args()) -> PKeyConfigEnv:
	var e := PKeyConfigEnv.new()
	e.prefix = p_prefix if p_prefix != "" else PKeyConfigResolve.DEFAULT_ENV_PREFIX
	e.enabled = layer_enabled(mode, is_debug, platform)
	e.args = parse_args(user_args, e.prefix)
	return e


static func layer_enabled(mode: int, is_debug: bool, platform: String) -> bool:
	match mode:
		PKeyOptions.CONFIG_ENV_ALWAYS:
			return true
		PKeyOptions.CONFIG_ENV_NEVER:
			return false
	return is_debug or not MOBILE_AND_WEB.has(platform)


## `--pkey-config key=value` pairs as {var_name: raw}. A pair without `=` or with an empty key is
## ignored.
static func parse_args(user_args: PackedStringArray, p_prefix: String) -> Dictionary:
	var out := {}
	var i := 0
	while i < user_args.size():
		var a := user_args[i]
		var pair := ""
		if a == ARG and i + 1 < user_args.size():
			pair = user_args[i + 1]
			i += 1
		elif a.begins_with(ARG + "="):
			pair = a.substr(ARG.length() + 1)
		i += 1
		var at := pair.find("=")
		if at > 0:
			out[PKeyConfigResolve.env_var_name(p_prefix, pair.substr(0, at).strip_edges())] = pair.substr(at + 1)
	return out


## The `env` Callable for a PKeyConfigResolve.Context: null when the layer is off.
func lookup(name: String) -> Variant:
	if not enabled:
		return null
	if args.has(name):
		return args[name]
	return reader.call(name)
