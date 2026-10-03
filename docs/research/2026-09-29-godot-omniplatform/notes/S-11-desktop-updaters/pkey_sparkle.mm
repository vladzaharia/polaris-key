// S-11 spike: a GDExtension that drives Sparkle 2 from a Godot macOS export.
// Research code. Two modes:
//   "standard": SPUStandardUpdaterController (Sparkle's own UI), what P5-07 ships;
//   "headless": SPUUpdater with an auto-accepting SPUUserDriver, for unattended CI end-to-end runs.
// Sparkle.framework is WEAK-linked: if it is missing the extension still loads and start() answers
// {ok:false, error:"dependency"}, so the GDScript facade can report Unsupported(dependency).

#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>

#include <gdextension_interface.h>
#include <godot_cpp/classes/object.hpp>
#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/defs.hpp>
#include <godot_cpp/godot.hpp>
#include <godot_cpp/variant/dictionary.hpp>
#include <godot_cpp/variant/packed_string_array.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include <functional>

using EmitFn = std::function<void(NSString *, NSDictionary *)>;

static NSString *g_log_path = nil;
static CFAbsoluteTime g_t0 = 0;

static void pks_log(NSString *event, NSDictionary *detail) {
  if (!g_log_path) return;
  NSMutableDictionary *d = [NSMutableDictionary dictionary];
  d[@"t_ms"] = @((CFAbsoluteTimeGetCurrent() - g_t0) * 1000.0);
  d[@"pid"] = @(getpid());
  d[@"event"] = event;
  d[@"main_thread"] = @([NSThread isMainThread]);
  if (detail) d[@"detail"] = detail;
  NSData *json = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
  NSFileHandle *h = [NSFileHandle fileHandleForWritingAtPath:g_log_path];
  if (!h) {
    [[NSFileManager defaultManager] createFileAtPath:g_log_path contents:nil attributes:nil];
    h = [NSFileHandle fileHandleForWritingAtPath:g_log_path];
  }
  [h seekToEndOfFile];
  [h writeData:json];
  [h writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
  [h closeFile];
}

static NSDictionary *item_dict(SUAppcastItem *item) {
  if (!item) return @{};
  return @{
    @"version" : item.versionString ?: @"",
    @"short" : item.displayVersionString ?: @"",
    @"url" : item.fileURL.absoluteString ?: @"",
    @"length" : @(item.contentLength),
    @"critical" : @(item.criticalUpdate),
    @"delta" : @(item.deltaUpdate),
    @"channel" : item.channel ?: @"",
  };
}

static NSDictionary *err_dict(NSError *e) {
  if (!e) return @{};
  NSMutableDictionary *d = [@{
    @"domain" : e.domain ?: @"",
    @"code" : @(e.code),
    @"message" : e.localizedDescription ?: @"",
  } mutableCopy];
  NSError *u = e.userInfo[NSUnderlyingErrorKey];
  if (u) d[@"underlying"] = err_dict(u);
  if (e.localizedFailureReason) d[@"reason"] = e.localizedFailureReason;
  return d;
}

// ── Updater delegate: feed URL, channels, lifecycle events ──────────────────────────────────

@interface PKSDelegate : NSObject <SPUUpdaterDelegate>
@property(nonatomic, copy) NSString *feedURL;
@property(nonatomic, copy) NSSet<NSString *> *channels;
@property(nonatomic, assign) EmitFn emit;
@end

@implementation PKSDelegate
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater {
  return self.feedURL;
}
- (NSSet<NSString *> *)allowedChannelsForUpdater:(SPUUpdater *)updater {
  return self.channels ?: [NSSet set];
}
- (void)updater:(SPUUpdater *)u didFinishLoadingAppcast:(SUAppcast *)appcast {
  self.emit(@"appcast_loaded", @{@"items" : @(appcast.items.count)});
}
- (void)updater:(SPUUpdater *)u didFindValidUpdate:(SUAppcastItem *)item {
  self.emit(@"update_found", item_dict(item));
}
- (void)updaterDidNotFindUpdate:(SPUUpdater *)u error:(NSError *)error {
  self.emit(@"no_update", err_dict(error));
}
- (void)updater:(SPUUpdater *)u willDownloadUpdate:(SUAppcastItem *)item withRequest:(NSMutableURLRequest *)request {
  self.emit(@"will_download", @{@"item" : item_dict(item), @"headers" : request.allHTTPHeaderFields ?: @{}});
}
- (void)updater:(SPUUpdater *)u didDownloadUpdate:(SUAppcastItem *)item {
  self.emit(@"downloaded", item_dict(item));
}
- (void)updater:(SPUUpdater *)u failedToDownloadUpdate:(SUAppcastItem *)item error:(NSError *)error {
  self.emit(@"download_failed", @{@"item" : item_dict(item), @"error" : err_dict(error)});
}
- (void)updater:(SPUUpdater *)u willExtractUpdate:(SUAppcastItem *)item {
  self.emit(@"will_extract", item_dict(item));
}
- (void)updater:(SPUUpdater *)u didExtractUpdate:(SUAppcastItem *)item {
  self.emit(@"extracted", item_dict(item));
}
- (void)updater:(SPUUpdater *)u willInstallUpdate:(SUAppcastItem *)item {
  self.emit(@"will_install", item_dict(item));
}
- (BOOL)updaterShouldRelaunchApplication:(SPUUpdater *)u {
  self.emit(@"should_relaunch", nil);
  return YES;
}
- (void)updaterWillRelaunchApplication:(SPUUpdater *)u {
  self.emit(@"will_relaunch", nil);
}
- (BOOL)updater:(SPUUpdater *)u willInstallUpdateOnQuit:(SUAppcastItem *)item immediateInstallationBlock:(void (^)(void))block {
  self.emit(@"will_install_on_quit", item_dict(item));
  return NO;
}
- (void)updater:(SPUUpdater *)u didAbortWithError:(NSError *)error {
  self.emit(@"aborted", err_dict(error));
}
- (void)updater:(SPUUpdater *)u didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
  self.emit(@"cycle_finished", @{@"check" : @(check), @"error" : err_dict(error)});
}
@end

