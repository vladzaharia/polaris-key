// pkey_apple: the Godot binding of PolarisKeyPlatform (P5-05), as a GDExtension written against
// Godot's stable C interface only: no godot-cpp, no SwiftGodot (notes/S-09 §Results 4).
//
// It registers ONE abstract class, PolarisKeyApple, with ONE static method:
//
//     PolarisKeyApple.cmd(json: String) -> String
//
// Every request except {"op":"poll"} is forwarded to PolarisKeyPlatform's C surface
// (pkp_call). {"op":"poll"} drains the events that Swift pushed through pkp_set_event_callback,
// from ANY thread, into a locked queue: {"ok":true,"events":[…]}. The GDScript facade
// (addons/polaris_key/native/pkey_apple.gd, PKeyApple) polls once per frame on the main thread
// and declares and emits the signals, so no Swift or Objective-C code ever calls into the engine
// from a StoreKit or Background Assets callback thread.
//
// Why this shape: one static method is the smallest surface of the C interface, which is
// ABI-stable across Godot 4.x minors (notes/E4 §2.2), while engine-header-linked `.gdip` plugins
// break across minors. godot-cpp or SwiftGodot would tie the build to one `extension_api.json`
// and add megabytes for no gain here. The class is registered with
// `classdb_register_extension_class6` (Godot 4.7+) when the engine has it, else `…5` (4.5–4.6) or
// `…4` (4.4), whose creation-info struct is the same frozen layout, so one binary loads on 4.4
// and later (`compatibility_minimum = "4.4"` in pkey_apple.gdextension). The S-09 probe used
// `…6` alone, which a 4.5 or 4.6 engine does not have.

#import <Foundation/Foundation.h>
#include <stdlib.h>
#include <string.h>

#include "gdextension_interface.h"

extern char *pkp_call(const char *json);
extern void pkp_free(char *p);
extern void pkp_set_event_callback(void (*cb)(const char *json));

// ---------------------------------------------------------------------------------------------
// The event queue (any thread in, the engine main thread out)

// A host that stops polling must not grow memory without bound: the oldest events are dropped
// past this many, and the next poll says how many with "dropped".
#define PKEY_APPLE_QUEUE_LIMIT 1024

static NSMutableArray<NSString *> *g_events;
static NSLock *g_lock;
static unsigned long g_dropped;

static void on_event(const char *json) {
    NSString *s = [NSString stringWithUTF8String:json];
    if (!s) return;
    [g_lock lock];
    [g_events addObject:s];
    if (g_events.count > PKEY_APPLE_QUEUE_LIMIT) {
        NSUInteger over = g_events.count - PKEY_APPLE_QUEUE_LIMIT;
        [g_events removeObjectsInRange:NSMakeRange(0, over)];
        g_dropped += over;
    }
    [g_lock unlock];
}

static BOOL is_poll(const char *json) {
    NSData *d = [NSData dataWithBytesNoCopy:(void *)json length:strlen(json) freeWhenDone:NO];
    id q = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
    return [q isKindOfClass:NSDictionary.class] && [((NSDictionary *)q)[@"op"] isEqual:@"poll"];
}

static char *pkey_apple_cmd_c(const char *json) {
    @autoreleasepool {
        if (is_poll(json)) {
            [g_lock lock];
            NSArray<NSString *> *out = [g_events copy];
            [g_events removeAllObjects];
            unsigned long dropped = g_dropped;
            g_dropped = 0;
            [g_lock unlock];
            NSString *joined = [NSString stringWithFormat:@"{\"ok\":true,\"dropped\":%lu,\"events\":[%@]}", dropped,
                                                          [out componentsJoinedByString:@","]];
            return strdup(joined.UTF8String);
        }
        char *r = pkp_call(json);
        char *copy = strdup(r ? r : "{\"ok\":false,\"error\":\"bad_json\"}");
        pkp_free(r);
        return copy;
    }
}

// ---------------------------------------------------------------------------------------------
// GDExtension glue (C interface only)

