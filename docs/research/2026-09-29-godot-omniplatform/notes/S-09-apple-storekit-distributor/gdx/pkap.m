// pkap: S-09 probe GDExtension. C-interface glue (from S-01's pkba.m) over the Swift
// PKPlatform C surface (pkp_call / pkp_set_event_callback). Registers class PolarisKeyApple with
// one static method cmd(json) -> String. {"op":"poll"} drains events that Swift pushed from any
// thread; every other op is forwarded to pkp_call. Godot API is only touched on the thread that
// called cmd (the engine main thread), never from a Swift callback.
#import <Foundation/Foundation.h>
#include <stdlib.h>
#include <string.h>
#include "gdextension_interface.h"

extern char *pkp_call(const char *json);
extern void pkp_free(char *p);
extern void pkp_set_event_callback(void (*cb)(const char *json));

static NSMutableArray<NSString *> *g_events;
static NSLock *g_lock;

static void on_event(const char *json) { // any thread
    NSString *s = [NSString stringWithUTF8String:json];
    [g_lock lock];
    [g_events addObject:s];
    [g_lock unlock];
}

static void pkap_init_queue(void) {
    g_events = [NSMutableArray array];
    g_lock = [NSLock new];
    pkp_set_event_callback(on_event);
}

#if PKAP_SK_TEST
extern int pkp_probe_start_sk_session(const char *path);
extern int pkp_probe_refund(unsigned long long id);
#endif

static char *pkap_cmd_c(const char *json) {
    @autoreleasepool {
#if PKAP_SK_TEST
        // Probe-only ops (simulator): {"op":"sk_session"} and {"op":"sk_refund","id":"N"}.
        if (strstr(json, "\"op\":\"sk_session\"")) {
            NSDictionary *q = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil];
            NSString *p = q[@"path"];
            int rc = p ? pkp_probe_start_sk_session(p.UTF8String) : 9;
            return strdup([NSString stringWithFormat:@"{\"ok\":%s,\"rc\":%d,\"path\":\"%@\"}", rc == 0 ? "true" : "false", rc, p ?: @""].UTF8String);
        }
        if (strstr(json, "\"op\":\"sk_refund\"")) {
            NSDictionary *q = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil];
            int rc = pkp_probe_refund(strtoull([q[@"id"] UTF8String], NULL, 10));
            return strdup([NSString stringWithFormat:@"{\"ok\":%s,\"rc\":%d}", rc == 0 ? "true" : "false", rc].UTF8String);
        }
#endif
        if (strstr(json, "\"op\":\"poll\"")) {
            [g_lock lock];
            NSArray *out = [g_events copy];
            [g_events removeAllObjects];
            [g_lock unlock];
            NSString *joined = [NSString stringWithFormat:@"{\"ok\":true,\"events\":[%@]}", [out componentsJoinedByString:@","]];
            return strdup(joined.UTF8String);
        }
        char *r = pkp_call(json);
        char *copy = strdup(r);
        pkp_free(r);
        return copy;
    }
}

// ---------------------------------------------------------------------------------------------
// GDExtension glue (C interface only)

static GDExtensionInterfaceStringNewWithUtf8Chars s_new_utf8;
static GDExtensionInterfaceStringToUtf8Chars s_to_utf8;
static GDExtensionInterfaceStringNameNewWithLatin1Chars sn_new;
static GDExtensionInterfaceClassdbRegisterExtensionClass6 reg_class;
static GDExtensionInterfaceClassdbRegisterExtensionClassMethod reg_method;
static GDExtensionVariantFromTypeConstructorFunc variant_from_string;
static GDExtensionTypeFromVariantConstructorFunc string_from_variant;
static GDExtensionPtrDestructor string_dtor;
static GDExtensionClassLibraryPtr g_library;

typedef struct { uint8_t opaque[8]; } GStr;   // godot::String is one pointer
typedef struct { uint8_t opaque[8]; } GSName; // godot::StringName is one pointer
typedef struct { uint8_t opaque[24]; } GVar;  // Variant is 24 bytes on 64-bit (real_t=float)

