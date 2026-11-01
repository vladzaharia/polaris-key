// pkey_apple: the Godot binding of PolarisKeyPlatform (P5-05), as a GDExtension written against
// Godot's stable C interface only: no godot-cpp, no SwiftGodot (notes/S-09 §Results 4).
//
// It registers ONE abstract class, PolarisKeyApple, with ONE static method:
//
//     PolarisKeyApple.cmd(json: String) -> String
//
// D-13 (CC-14b.2): two more static methods carry bytes with no JSON and no base64:
//
//     PolarisKeyApple.cmd_bin(op: String, data: PackedByteArray) -> PackedByteArray
//     PolarisKeyApple.poll_bin() -> Array          # [[kind: String, data: PackedByteArray], …]
//
// cmd_bin forwards to pkp_call_bin and answers an EMPTY array for an unknown op, a wrong argument
// type, an oversized input or output, or any refusal. poll_bin drains the binary events Swift
// pushed through pkp_set_bin_event_callback. Both are registered only when every builtin the glue
// needs resolved at load, so GDScript sees `class_has_method("cmd_bin")` false on an engine that
// lacks one, and its lane falls back. Key material goes in and out as bytes in process: nothing
// here logs, formats or copies a payload into a String, and the native result is zeroed before it
// is freed.
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

// The same glue builds two extensions (I-48.6a): the Apple platform plugin (PolarisKeyApple over
// PolarisKeyPlatformC's pkp_*) and, with -DPKEY_GAMECENTER, the opt-in Game Center extension
// (PolarisKeyGameCenter over PolarisKeyGameCenterC's pkgc_*), so a build links GameKit only for a game
// that asks for it.
#ifdef PKEY_GAMECENTER
#define PKEY_CLASS "PolarisKeyGameCenter"
#define PKEY_INIT pkey_gamecenter_library_init
#define PKEY_CALL pkgc_call
#define PKEY_FREE pkgc_free
#define PKEY_SET_CALLBACK pkgc_set_event_callback
#else
#define PKEY_CLASS "PolarisKeyApple"
#define PKEY_INIT pkey_apple_library_init
#define PKEY_CALL pkp_call
#define PKEY_FREE pkp_free
#define PKEY_SET_CALLBACK pkp_set_event_callback
#endif

extern char *PKEY_CALL(const char *json);
extern void PKEY_FREE(char *p);
extern void PKEY_SET_CALLBACK(void (*cb)(const char *json));
extern uint8_t *pkp_call_bin(const char *op, const uint8_t *in, size_t n, size_t *out_n);
extern void pkp_free_bin(uint8_t *p);
extern void pkp_set_bin_event_callback(void (*cb)(const char *kind, const uint8_t *p, size_t n));

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

// The binary events (D-13): the same bound on count, and a bound on bytes, so a host that stops
// polling cannot hold memory. The oldest are dropped first.
#define PKEY_APPLE_BIN_QUEUE_LIMIT 1024
#define PKEY_APPLE_BIN_QUEUE_BYTES (64u << 20)
// The largest input or output of the binary entry; the same figure as PlatformHost.maxBinaryBytes.
#define PKEY_APPLE_BIN_MAX ((size_t)16 << 20)
#define PKEY_APPLE_OP_MAX 64

static NSMutableArray<NSArray *> *g_bin_events; // each [NSString kind, NSData payload]
static size_t g_bin_bytes;