static GDExtensionInterfaceStringNewWithUtf8Chars s_new_utf8;
static GDExtensionInterfaceStringToUtf8Chars s_to_utf8;
static GDExtensionInterfaceStringNameNewWithLatin1Chars sn_new;
static GDExtensionInterfaceClassdbRegisterExtensionClass6 reg_class6;
static GDExtensionInterfaceClassdbRegisterExtensionClass4 reg_class4; // also …5: same struct
static GDExtensionInterfaceClassdbRegisterExtensionClassMethod reg_method;
static GDExtensionInterfaceClassdbUnregisterExtensionClass unreg_class;
static GDExtensionVariantFromTypeConstructorFunc variant_from_string;
static GDExtensionTypeFromVariantConstructorFunc string_from_variant;
static GDExtensionPtrDestructor string_dtor;
static GDExtensionClassLibraryPtr g_library;

typedef struct { uint8_t opaque[8]; } GStr;   // godot::String is one pointer
typedef struct { uint8_t opaque[8]; } GSName; // godot::StringName is one pointer

static GSName g_class_name;

static char *gstr_to_c(const void *s) {
    GDExtensionInt n = s_to_utf8(s, NULL, 0);
    char *buf = malloc((size_t)n + 1);
    s_to_utf8(s, buf, n);
    buf[n] = 0;
    return buf;
}

static void run_cmd(const void *arg_str, void *r_str_uninit) {
    char *in = gstr_to_c(arg_str);
    char *out = pkey_apple_cmd_c(in);
    s_new_utf8(r_str_uninit, out);
    free(in);
    free(out);
}

static void cmd_call(void *ud, GDExtensionClassInstancePtr inst, const GDExtensionConstVariantPtr *args,
                     GDExtensionInt argc, GDExtensionVariantPtr r_ret, GDExtensionCallError *r_err) {
    (void)ud;
    (void)inst;
    if (argc < 1) {
        r_err->error = GDEXTENSION_CALL_ERROR_TOO_FEW_ARGUMENTS;
        r_err->expected = 1;
        return;
    }
    GStr in, out;
    string_from_variant(&in, (GDExtensionVariantPtr)args[0]);
    run_cmd(&in, &out);
    variant_from_string(r_ret, &out);
    string_dtor(&in);
    string_dtor(&out);
    r_err->error = GDEXTENSION_CALL_OK;
}

static void cmd_ptrcall(void *ud, GDExtensionClassInstancePtr inst, const GDExtensionConstTypePtr *args,
                        GDExtensionTypePtr r_ret) {
    (void)ud;
    (void)inst;
    // r_ret is an already-constructed String: destroy it, then construct the result in place.
    string_dtor(r_ret);
    run_cmd(args[0], r_ret);
}

static void initialize(void *userdata, GDExtensionInitializationLevel level) {
    (void)userdata;
    if (level != GDEXTENSION_INITIALIZATION_SCENE) return;

    g_events = [NSMutableArray array];
    g_lock = [NSLock new];
    pkp_set_event_callback(on_event);

    static GSName parent_name, method_name, empty_sn, arg_name;
    static GStr empty_s;
    sn_new(&g_class_name, "PolarisKeyApple", 1);
    sn_new(&parent_name, "Object", 1);
    sn_new(&method_name, "cmd", 1);
    sn_new(&empty_sn, "", 1);
    sn_new(&arg_name, "json", 1);
    s_new_utf8(&empty_s, "");

    if (reg_class6) {
        GDExtensionClassCreationInfo6 ci;
        memset(&ci, 0, sizeof ci);
        ci.is_abstract = 1;
        ci.is_exposed = 1;
        reg_class6(g_library, &g_class_name, &parent_name, &ci);
    } else {
        GDExtensionClassCreationInfo4 ci;
        memset(&ci, 0, sizeof ci);
        ci.is_abstract = 1;
        ci.is_exposed = 1;
        reg_class4(g_library, &g_class_name, &parent_name, &ci);
    }

    static GDExtensionPropertyInfo ret_info, arg_info;
    ret_info = (GDExtensionPropertyInfo){GDEXTENSION_VARIANT_TYPE_STRING, &empty_sn, &empty_sn, 0, &empty_s, 6};
    arg_info = (GDExtensionPropertyInfo){GDEXTENSION_VARIANT_TYPE_STRING, &arg_name, &empty_sn, 0, &empty_s, 6};
    static GDExtensionClassMethodArgumentMetadata arg_meta = GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE;

    GDExtensionClassMethodInfo mi;
    memset(&mi, 0, sizeof mi);
    mi.name = &method_name;
    mi.call_func = cmd_call;
    mi.ptrcall_func = cmd_ptrcall;
    mi.method_flags = GDEXTENSION_METHOD_FLAG_NORMAL | GDEXTENSION_METHOD_FLAG_STATIC;
    mi.has_return_value = 1;
    mi.return_value_info = &ret_info;
    mi.return_value_metadata = GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE;
    mi.argument_count = 1;
    mi.arguments_info = &arg_info;
    mi.arguments_metadata = &arg_meta;
    reg_method(g_library, &g_class_name, &mi);
}

