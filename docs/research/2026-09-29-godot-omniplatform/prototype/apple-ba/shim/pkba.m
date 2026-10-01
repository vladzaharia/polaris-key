// pkba: a measurement shim that exposes Apple's managed Background Assets API to GDScript.
//
// Shape: a GDExtension written against the C interface only (no godot-cpp), in Objective-C so
// it can call BAAssetPackManager directly (no Swift runtime inside the extension). It registers
// one abstract class, PKAppleBA, with a single static method:
//
//     PKAppleBA.cmd(json: String) -> String
//
// GDScript sends {"op": ...} requests. Synchronous ops answer in the return value; asynchronous
// ops (ensure, url, check_updates, ...) answer {"ok":true,"req":N} and later push an event that
// {"op":"poll"} drains. Download progress from BAManagedAssetPackDownloadDelegate is pushed the
// same way. Every event carries t_ms, milliseconds since the shim loaded (monotonic clock).
//
// Research code for S-01; P5-05 turns the lessons into PolarisKeyApple (see prototype README).

#import <Foundation/Foundation.h>
#import <BackgroundAssets/BackgroundAssets.h>
#include <mach/mach_time.h>
#include <stdlib.h>
#include <string.h>

#include "gdextension_interface.h"

// ---------------------------------------------------------------------------------------------
// Event queue and clock

static NSMutableArray *g_events;
static NSLock *g_lock;
static uint64_t g_t0;
static mach_timebase_info_data_t g_tb;
static long g_req;

static double now_ms(void) {
    uint64_t d = mach_absolute_time() - g_t0;
    return (double)d * g_tb.numer / g_tb.denom / 1e6;
}

static void push(NSDictionary *ev) {
    NSMutableDictionary *m = [ev mutableCopy];
    m[@"t_ms"] = @(now_ms());
    [g_lock lock];
    [g_events addObject:m];
    [g_lock unlock];
}

static NSDictionary *err_dict(NSError *e) {
    if (!e) return @{};
    return @{@"error" : [NSString stringWithFormat:@"%@ %ld: %@", e.domain, (long)e.code,
                                                   e.localizedDescription ?: @""]};
}

static NSDictionary *pack_dict(BAAssetPack *p) {
    if (!p) return @{};
    return @{@"id" : p.identifier, @"version" : @(p.version), @"downloadSize" : @(p.downloadSize)};
}

static NSArray *status_names(BAAssetPackStatus s) {
    NSMutableArray *a = [NSMutableArray array];
    if (s & BAAssetPackStatusDownloadAvailable) [a addObject:@"downloadAvailable"];
    if (s & BAAssetPackStatusUpdateAvailable) [a addObject:@"updateAvailable"];
    if (s & BAAssetPackStatusUpToDate) [a addObject:@"upToDate"];
    if (s & BAAssetPackStatusOutOfDate) [a addObject:@"outOfDate"];
    if (s & BAAssetPackStatusObsolete) [a addObject:@"obsolete"];
    if (s & BAAssetPackStatusDownloading) [a addObject:@"downloading"];
    if (s & BAAssetPackStatusDownloaded) [a addObject:@"downloaded"];
    return a;
}

// ---------------------------------------------------------------------------------------------
// Download delegate: began / paused / progress / finished / failed

@interface PKBADelegate : NSObject <BAManagedAssetPackDownloadDelegate>
@end
@implementation PKBADelegate
- (void)downloadOfAssetPackBegan:(BAAssetPack *)p {
    NSMutableDictionary *d = [pack_dict(p) mutableCopy];
    d[@"ev"] = @"began";
    push(d);
}
- (void)downloadOfAssetPackPaused:(BAAssetPack *)p {
    NSMutableDictionary *d = [pack_dict(p) mutableCopy];
    d[@"ev"] = @"paused";
    push(d);
}
- (void)downloadOfAssetPack:(BAAssetPack *)p hasProgress:(NSProgress *)pr {
    NSMutableDictionary *d = [pack_dict(p) mutableCopy];
    d[@"ev"] = @"progress";
    d[@"completed"] = @(pr.completedUnitCount);
    d[@"total"] = @(pr.totalUnitCount);
    d[@"fraction"] = @(pr.fractionCompleted);
    push(d);
}
- (void)downloadOfAssetPackFinished:(BAAssetPack *)p {
    NSMutableDictionary *d = [pack_dict(p) mutableCopy];
    d[@"ev"] = @"finished";
    push(d);
}
- (void)downloadOfAssetPack:(BAAssetPack *)p failedWithError:(NSError *)e {
    NSMutableDictionary *d = [pack_dict(p) mutableCopy];
    [d addEntriesFromDictionary:err_dict(e)];
    d[@"ev"] = @"failed";
    push(d);
}
@end

static PKBADelegate *g_delegate;

