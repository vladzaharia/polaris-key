extends RefCounted
# The environment layer as a game has it: PKEY_CONFIG_* variables read from the real process
# environment and `--pkey-config key=value` user arguments, both resolving `dice.animSpeed` with
# source env on a desktop debug run, both ignored on a release web or mobile build unless the
# option turns the layer on, and neither able to touch an enforced key.

const S := preload("res://tests/config/support.gd")
const VAR := "PKEY_CONFIG_dice__animSpeed"


func run(t: PKeyTestContext) -> void:
	_modes(t)
	_args(t)
	await _process_env(t)
	_command_line(t)


func _modes(t: PKeyTestContext) -> void:
	var auto := PKeyOptions.CONFIG_ENV_AUTO
	t.check("env: auto is on for a desktop release build", PKeyConfigEnv.layer_enabled(auto, false, "linux") and PKeyConfigEnv.layer_enabled(auto, false, "windows") and PKeyConfigEnv.layer_enabled(auto, false, "macos"))
	t.check("env: auto is on for any debug build", PKeyConfigEnv.layer_enabled(auto, true, "web") and PKeyConfigEnv.layer_enabled(auto, true, "android") and PKeyConfigEnv.layer_enabled(auto, true, "ios"))
	t.check("env: auto is off for a release web or mobile build", not PKeyConfigEnv.layer_enabled(auto, false, "web") and not PKeyConfigEnv.layer_enabled(auto, false, "android") and not PKeyConfigEnv.layer_enabled(auto, false, "ios"))
	t.check("env: always turns it on for release web and mobile", PKeyConfigEnv.layer_enabled(PKeyOptions.CONFIG_ENV_ALWAYS, false, "web") and PKeyConfigEnv.layer_enabled(PKeyOptions.CONFIG_ENV_ALWAYS, false, "ios"))
	t.check("env: never turns it off on a desktop debug build", not PKeyConfigEnv.layer_enabled(PKeyOptions.CONFIG_ENV_NEVER, true, "linux"))
	t.check("env: the option defaults to auto", PKeyOptions.new().config_env_layer == auto and PKeyOptions.new().config_env_prefix == "PKEY_CONFIG_")


func _args(t: PKeyTestContext) -> void:
	var parsed := PKeyConfigEnv.parse_args(PackedStringArray(["--other", "--pkey-config", "dice.animSpeed=1.5", "--pkey-config=ui.theme=light", "--pkey-config", "bad", "--pkey-config=a.b=x=y", "--pkey-config"]), "PKEY_CONFIG_")
	t.check("env: --pkey-config pairs in both spellings", parsed == {"PKEY_CONFIG_dice__animSpeed": "1.5", "PKEY_CONFIG_ui__theme": "light", "PKEY_CONFIG_a__b": "x=y"}, str(parsed))
	var later := PKeyConfigEnv.parse_args(PackedStringArray(["--pkey-config", "k=1", "--pkey-config", "k=2"]), "P_")
	t.check("env: a later argument wins", later == {"P_k": "2"})