static void deinitialize(void *userdata, GDExtensionInitializationLevel level) {
    (void)userdata;
    if (level != GDEXTENSION_INITIALIZATION_SCENE) return;
    pkp_set_event_callback(NULL);
    if (unreg_class) unreg_class(g_library, &g_class_name);
}

__attribute__((visibility("default"))) GDExtensionBool
pkey_apple_library_init(GDExtensionInterfaceGetProcAddress gpa, GDExtensionClassLibraryPtr lib,
                        GDExtensionInitialization *r_init) {
    g_library = lib;
    s_new_utf8 = (GDExtensionInterfaceStringNewWithUtf8Chars)gpa("string_new_with_utf8_chars");
    s_to_utf8 = (GDExtensionInterfaceStringToUtf8Chars)gpa("string_to_utf8_chars");
    sn_new = (GDExtensionInterfaceStringNameNewWithLatin1Chars)gpa("string_name_new_with_latin1_chars");
    reg_class6 = (GDExtensionInterfaceClassdbRegisterExtensionClass6)gpa("classdb_register_extension_class6");
    reg_class4 = (GDExtensionInterfaceClassdbRegisterExtensionClass4)gpa("classdb_register_extension_class5");
    if (!reg_class4) reg_class4 = (GDExtensionInterfaceClassdbRegisterExtensionClass4)gpa("classdb_register_extension_class4");
    reg_method = (GDExtensionInterfaceClassdbRegisterExtensionClassMethod)gpa("classdb_register_extension_class_method");
    unreg_class = (GDExtensionInterfaceClassdbUnregisterExtensionClass)gpa("classdb_unregister_extension_class");
    GDExtensionInterfaceGetVariantFromTypeConstructor vft =
        (GDExtensionInterfaceGetVariantFromTypeConstructor)gpa("get_variant_from_type_constructor");
    GDExtensionInterfaceGetVariantToTypeConstructor vtt =
        (GDExtensionInterfaceGetVariantToTypeConstructor)gpa("get_variant_to_type_constructor");
    GDExtensionInterfaceVariantGetPtrDestructor vpd =
        (GDExtensionInterfaceVariantGetPtrDestructor)gpa("variant_get_ptr_destructor");
    if (!s_new_utf8 || !s_to_utf8 || !sn_new || (!reg_class6 && !reg_class4) || !reg_method || !vft || !vtt || !vpd) return 0;
    variant_from_string = vft(GDEXTENSION_VARIANT_TYPE_STRING);
    string_from_variant = vtt(GDEXTENSION_VARIANT_TYPE_STRING);
    string_dtor = vpd(GDEXTENSION_VARIANT_TYPE_STRING);

    r_init->minimum_initialization_level = GDEXTENSION_INITIALIZATION_SCENE;
    r_init->userdata = NULL;
    r_init->initialize = initialize;
    r_init->deinitialize = deinitialize;
    return 1;
}