static char *gstr_to_c(const void *s) {
    GDExtensionInt n = s_to_utf8(s, NULL, 0);
    char *buf = malloc((size_t)n + 1);
    s_to_utf8(s, buf, n);
    buf[n] = 0;
    return buf;
}

static void run_cmd(const void *arg_str, void *r_str_uninit) {
    char *in = gstr_to_c(arg_str);
    char *out = pkap_cmd_c(in);
    s_new_utf8(r_str_uninit, out);
    free(in);
    free(out);
}

static void cmd_call(void *ud, GDExtensionClassInstancePtr inst, const GDExtensionConstVariantPtr *args,
                     GDExtensionInt argc, GDExtensionVariantPtr r_ret, GDExtensionCallError *r_err) {
    (void)ud; (void)inst;
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
    (void)ud; (void)inst;
    // r_ret is an already-constructed String: destroy it, then construct the result in place.
    string_dtor(r_ret);
    run_cmd(args[0], r_ret);
}

static void initialize(void *userdata, GDExtensionInitializationLevel level) {
    (void)userdata;
    if (level != GDEXTENSION_INITIALIZATION_SCENE) return;

    pkap_init_queue();
    static GSName class_name, parent_name, method_name, empty_sn, arg_name;
    static GStr empty_s;
    sn_new(&class_name, "PolarisKeyApple", 1);
    sn_new(&parent_name, "Object", 1);
    sn_new(&method_name, "cmd", 1);
    sn_new(&empty_sn, "", 1);
    sn_new(&arg_name, "json", 1);
    s_new_utf8(&empty_s, "");

    GDExtensionClassCreationInfo6 ci;
    memset(&ci, 0, sizeof ci);
    ci.is_abstract = 1;
    ci.is_exposed = 1;
    reg_class(g_library, &class_name, &parent_name, &ci);

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
    reg_method(g_library, &class_name, &mi);
}

static void deinitialize(void *userdata, GDExtensionInitializationLevel level) {
    (void)userdata; (void)level;
}

__attribute__((visibility("default"))) GDExtensionBool
pkap_library_init(GDExtensionInterfaceGetProcAddress gpa, GDExtensionClassLibraryPtr lib,
                  GDExtensionInitialization *r_init) {
    g_library = lib;
    s_new_utf8 = (GDExtensionInterfaceStringNewWithUtf8Chars)gpa("string_new_with_utf8_chars");
    s_to_utf8 = (GDExtensionInterfaceStringToUtf8Chars)gpa("string_to_utf8_chars");
    sn_new = (GDExtensionInterfaceStringNameNewWithLatin1Chars)gpa("string_name_new_with_latin1_chars");
    reg_class = (GDExtensionInterfaceClassdbRegisterExtensionClass6)gpa("classdb_register_extension_class6");
    reg_method = (GDExtensionInterfaceClassdbRegisterExtensionClassMethod)gpa("classdb_register_extension_class_method");
    GDExtensionInterfaceGetVariantFromTypeConstructor vft =
        (GDExtensionInterfaceGetVariantFromTypeConstructor)gpa("get_variant_from_type_constructor");
    GDExtensionInterfaceGetVariantToTypeConstructor vtt =
        (GDExtensionInterfaceGetVariantToTypeConstructor)gpa("get_variant_to_type_constructor");
    GDExtensionInterfaceVariantGetPtrDestructor vpd =
        (GDExtensionInterfaceVariantGetPtrDestructor)gpa("variant_get_ptr_destructor");
    if (!s_new_utf8 || !s_to_utf8 || !sn_new || !reg_class || !reg_method || !vft || !vtt || !vpd) return 0;
    variant_from_string = vft(GDEXTENSION_VARIANT_TYPE_STRING);
    string_from_variant = vtt(GDEXTENSION_VARIANT_TYPE_STRING);
    string_dtor = vpd(GDEXTENSION_VARIANT_TYPE_STRING);

    r_init->minimum_initialization_level = GDEXTENSION_INITIALIZATION_SCENE;
    r_init->userdata = NULL;
    r_init->initialize = initialize;
    r_init->deinitialize = deinitialize;
    return 1;
}