static void on_bin_event(const char *kind, const uint8_t *p, size_t n) {
    if (!kind || n > PKEY_APPLE_BIN_MAX || (n > 0 && !p)) return;
    @autoreleasepool {
        NSString *k = [NSString stringWithUTF8String:kind];
        if (!k) return;
        NSData *d = n ? [NSData dataWithBytes:p length:n] : [NSData data];
        [g_lock lock];
        [g_bin_events addObject:@[ k, d ]];
        g_bin_bytes += n;
        while (g_bin_events.count > PKEY_APPLE_BIN_QUEUE_LIMIT || g_bin_bytes > PKEY_APPLE_BIN_QUEUE_BYTES) {
            g_bin_bytes -= ((NSData *)g_bin_events[0][1]).length;
            [g_bin_events removeObjectAtIndex:0];
        }
        [g_lock unlock];
    }
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
        char *r = PKEY_CALL(json);
        char *copy = strdup(r ? r : "{\"ok\":false,\"error\":\"bad_json\"}");
        PKEY_FREE(r);
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
static GDExtensionInterfaceVariantGetPtrBuiltinMethod builtin_method_of;
static GDExtensionInterfaceVariantGetPtrConstructor ctor_of;
static GDExtensionInterfaceVariantGetPtrDestructor dtor_of;
static GDExtensionInterfaceGetVariantFromTypeConstructor variant_from_type_of;
static GDExtensionInterfaceGetVariantToTypeConstructor variant_to_type_of;

// The binary entry's builtins (D-13), resolved once at initialize. g_bin_ok is set only when all
// of them resolved.
typedef struct { uint8_t opaque[16]; } GPba; // godot::PackedByteArray
typedef struct { uint8_t opaque[8]; } GArr;  // godot::Array
typedef struct { uint8_t opaque[24]; } GVar; // godot::Variant
static GDExtensionInterfaceVariantGetType variant_type_of;
static GDExtensionInterfaceVariantDestroy variant_destroy;
static GDExtensionInterfacePackedByteArrayOperatorIndex pba_index;
static GDExtensionInterfacePackedByteArrayOperatorIndexConst pba_index_const;
static GDExtensionPtrConstructor pba_ctor, arr_ctor;
static GDExtensionPtrDestructor pba_dtor, arr_dtor;
static GDExtensionPtrBuiltInMethod pba_size, pba_resize, arr_push;
static GDExtensionVariantFromTypeConstructorFunc variant_from_pba, variant_from_arr;
static GDExtensionTypeFromVariantConstructorFunc pba_from_variant;
static BOOL g_bin_ok;

typedef struct { uint8_t opaque[8]; } GStr;   // godot::String is one pointer
typedef struct { uint8_t opaque[8]; } GSName; // godot::StringName is one pointer

static GSName g_class_name;

static char *gstr_to_c(const void *s) {
    GDExtensionInt n = s_to_utf8(s, NULL, 0);
    char *buf = malloc((size_t)n + 1);
    if (!buf) return NULL;
    s_to_utf8(s, buf, n);
    buf[n] = 0;
    return buf;
}

static void run_cmd(const void *arg_str, void *r_str_uninit) {
    char *in = gstr_to_c(arg_str);
    if (!in) {
        // Out of memory: answer an error the facade maps to platform-error, never crash.
        s_new_utf8(r_str_uninit, "{\"ok\":false,\"error\":\"out_of_memory\"}");
        return;
    }
    char *out = pkey_apple_cmd_c(in);
    if (!out) {
        free(in);
        s_new_utf8(r_str_uninit, "{\"ok\":false,\"error\":\"out_of_memory\"}");
        return;
    }
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

// ---------------------------------------------------------------------------------------------
// The binary entry (D-13)

static int64_t pba_len(GDExtensionConstTypePtr p) {
    int64_t n = -1;
    pba_size((GDExtensionTypePtr)p, NULL, &n, 0);
    return n;
}

// Construct a PackedByteArray of `n` bytes copied from `src` at `out` (uninitialized). On failure
// `out` is left a valid EMPTY array and 0 is answered.
static int pba_fill(GPba *out, const uint8_t *src, size_t n) {
    pba_ctor(out, NULL);
    if (n == 0) return 1;
    int64_t want = (int64_t)n, got = -1;
    const void *args[1] = {&want};
    pba_resize(out, args, &got, 1);
    if (got != 0 || pba_len(out) != want) {
        pba_dtor(out);
        pba_ctor(out, NULL);
        return 0;
    }
    uint8_t *dst = pba_index(out, 0);
    if (!dst) {
        pba_dtor(out);
        pba_ctor(out, NULL);
        return 0;
    }
    memcpy(dst, src, n);
    return 1;
}

// op (a String) and data (a PackedByteArray, borrowed) in; the result constructed at r_pba.
static void run_cmd_bin(const void *op_str, GDExtensionConstTypePtr data, GPba *r_pba) {
    char *op = NULL;
    uint8_t *out = NULL;
    size_t out_n = 0;
    GDExtensionInt op_len = s_to_utf8(op_str, NULL, 0);
    int64_t n = pba_len(data);
    if (op_len > 0 && op_len <= PKEY_APPLE_OP_MAX && n >= 0 && (size_t)n <= PKEY_APPLE_BIN_MAX && (op = gstr_to_c(op_str))) {
        const uint8_t *in = NULL;
        if (n > 0) in = pba_index_const(data, 0);
        if (n == 0 || in) out = pkp_call_bin(op, in, (size_t)n, &out_n);
    }
    if (out) {
        if (out_n > 0 && out_n <= PKEY_APPLE_BIN_MAX) {
            pba_fill(r_pba, out, out_n);
        } else {
            pba_ctor(r_pba, NULL);
        }
        // The result may have held key material: zero what the callee allocated before freeing it.
        // out_n is the callee's own length, whatever it was; it is never larger than what it wrote.
        if (out_n > 0 && out_n <= PKEY_APPLE_BIN_MAX) memset_s(out, out_n, 0, out_n);
        pkp_free_bin(out);
    } else {
        pba_ctor(r_pba, NULL);
    }
    free(op);
}

static void cmd_bin_call(void *ud, GDExtensionClassInstancePtr inst, const GDExtensionConstVariantPtr *args,
                         GDExtensionInt argc, GDExtensionVariantPtr r_ret, GDExtensionCallError *r_err) {
    (void)ud;
    (void)inst;
    if (argc < 2) {
        r_err->error = GDEXTENSION_CALL_ERROR_TOO_FEW_ARGUMENTS;
        r_err->expected = 2;
        return;
    }
    if (argc > 2) {
        r_err->error = GDEXTENSION_CALL_ERROR_TOO_MANY_ARGUMENTS;
        r_err->expected = 2;
        return;
    }
    if (variant_type_of(args[0]) != GDEXTENSION_VARIANT_TYPE_STRING) {
        r_err->error = GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;
        r_err->argument = 0;
        r_err->expected = GDEXTENSION_VARIANT_TYPE_STRING;
        return;
    }
    if (variant_type_of(args[1]) != GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY) {
        r_err->error = GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;
        r_err->argument = 1;
        r_err->expected = GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY;
        return;
    }
    GStr op;
    GPba data, out;
    string_from_variant(&op, (GDExtensionVariantPtr)args[0]);
    pba_from_variant(&data, (GDExtensionVariantPtr)args[1]);
    run_cmd_bin(&op, &data, &out);
    variant_from_pba(r_ret, &out);
    pba_dtor(&out);
    pba_dtor(&data);
    string_dtor(&op);
    r_err->error = GDEXTENSION_CALL_OK;
}

static void cmd_bin_ptrcall(void *ud, GDExtensionClassInstancePtr inst, const GDExtensionConstTypePtr *args,
                            GDExtensionTypePtr r_ret) {
    (void)ud;
    (void)inst;
    // r_ret is an already-constructed PackedByteArray: destroy it, then construct in place.
    pba_dtor(r_ret);
    run_cmd_bin(args[0], args[1], (GPba *)r_ret);
}

// [[kind, data], …] constructed at `out` (uninitialized). Drains the queue.
static void build_events(GArr *out) {
    NSArray<NSArray *> *events;
    [g_lock lock];
    events = [g_bin_events copy];
    [g_bin_events removeAllObjects];
    g_bin_bytes = 0;
    [g_lock unlock];
    arr_ctor(out, NULL);
    for (NSArray *e in events) {
        @autoreleasepool {
            const char *kind = ((NSString *)e[0]).UTF8String;
            NSData *d = e[1];
            GStr ks;
            GPba pb;
            GVar vk, vd, vi;
            GArr inner;
            s_new_utf8(&ks, kind);
            pba_fill(&pb, d.bytes, d.length);
            variant_from_string(&vk, &ks);
            variant_from_pba(&vd, &pb);
            arr_ctor(&inner, NULL);
            const void *a1[1] = {&vk};
            const void *a2[1] = {&vd};
            arr_push(&inner, a1, NULL, 1);
            arr_push(&inner, a2, NULL, 1);
            variant_from_arr(&vi, &inner);
            const void *a3[1] = {&vi};
            arr_push(out, a3, NULL, 1);
            variant_destroy(&vi);
            variant_destroy(&vd);
            variant_destroy(&vk);
            arr_dtor(&inner);
            pba_dtor(&pb);
            string_dtor(&ks);
        }
    }
}

static void poll_bin_call(void *ud, GDExtensionClassInstancePtr inst, const GDExtensionConstVariantPtr *args,
                          GDExtensionInt argc, GDExtensionVariantPtr r_ret, GDExtensionCallError *r_err) {
    (void)ud;
    (void)inst;
    (void)args;
    if (argc > 0) {
        r_err->error = GDEXTENSION_CALL_ERROR_TOO_MANY_ARGUMENTS;
        r_err->expected = 0;
        return;
    }
    GArr out;
    build_events(&out);
    variant_from_arr(r_ret, &out);
    arr_dtor(&out);
    r_err->error = GDEXTENSION_CALL_OK;
}

static void poll_bin_ptrcall(void *ud, GDExtensionClassInstancePtr inst, const GDExtensionConstTypePtr *args,
                             GDExtensionTypePtr r_ret) {
    (void)ud;
    (void)inst;
    (void)args;
    arr_dtor(r_ret);
    build_events((GArr *)r_ret);
}

// Resolve every builtin the binary entry needs; 1 only when all of them resolved. The hashes are
// the engine's own for these signatures (extension_api.json, Godot 4.4 to 4.7).
static int resolve_bin(void) {
    if (!builtin_method_of || !ctor_of || !dtor_of || !variant_from_type_of || !variant_to_type_of || !variant_type_of ||
        !variant_destroy || !pba_index || !pba_index_const)
        return 0;
    GSName n_size, n_resize, n_push;
    sn_new(&n_size, "size", 1);
    sn_new(&n_resize, "resize", 1);
    sn_new(&n_push, "push_back", 1);
    pba_size = builtin_method_of(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, &n_size, 3173160232);
    pba_resize = builtin_method_of(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, &n_resize, 848867239);
    arr_push = builtin_method_of(GDEXTENSION_VARIANT_TYPE_ARRAY, &n_push, 3316032543);
    pba_ctor = ctor_of(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, 0);
    arr_ctor = ctor_of(GDEXTENSION_VARIANT_TYPE_ARRAY, 0);
    pba_dtor = dtor_of(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
    arr_dtor = dtor_of(GDEXTENSION_VARIANT_TYPE_ARRAY);
    variant_from_pba = variant_from_type_of(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
    variant_from_arr = variant_from_type_of(GDEXTENSION_VARIANT_TYPE_ARRAY);
    pba_from_variant = variant_to_type_of(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
    return pba_size && pba_resize && arr_push && pba_ctor && arr_ctor && pba_dtor && arr_dtor && variant_from_pba &&
           variant_from_arr && pba_from_variant;
}

static void initialize(void *userdata, GDExtensionInitializationLevel level) {
    (void)userdata;
    if (level != GDEXTENSION_INITIALIZATION_SCENE) return;

    g_events = [NSMutableArray array];
    g_bin_events = [NSMutableArray array];
    g_lock = [NSLock new];
    PKEY_SET_CALLBACK(on_event);

    static GSName parent_name, method_name, empty_sn, arg_name;
    static GStr empty_s;
    sn_new(&g_class_name, PKEY_CLASS, 1);
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

    if (!resolve_bin()) return;
    g_bin_ok = YES;
    pkp_set_bin_event_callback(on_bin_event);

    // cmd_bin(op: String, data: PackedByteArray) -> PackedByteArray
    static GSName bin_name, poll_bin_name, data_name, op_name;
    static GDExtensionPropertyInfo bin_ret, bin_args[2], poll_ret;
    static GDExtensionClassMethodArgumentMetadata bin_meta[2] = {GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE,
                                                                 GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE};
    sn_new(&bin_name, "cmd_bin", 1);
    sn_new(&poll_bin_name, "poll_bin", 1);
    sn_new(&data_name, "data", 1);
    sn_new(&op_name, "op", 1);
    bin_ret = (GDExtensionPropertyInfo){GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, &empty_sn, &empty_sn, 0, &empty_s, 6};
    bin_args[0] = (GDExtensionPropertyInfo){GDEXTENSION_VARIANT_TYPE_STRING, &op_name, &empty_sn, 0, &empty_s, 6};
    bin_args[1] = (GDExtensionPropertyInfo){GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, &data_name, &empty_sn, 0, &empty_s, 6};
    GDExtensionClassMethodInfo bi;
    memset(&bi, 0, sizeof bi);
    bi.name = &bin_name;
    bi.call_func = cmd_bin_call;
    bi.ptrcall_func = cmd_bin_ptrcall;
    bi.method_flags = GDEXTENSION_METHOD_FLAG_NORMAL | GDEXTENSION_METHOD_FLAG_STATIC;
    bi.has_return_value = 1;
    bi.return_value_info = &bin_ret;
    bi.return_value_metadata = GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE;
    bi.argument_count = 2;
    bi.arguments_info = bin_args;
    bi.arguments_metadata = bin_meta;
    reg_method(g_library, &g_class_name, &bi);

    // poll_bin() -> Array
    poll_ret = (GDExtensionPropertyInfo){GDEXTENSION_VARIANT_TYPE_ARRAY, &empty_sn, &empty_sn, 0, &empty_s, 6};
    GDExtensionClassMethodInfo pi;
    memset(&pi, 0, sizeof pi);
    pi.name = &poll_bin_name;
    pi.call_func = poll_bin_call;
    pi.ptrcall_func = poll_bin_ptrcall;
    pi.method_flags = GDEXTENSION_METHOD_FLAG_NORMAL | GDEXTENSION_METHOD_FLAG_STATIC;
    pi.has_return_value = 1;
    pi.return_value_info = &poll_ret;
    pi.return_value_metadata = GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE;
    pi.argument_count = 0;
    reg_method(g_library, &g_class_name, &pi);
}

static void deinitialize(void *userdata, GDExtensionInitializationLevel level) {
    (void)userdata;
    if (level != GDEXTENSION_INITIALIZATION_SCENE) return;
    PKEY_SET_CALLBACK(NULL);
    if (g_bin_ok) pkp_set_bin_event_callback(NULL);
    if (unreg_class) unreg_class(g_library, &g_class_name);
}

__attribute__((visibility("default"))) GDExtensionBool
PKEY_INIT(GDExtensionInterfaceGetProcAddress gpa, GDExtensionClassLibraryPtr lib,
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
    builtin_method_of = (GDExtensionInterfaceVariantGetPtrBuiltinMethod)gpa("variant_get_ptr_builtin_method");
    ctor_of = (GDExtensionInterfaceVariantGetPtrConstructor)gpa("variant_get_ptr_constructor");
    dtor_of = vpd;
    variant_from_type_of = vft;
    variant_to_type_of = vtt;
    variant_type_of = (GDExtensionInterfaceVariantGetType)gpa("variant_get_type");
    variant_destroy = (GDExtensionInterfaceVariantDestroy)gpa("variant_destroy");
    pba_index = (GDExtensionInterfacePackedByteArrayOperatorIndex)gpa("packed_byte_array_operator_index");
    pba_index_const = (GDExtensionInterfacePackedByteArrayOperatorIndexConst)gpa("packed_byte_array_operator_index_const");
    variant_from_string = vft(GDEXTENSION_VARIANT_TYPE_STRING);
    string_from_variant = vtt(GDEXTENSION_VARIANT_TYPE_STRING);
    string_dtor = vpd(GDEXTENSION_VARIANT_TYPE_STRING);

    r_init->minimum_initialization_level = GDEXTENSION_INITIALIZATION_SCENE;
    r_init->userdata = NULL;
    r_init->initialize = initialize;
    r_init->deinitialize = deinitialize;
    return 1;
}