// ── Headless user driver: accepts everything, for unattended tests ──────────────────────────

@interface PKSAutoDriver : NSObject <SPUUserDriver>
@property(nonatomic, assign) EmitFn emit;
@end

@implementation PKSAutoDriver
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
  self.emit(@"driver_permission", nil);
  reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
  self.emit(@"driver_checking", nil);
}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
  self.emit(@"driver_update_found", @{@"item" : item_dict(item), @"stage" : @(state.stage)});
  reply(SPUUserUpdateChoiceInstall);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)downloadData {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))ack {
  self.emit(@"driver_not_found", err_dict(error));
  ack();
}
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))ack {
  self.emit(@"driver_error", err_dict(error));
  ack();
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
  self.emit(@"driver_download_started", nil);
}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)len {
  self.emit(@"driver_download_length", @{@"bytes" : @(len)});
}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {}
- (void)showDownloadDidStartExtractingUpdate {
  self.emit(@"driver_extracting", nil);
}
- (void)showExtractionReceivedProgress:(double)progress {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
  self.emit(@"driver_ready_to_install", nil);
  reply(SPUUserUpdateChoiceInstall);
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {
  self.emit(@"driver_installing", @{@"app_terminated" : @(terminated)});
}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))ack {
  self.emit(@"driver_installed", @{@"relaunched" : @(relaunched)});
  ack();
}
- (void)showUpdateInFocus {}
- (void)dismissUpdateInstallation {
  self.emit(@"driver_dismiss", nil);
}
@end

// ── The Godot class ─────────────────────────────────────────────────────────────────────────

class PKeySparkleNative : public godot::RefCounted {
  GDCLASS(PKeySparkleNative, godot::RefCounted)

  SPUStandardUpdaterController *controller_ = nil;
  SPUUpdater *updater_ = nil;
  PKSDelegate *delegate_ = nil;
  PKSAutoDriver *driver_ = nil;