func _process_env(t: PKeyTestContext) -> void:
	var sdk: Node = await S.sdk_with({
		"dice.animSpeed": S.entry("default", 1.0),
		"ui.theme": S.entry("enforced", "dark"),
	})
	var cfg: PKeyConfig = sdk.config
	var had := OS.has_environment(VAR)
	var old := OS.get_environment(VAR)
	OS.set_environment(VAR, "1.5")
	OS.set_environment("PKEY_CONFIG_ui__theme", "light")

	cfg.env = PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_AUTO, "PKEY_CONFIG_", true, "macos", PackedStringArray())
	t.check("env: PKEY_CONFIG_dice__animSpeed=1.5 resolves on a desktop debug run", S.same(cfg.get_value("dice.animSpeed", 0.0), 1.5) and cfg.get_value("dice.animSpeed", 0.0) is float and cfg.get_source("dice.animSpeed") == &"env")
	t.check("env: an enforced key ignores the variable", cfg.get_value("ui.theme") == "dark" and cfg.get_source("ui.theme") == &"enforced")
	cfg.env = PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_AUTO, "PKEY_CONFIG_", false, "web", PackedStringArray())
	t.check("env: the variable is ignored on a release web build", cfg.get_value("dice.animSpeed", 0.0) == 1.0 and cfg.get_source("dice.animSpeed") == &"remote-default")
	cfg.env = PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_AUTO, "PKEY_CONFIG_", false, "android", PackedStringArray())
	t.check("env: the variable is ignored on a release mobile build", cfg.get_source("dice.animSpeed") == &"remote-default")
	cfg.env = PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_ALWAYS, "PKEY_CONFIG_", false, "ios", PackedStringArray())
	t.check("env: unless the option enables it", S.same(cfg.get_value("dice.animSpeed", 0.0), 1.5) and cfg.get_source("dice.animSpeed") == &"env")
	OS.unset_environment(VAR)

	var args := PackedStringArray(["--pkey-config", "dice.animSpeed=1.5"])
	cfg.env = PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_AUTO, "PKEY_CONFIG_", true, "linux", args)
	t.check("env: --pkey-config dice.animSpeed=1.5 resolves on a desktop debug run", S.same(cfg.get_value("dice.animSpeed", 0.0), 1.5) and cfg.get_source("dice.animSpeed") == &"env")
	cfg.env = PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_AUTO, "PKEY_CONFIG_", false, "web", args)
	t.check("env: --pkey-config is ignored on a release web build", cfg.get_source("dice.animSpeed") == &"remote-default")
	cfg.env = PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_AUTO, "PKEY_CONFIG_", false, "ios", args)
	t.check("env: --pkey-config is ignored on a release mobile build", cfg.get_source("dice.animSpeed") == &"remote-default")
	cfg.env = PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_ALWAYS, "PKEY_CONFIG_", false, "web", args)
	t.check("env: --pkey-config with the option on, release web", cfg.get_source("dice.animSpeed") == &"env")

	OS.set_environment(VAR, "3")
	cfg.env = PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_AUTO, "PKEY_CONFIG_", true, "linux", args)
	t.check("env: an argument beats a variable for the same key", S.same(cfg.get_value("dice.animSpeed", 0.0), 1.5))
	cfg.set_override_store(PKeyOverrideStore.new({"dice.animSpeed": 2.0}))
	t.check("env: a local override beats both", cfg.get_value("dice.animSpeed", 0.0) == 2.0 and cfg.get_source("dice.animSpeed") == &"local")

	# The options wire the layer at configure().
	var o := S.options()
	o.config_env_layer = PKeyOptions.CONFIG_ENV_NEVER
	sdk.configure(o)
	t.check("env: configure() applies config_env_layer", not sdk.config.env.enabled)
	o = S.options()
	o.config_env_prefix = "DICE_"
	o.config_env_layer = PKeyOptions.CONFIG_ENV_ALWAYS
	sdk.configure(o)
	t.check("env: configure() applies config_env_prefix", sdk.config.env.enabled and sdk.config.env.prefix == "DICE_")

	OS.unset_environment(VAR)
	OS.unset_environment("PKEY_CONFIG_ui__theme")
	if had:
		OS.set_environment(VAR, old)
	sdk.queue_free()


## Run with `-- --pkey-test config --pkey-config dice.animSpeed=1.5` to prove the real command
## line reaches the layer; otherwise this only notes that the pair was absent.
func _command_line(t: PKeyTestContext) -> void:
	var real := PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_ALWAYS, "PKEY_CONFIG_")
	if not OS.get_cmdline_user_args().has("--pkey-config"):
		t.info("env: no --pkey-config on this command line; the real-argv check is skipped")
		return
	t.check("env: the real command line's --pkey-config reaches the layer", real.lookup(VAR) == "1.5", str(real.args))
	# And through configure()'s own wiring, on this (desktop) run.
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(S.options())
	var desktop := not PKeyConfigEnv.MOBILE_AND_WEB.has(PKeyHeaders.platform()) or OS.is_debug_build()
	t.check("env: configure()'s layer resolves dice.animSpeed from the command line", not desktop or (S.same(sdk.config.get_value("dice.animSpeed", 0.0), 1.5) and sdk.config.get_source("dice.animSpeed") == &"env"))
	sdk.queue_free()
