// The Windows GDExtension's entry point (P5-07): one DLL, four classes (SP-27 added the
// Credential Manager one). None of them
// import-links an updater library, so the extension always loads and each facade answers for
// itself (velopack_libc.dll and WinSparkle.dll are loaded at run time; StoreContext is part of
// Windows).
#include "pkey_win_common.h"

#include <gdextension_interface.h>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/defs.hpp>
#include <godot_cpp/godot.hpp>

using namespace godot;

static void pkey_win_initialize(ModuleInitializationLevel level) {
  if (level != MODULE_INITIALIZATION_LEVEL_SCENE) return;
  pkey_win::register_velopack();
  pkey_win::register_winsparkle();
  pkey_win::register_storecontext();
  pkey_win::register_credman();
}

static void pkey_win_uninitialize(ModuleInitializationLevel level) {
  if (level != MODULE_INITIALIZATION_LEVEL_SCENE) return;
  // WinSparkle's threads must stop before the process tears the DLL down.
  pkey_win::winsparkle_shutdown();
}

extern "C" GDExtensionBool GDE_EXPORT pkey_win_init(GDExtensionInterfaceGetProcAddress p_get_proc_address,
                                                    GDExtensionClassLibraryPtr p_library,
                                                    GDExtensionInitialization *r_initialization) {
  GDExtensionBinding::InitObject init_obj(p_get_proc_address, p_library, r_initialization);
  init_obj.register_initializer(pkey_win_initialize);
  init_obj.register_terminator(pkey_win_uninitialize);
  init_obj.set_minimum_library_initialization_level(MODULE_INITIALIZATION_LEVEL_SCENE);
  return init_obj.init();
}
