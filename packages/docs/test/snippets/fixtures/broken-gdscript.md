# A deliberately broken GDScript page

The lane fails each of these. `PKeyNotAClass` names no class.

```gdscript
func _ready() -> void:
	await PolarisKey.boot()
	PolarisKey.noSuchMethod()
```

```gdscript no-compile
this is not gdscript
```