// BAAssetPackManager.sharedManager traps (Swift fatalError, not an NSError) in a process that is
// not a configured managed-BA app: measured on macOS 27 as "The main bundle lacks an ID." for a
// bare executable and "The process lacks a team ID." for an ad-hoc-signed bundle, even with the
// BA Info.plist keys present. So never touch it unless the Info.plist keys that the post-export
// patch adds are present (sideload exports skip the patch and so never reach it).
static BOOL ba_configured(void) {
    NSDictionary *info = NSBundle.mainBundle.infoDictionary;
    return [info[@"BAAppGroupID"] isKindOfClass:NSString.class] && [info[@"BAHasManagedAssetPacks"] boolValue];
}

static BAAssetPackManager *mgr(void) {
    if (!ba_configured()) return nil;
    BAAssetPackManager *m = BAAssetPackManager.sharedManager;
    if (!g_delegate) {
        g_delegate = [PKBADelegate new];
        m.delegate = g_delegate;
    }
    return m;
}

// ---------------------------------------------------------------------------------------------
// Commands

static NSString *to_json(id obj) {
    NSData *d = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
    return d ? [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] : @"{\"ok\":false}";
}

static dispatch_queue_t bg(void) { return dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0); }

static NSDictionary *app_group_info(void) {
    // What the host app sees: its BA keys and whether the app-group container resolves.
    NSDictionary *info = NSBundle.mainBundle.infoDictionary;
    NSString *group = info[@"BAAppGroupID"];
    NSURL *c = group ? [NSFileManager.defaultManager containerURLForSecurityApplicationGroupIdentifier:group] : nil;
    return @{
        @"ok" : @YES,
        @"BAAppGroupID" : group ?: [NSNull null],
        @"BAHasManagedAssetPacks" : info[@"BAHasManagedAssetPacks"] ?: [NSNull null],
        @"BAUsesAppleHosting" : info[@"BAUsesAppleHosting"] ?: [NSNull null],
        @"container" : c.path ?: [NSNull null],
        @"bundle" : NSBundle.mainBundle.bundlePath ?: @"",
    };
}