  static godot::Variant to_variant(id obj) {
    if (!obj || obj == [NSNull null]) return godot::Variant();
    if ([obj isKindOfClass:[NSString class]]) return godot::String::utf8([obj UTF8String]);
    if ([obj isKindOfClass:[NSNumber class]]) {
      const char *t = [obj objCType];
      if (strcmp(t, @encode(BOOL)) == 0 || strcmp(t, "c") == 0) return (bool)[obj boolValue];
      if (strcmp(t, "d") == 0 || strcmp(t, "f") == 0) return [obj doubleValue];
      return (int64_t)[obj longLongValue];
    }
    if ([obj isKindOfClass:[NSDictionary class]]) {
      godot::Dictionary d;
      for (id k in obj) d[to_variant(k)] = to_variant(obj[k]);
      return d;
    }
    if ([obj isKindOfClass:[NSArray class]]) {
      godot::Array a;
      for (id v in obj) a.push_back(to_variant(v));
      return a;
    }
    return godot::String::utf8([[obj description] UTF8String]);
  }

  static NSString *ns(const godot::String &s) { return [NSString stringWithUTF8String:s.utf8().get_data()]; }

  godot::Dictionary fail(const char *code, NSString *msg = nil) {
    godot::Dictionary d;
    d["ok"] = false;
    d["error"] = code;
    if (msg) d["message"] = godot::String::utf8(msg.UTF8String);
    pks_log(@"start_failed", @{@"code" : @(code), @"message" : msg ?: @""});
    return d;
  }

 protected:
  static void _bind_methods() {
    godot::ClassDB::bind_method(godot::D_METHOD("start", "mode", "feed_url", "headers", "channels", "log_path"), &PKeySparkleNative::start);
    godot::ClassDB::bind_method(godot::D_METHOD("check_for_updates"), &PKeySparkleNative::check_for_updates);
    godot::ClassDB::bind_method(godot::D_METHOD("check_in_background"), &PKeySparkleNative::check_in_background);
    godot::ClassDB::bind_method(godot::D_METHOD("set_automatically_checks", "on"), &PKeySparkleNative::set_automatically_checks);
    godot::ClassDB::bind_method(godot::D_METHOD("set_automatically_downloads", "on"), &PKeySparkleNative::set_automatically_downloads);
    godot::ClassDB::bind_method(godot::D_METHOD("get_state"), &PKeySparkleNative::get_state);
    godot::ClassDB::bind_static_method("PKeySparkleNative", godot::D_METHOD("bundle_info"), &PKeySparkleNative::bundle_info);
    ADD_SIGNAL(godot::MethodInfo("sparkle_event", godot::PropertyInfo(godot::Variant::STRING, "event"),
                                 godot::PropertyInfo(godot::Variant::DICTIONARY, "detail")));
  }

 public:
  static godot::Dictionary bundle_info() {
    NSBundle *b = NSBundle.mainBundle;
    godot::Dictionary d;
    d["path"] = godot::String::utf8(b.bundlePath.UTF8String);
    d["version"] = to_variant([b objectForInfoDictionaryKey:@"CFBundleVersion"]);
    d["short"] = to_variant([b objectForInfoDictionaryKey:@"CFBundleShortVersionString"]);
    d["SUPublicEDKey"] = to_variant([b objectForInfoDictionaryKey:@"SUPublicEDKey"]);
    d["SUFeedURL"] = to_variant([b objectForInfoDictionaryKey:@"SUFeedURL"]);
    d["sparkle_loaded"] = NSClassFromString(@"SPUUpdater") != nil;
    d["main_thread"] = (bool)[NSThread isMainThread];
    return d;
  }