static NSDictionary *handle(NSDictionary *q) {
    NSString *op = q[@"op"];
    NSNumber *req = @(++g_req);

    if ([op isEqualToString:@"poll"]) {
        [g_lock lock];
        NSArray *out = [g_events copy];
        [g_events removeAllObjects];
        [g_lock unlock];
        return @{@"ok" : @YES, @"events" : out, @"t_ms" : @(now_ms())};
    }
    if ([op isEqualToString:@"now"]) return @{@"ok" : @YES, @"t_ms" : @(now_ms())};
    if ([op isEqualToString:@"configured"]) return @{@"ok" : @YES, @"configured" : @(ba_configured())};
    if ([op isEqualToString:@"app_group"]) return app_group_info();

    BAAssetPackManager *m = mgr();
    if (!m) return @{@"ok" : @NO, @"error" : @"Background Assets not configured in this build"};

    if ([op isEqualToString:@"is_local"]) {
        BOOL b = [m assetPackIsAvailableLocallyWithIdentifier:q[@"id"]];
        return @{@"ok" : @YES, @"local" : @(b)};
    }

    if ([op isEqualToString:@"all_packs"]) {
        [m getAllAssetPacksWithCompletionHandler:^(NSSet<BAAssetPack *> *packs, NSError *e) {
          NSMutableArray *a = [NSMutableArray array];
          for (BAAssetPack *p in packs) [a addObject:pack_dict(p)];
          NSMutableDictionary *d = [@{@"ev" : @"all_packs", @"req" : req, @"packs" : a} mutableCopy];
          [d addEntriesFromDictionary:err_dict(e)];
          push(d);
        }];
        return @{@"ok" : @YES, @"req" : req};
    }

    if ([op isEqualToString:@"local_status"]) {
        NSString *pid = q[@"id"];
        [m getLocalStatusOfAssetPackWithIdentifier:pid
                                 completionHandler:^(BAAssetPackStatus s) {
                                   push(@{@"ev" : @"local_status", @"req" : req, @"id" : pid,
                                          @"status" : status_names(s), @"raw" : @(s)});
                                 }];
        return @{@"ok" : @YES, @"req" : req};
    }

    if ([op isEqualToString:@"ensure"]) {
        NSString *pid = q[@"id"];
        BOOL latest = [q[@"latest"] boolValue];
        double t_start = now_ms();
        [m getAssetPackWithIdentifier:pid
                    completionHandler:^(BAAssetPack *p, NSError *e) {
                      double t_pack = now_ms();
                      if (!p) {
                          NSMutableDictionary *d =
                              [@{@"ev" : @"ensure", @"req" : req, @"id" : pid, @"ok" : @NO,
                                 @"stage" : @"getAssetPack", @"t_start" : @(t_start)} mutableCopy];
                          [d addEntriesFromDictionary:err_dict(e)];
                          push(d);
                          return;
                      }
                      [m ensureLocalAvailabilityOfAssetPack:p
                                       requireLatestVersion:latest
                                          completionHandler:^(NSError *e2) {
                                            NSMutableDictionary *d = [pack_dict(p) mutableCopy];
                                            [d addEntriesFromDictionary:@{
                                                @"ev" : @"ensure",
                                                @"req" : req,
                                                @"ok" : @(e2 == nil),
                                                @"t_start" : @(t_start),
                                                @"t_pack" : @(t_pack),
                                            }];
                                            [d addEntriesFromDictionary:err_dict(e2)];
                                            push(d);
                                          }];
                    }];
        return @{@"ok" : @YES, @"req" : req};
    }

    if ([op isEqualToString:@"url"]) {
        // Resolved fresh, off the main thread, never persisted (Apple: "Don't persist the returned
        // URL beyond the lifetime of the current process").
        NSString *path = q[@"path"];
        dispatch_async(bg(), ^{
          double t0 = now_ms();
          NSError *e = nil;
          NSURL *u = [m URLForPath:path error:&e];
          NSMutableDictionary *d = [@{@"ev" : @"url", @"req" : req, @"path" : path,
                                      @"ok" : @(u != nil), @"dt_ms" : @(now_ms() - t0)} mutableCopy];
          if (u) d[@"fs_path"] = u.path;
          [d addEntriesFromDictionary:err_dict(e)];
          push(d);
        });
        return @{@"ok" : @YES, @"req" : req};
    }

    if ([op isEqualToString:@"contents"]) {
        NSString *path = q[@"path"];
        NSString *pid = q[@"id"];
        dispatch_async(bg(), ^{
          double t0 = now_ms();
          NSError *e = nil;
          NSData *data = [m contentsAtPath:path
                  searchingInAssetPackWithIdentifier:pid
                                             options:NSDataReadingMappedIfSafe
                                               error:&e];
          NSMutableDictionary *d = [@{@"ev" : @"contents", @"req" : req, @"path" : path,
                                      @"ok" : @(data != nil), @"dt_ms" : @(now_ms() - t0)} mutableCopy];
          if (data) {
              d[@"length"] = @(data.length);
              NSData *head = [data subdataWithRange:NSMakeRange(0, MIN(data.length, (NSUInteger)512))];
              d[@"head"] = [[NSString alloc] initWithData:head encoding:NSUTF8StringEncoding] ?: @"";
          }
          [d addEntriesFromDictionary:err_dict(e)];
          push(d);
        });
        return @{@"ok" : @YES, @"req" : req};
    }

    if ([op isEqualToString:@"check_updates"]) {
        double t0 = now_ms();
        [m checkForUpdatesWithCompletionHandler:^(NSSet<NSString *> *upd, NSSet<NSString *> *rem,
                                                  NSError *e) {
          NSMutableDictionary *d = [@{@"ev" : @"check_updates", @"req" : req,
                                      @"updating" : upd.allObjects ?: @[],
                                      @"removed" : rem.allObjects ?: @[],
                                      @"dt_ms" : @(now_ms() - t0)} mutableCopy];
          [d addEntriesFromDictionary:err_dict(e)];
          push(d);
        }];
        return @{@"ok" : @YES, @"req" : req};
    }

    if ([op isEqualToString:@"remove"]) {
        NSString *pid = q[@"id"];
        [m removeAssetPackWithIdentifier:pid
                       completionHandler:^(NSError *e) {
                         NSMutableDictionary *d =
                             [@{@"ev" : @"remove", @"req" : req, @"id" : pid, @"ok" : @(e == nil)} mutableCopy];
                         [d addEntriesFromDictionary:err_dict(e)];
                         push(d);
                       }];
        return @{@"ok" : @YES, @"req" : req};
    }

    return @{@"ok" : @NO, @"error" : [NSString stringWithFormat:@"unknown op %@", op]};
}

static char *pkba_cmd_c(const char *json) {
    @autoreleasepool {
        NSData *d = [NSData dataWithBytes:json length:strlen(json)];
        NSDictionary *q = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
        NSDictionary *r = [q isKindOfClass:NSDictionary.class] ? handle(q) : @{@"ok" : @NO, @"error" : @"bad json"};
        return strdup(to_json(r).UTF8String);
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
    char *out = pkba_cmd_c(in);
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

    g_events = [NSMutableArray array];
    g_lock = [NSLock new];
    mach_timebase_info(&g_tb);
    g_t0 = mach_absolute_time();
    static GSName class_name, parent_name, method_name, empty_sn, arg_name;
    static GStr empty_s;
    sn_new(&class_name, "PKAppleBA", 1);
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
pkba_library_init(GDExtensionInterfaceGetProcAddress gpa, GDExtensionClassLibraryPtr lib,
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