  godot::Dictionary start(const godot::String &mode, const godot::String &feed_url, const godot::Dictionary &headers,
                          const godot::PackedStringArray &channels, const godot::String &log_path) {
    if (!log_path.is_empty()) {
      g_log_path = ns(log_path);
      g_t0 = CFAbsoluteTimeGetCurrent();
    }
    pks_log(@"start", @{@"mode" : ns(mode), @"feed" : ns(feed_url), @"bundle" : NSBundle.mainBundle.bundlePath,
                        @"version" : [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleVersion"] ?: @""});
    if (![NSThread isMainThread]) return fail("not_main_thread");
    if (NSClassFromString(@"SPUUpdater") == nil) return fail("dependency", @"Sparkle.framework not loaded");
    // The SparkleAnchor rule: no public key, no updater. (Sparkle itself would also refuse.)
    NSString *pub = [NSBundle.mainBundle objectForInfoDictionaryKey:@"SUPublicEDKey"];
    if (![pub isKindOfClass:[NSString class]] || pub.length == 0) return fail("missing_public_key");
    if (controller_ || updater_) return fail("already_started");

    delegate_ = [PKSDelegate new];
    delegate_.feedURL = feed_url.is_empty() ? nil : ns(feed_url);
    NSMutableSet *chs = [NSMutableSet set];
    for (int i = 0; i < channels.size(); i++) [chs addObject:ns(channels[i])];
    delegate_.channels = chs;
    // Events are emitted on the main thread (Sparkle calls delegates there); defer to be safe.
    uint64_t self_id = get_instance_id();
    EmitFn emit = [self_id](NSString *event, NSDictionary *detail) {
      pks_log(event, detail);
      godot::Object *o = godot::ObjectDB::get_instance(self_id);
      if (!o) return;
      o->call_deferred("emit_signal", "sparkle_event", godot::String::utf8(event.UTF8String),
                       detail ? to_variant(detail) : godot::Variant(godot::Dictionary()));
    };
    delegate_.emit = emit;

    NSMutableDictionary *h = [NSMutableDictionary dictionary];
    godot::Array keys = headers.keys();
    for (int i = 0; i < keys.size(); i++) h[ns(keys[i])] = ns(headers[keys[i]]);

    NSError *err = nil;
    if (mode == godot::String("standard")) {
      controller_ = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:NO updaterDelegate:delegate_ userDriverDelegate:nil];
      controller_.updater.httpHeaders = h;
      [controller_ startUpdater];
      updater_ = controller_.updater;
      if (!updater_.canCheckForUpdates) {
        // startUpdater on the controller shows its own alert on error; report state.
        pks_log(@"standard_cannot_check", nil);
      }
    } else {
      driver_ = [PKSAutoDriver new];
      driver_.emit = emit;
      updater_ = [[SPUUpdater alloc] initWithHostBundle:NSBundle.mainBundle applicationBundle:NSBundle.mainBundle userDriver:driver_ delegate:delegate_];
      updater_.httpHeaders = h;
      if (![updater_ startUpdater:&err]) {
        NSDictionary *e = err_dict(err);
        updater_ = nil;
        godot::Dictionary d = fail("start_failed", err.localizedDescription);
        d["detail"] = to_variant(e);
        return d;
      }
    }
    godot::Dictionary ok;
    ok["ok"] = true;
    ok["can_check"] = (bool)updater_.canCheckForUpdates;
    pks_log(@"started", @{@"can_check" : @(updater_.canCheckForUpdates)});
    return ok;
  }

  void check_for_updates() {
    if (controller_) [controller_ checkForUpdates:nil];
    else if (updater_) [updater_ checkForUpdates];
  }
  void check_in_background() {
    if (updater_) [updater_ checkForUpdatesInBackground];
  }
  void set_automatically_checks(bool on) {
    if (updater_) updater_.automaticallyChecksForUpdates = on;
  }
  void set_automatically_downloads(bool on) {
    if (updater_) updater_.automaticallyDownloadsUpdates = on;
  }
  godot::Dictionary get_state() {
    godot::Dictionary d;
    d["started"] = updater_ != nil;
    if (updater_) {
      d["can_check"] = (bool)updater_.canCheckForUpdates;
      d["session"] = (bool)updater_.sessionInProgress;
      d["feed_url"] = to_variant(updater_.feedURL.absoluteString);
      d["auto_checks"] = (bool)updater_.automaticallyChecksForUpdates;
    }
    return d;
  }
};

static void initialize(godot::ModuleInitializationLevel level) {
  if (level != godot::MODULE_INITIALIZATION_LEVEL_SCENE) return;
  GDREGISTER_CLASS(PKeySparkleNative);
}
static void uninitialize(godot::ModuleInitializationLevel level) {}

extern "C" GDExtensionBool GDE_EXPORT pkey_sparkle_init(GDExtensionInterfaceGetProcAddress p_get_proc_address,
                                                         GDExtensionClassLibraryPtr p_library,
                                                         GDExtensionInitialization *r_initialization) {
  godot::GDExtensionBinding::InitObject init_obj(p_get_proc_address, p_library, r_initialization);
  init_obj.register_initializer(initialize);
  init_obj.register_terminator(uninitialize);
  init_obj.set_minimum_library_initialization_level(godot::MODULE_INITIALIZATION_LEVEL_SCENE);
  return init_obj.init();
}
